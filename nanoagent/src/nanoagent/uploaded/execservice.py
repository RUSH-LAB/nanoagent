"""The managed command service (`POST /exec`)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Protocol

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from nanoagent.uploaded.attempt import CALL_HEADER, Attempt, ServiceError, from_contract, new_call_id, tool_error_response
from nanoagent.uploaded.contract import ContractError, decode_and_validate, path_problem, validate, validate_argv


class ExecError(Exception):
    """A launch or admission failure from the runner; goes to the harness in the tool error envelope."""

    def __init__(self, code: str, message: str, status: int = 500) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status = status


class CommandRunner(Protocol):
    async def exec(self, argv: Sequence[str], cwd: str, timeout_ms: int, span_id: str | None) -> tuple[dict[str, Any], str]:
        """Run ``argv`` directly in the harness sandbox from workspace-relative ``cwd`` (`.` is the root).

        Returns the `ExecResult` and the supervisor's launch ID; raises [ExecError].
        """


class ExecService:
    def __init__(self, attempt: Attempt, runner: CommandRunner) -> None:
        self.attempt = attempt
        self.runner = runner

    async def handle(self, request: Request) -> Response:
        request_id, span_id = new_call_id(), None
        try:
            self.attempt.require_auth(request)
            span_id = self.attempt.span_id(request)
            self.attempt.require_active()
            try:
                call = decode_and_validate("ExecCall", await self.attempt.read_body(request), self.attempt.policy.max_request_bytes)
                validate_argv(call["argv"])
                # Existence and links are checked against the real case workspace by the runner that launches the command.
                if call["cwd"] != "." and (problem := path_problem(call["cwd"])) is not None:
                    raise ContractError("invalid_cwd", f"{call['cwd']!r} is not a canonical relative path: {problem}")
            except ContractError as error:
                raise from_contract(error) from error
            return await self._run(request_id, call, span_id)
        except ServiceError as error:
            await self.attempt.recorder.record("exec", "exec.rejected", {"request_id": request_id, "code": error.code, "message": error.message, "http_status": error.status, "span_id": span_id})
            return tool_error_response(error, request_id)

    async def _run(self, request_id: str, call: dict[str, Any], span_id: str | None) -> Response:
        recorder = self.attempt.recorder
        command_sha = await recorder.json_payload({"argv": call["argv"], "cwd": call["cwd"]})
        await recorder.record("exec", "exec.started", {"request_id": request_id, "span_id": span_id, "cwd": call["cwd"], "timeout_ms": call["timeout_ms"], "command_sha256": command_sha}, [command_sha])
        started = self.attempt.clock_ns()
        failure: ServiceError | None = None
        result: dict[str, Any] | None = None
        launch_id: str | None = None
        with self.attempt.tracked() as scope:
            try:
                result, launch_id = await self.runner.exec(call["argv"], call["cwd"], call["timeout_ms"], span_id)
            except ExecError as error:
                failure = ServiceError(error.status, error.code, error.message)
        if scope.cancelled_caught:
            failure = ServiceError(403, "revoked", "the attempt's service admission was revoked while the command ran")
        if failure is None and result is not None:
            try:
                validate("ExecResult", result)
            except ContractError as error:
                failure = ServiceError(502, "invalid_exec_result", error.message)
        duration = self.attempt.clock_ns() - started
        if failure is not None or result is None:
            failure = failure or ServiceError(500, "exec_failed", "the runner returned nothing")
            await recorder.record("exec", "exec.completed", {"request_id": request_id, "launch_id": launch_id, "ok": False, "duration_ns": duration, "error": {"code": failure.code, "message": failure.message}})
            return tool_error_response(failure, launch_id or request_id)
        stdout_sha = await recorder.json_payload(result["stdout"])
        stderr_sha = await recorder.json_payload(result["stderr"])
        await recorder.record(
            "exec",
            "exec.completed",
            {
                "request_id": request_id,
                "launch_id": launch_id,
                "ok": True,
                "duration_ns": duration,
                "span_id": span_id,
                "termination": result["termination"],
                "stdout_sha256": stdout_sha,
                "stderr_sha256": stderr_sha,
                "stdout_truncated": result["stdout"]["truncated"],
                "stderr_truncated": result["stderr"]["truncated"],
            },
            [stdout_sha, stderr_sha],
        )
        return JSONResponse(result, headers={CALL_HEADER: launch_id})
