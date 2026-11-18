"""The hosted tool broker (`POST /tools`, and `/mcp` for MCP clients) and the plugin-backed [ToolRunner] behind it."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Protocol

import anyio
from jsonschema import Draft202012Validator
from jsonschema.exceptions import best_match
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from nanoagent import __version__
from nanoagent.plugin.manifest import PluginManifest
from nanoagent.plugin.runtime import PluginLauncher, PluginSession
from nanoagent.uploaded.attempt import CALL_HEADER, Attempt, ServiceError, ToolPolicy, error_response, from_contract, new_call_id
from nanoagent.uploaded.contract import _FORMATS, ContractError, decode_and_validate, validate
from nanoagent.uploaded.evidence import json_bytes
from nanoagent.uploaded.gateway import ProposalRegistry


# The MCP revisions `/mcp` answers in: the client's when it asks for one of these, else the latest.
MCP_VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25")


def _rpc_error(rpc_id: Any, code: int, message: str, status: int = 200) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}}, status_code=status)


class ToolError(Exception):
    """A tool failed; `code` and `message` go to the harness in the error envelope."""

    def __init__(self, code: str, message: str, status: int = 422) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status = status


class ToolRunner(Protocol):
    async def run(self, name: str, arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
        """Run the named tool in ``workspace`` and return its output; raises [ToolError]."""


class WorkspaceLock:
    """Readers share the workspace; a writer has it alone. Waiting writers hold off new readers."""

    def __init__(self) -> None:
        self._condition = anyio.Condition()
        self._readers = 0
        self._writer = False
        self._waiting_writers = 0

    @asynccontextmanager
    async def read(self) -> AsyncIterator[None]:
        async with self._condition:
            while self._writer or self._waiting_writers:
                await self._condition.wait()
            self._readers += 1
        try:
            yield
        finally:
            with anyio.CancelScope(shield=True):
                async with self._condition:
                    self._readers -= 1
                    self._condition.notify_all()

    @asynccontextmanager
    async def write(self) -> AsyncIterator[None]:
        async with self._condition:
            self._waiting_writers += 1
            try:
                while self._writer or self._readers:
                    await self._condition.wait()
            finally:
                self._waiting_writers -= 1
            self._writer = True
        try:
            yield
        finally:
            with anyio.CancelScope(shield=True):
                async with self._condition:
                    self._writer = False
                    self._condition.notify_all()


def canonical(value: Any) -> Any:
    """Typed canonical form for comparing arguments: an integral float equals the integer."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in value.items()}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


def _validator(schema: Mapping[str, Any]) -> Draft202012Validator:
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=_FORMATS)


def _schema_problem(validator: Draft202012Validator, value: Any) -> str | None:
    error = best_match(validator.iter_errors(value))
    return None if error is None else "".join(f"/{part}" for part in error.absolute_path) + f": {error.message}"


class ToolBroker:
    def __init__(self, attempt: Attempt, runner: ToolRunner, registry: ProposalRegistry, *, proposal_wait_s: float = 30.0) -> None:
        self.attempt = attempt
        self.runner = runner
        self.registry = registry
        self.proposal_wait_s = proposal_wait_s
        self._lock = WorkspaceLock()
        self._validators = {tool.name: (_validator(tool.input_schema), _validator(tool.output_schema)) for tool in attempt.policy.tools}

    async def handle(self, request: Request) -> Response:
        """`POST /tools`: one ToolCall, answered with its ToolResult."""

        async def read() -> dict[str, Any]:
            try:
                return decode_and_validate("ToolCall", await self.attempt.read_body(request), self.attempt.policy.max_request_bytes)
            except ContractError as error:
                raise from_contract(error) from error

        return await self._call(request, read)

    async def mcp(self, request: Request) -> Response:
        """`/mcp`: the attempt's tools as an MCP server (Streamable HTTP, stateless, each answer one JSON body), for an agent CLI
        in the RUSH terminal. A `tools/call` is a call to this broker, admitted, validated and recorded as a `POST /tools` is."""
        if request.method != "POST":
            return Response(status_code=405, headers={"Allow": "POST"})  # no server-initiated stream, no session to end
        try:
            self.attempt.require_auth(request)
            body = await self.attempt.read_body(request)
        except ServiceError as error:
            return error_response(error)
        try:
            message = json.loads(body)
        except ValueError:
            return _rpc_error(None, -32700, "the body is not JSON", 400)
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            return _rpc_error(message.get("id") if isinstance(message, dict) else None, -32600, "not a JSON-RPC 2.0 request", 400)
        if "id" not in message:
            return Response(status_code=202)  # a notification: nothing to answer
        rpc_id, method, params = message["id"], message["method"], message.get("params", {})
        if not isinstance(params, dict):
            return _rpc_error(rpc_id, -32602, "params must be an object")
        if method == "initialize":
            asked = params.get("protocolVersion")
            version = asked if asked in MCP_VERSIONS else MCP_VERSIONS[-1]
            result: dict[str, Any] = {"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": "rush", "version": __version__}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {
                "tools": [
                    {"name": tool.name, "description": tool.description, "inputSchema": tool.input_schema, "outputSchema": tool.output_schema}
                    for tool in self.attempt.policy.tools
                ]
            }
        elif method == "tools/call":
            call = {"name": params.get("name"), "arguments": params.get("arguments", {})}

            async def read() -> dict[str, Any]:
                try:
                    validate("ToolCall", call)
                except ContractError as error:
                    raise from_contract(error) from error
                return call

            envelope = json.loads((await self._call(request, read)).body)
            if "output" in envelope:
                result = {"content": [{"type": "text", "text": json.dumps(envelope["output"])}], "structuredContent": envelope["output"]}
            else:
                result = {"content": [{"type": "text", "text": f"{envelope['error']['code']}: {envelope['error']['message']}"}], "isError": True}
        else:
            return _rpc_error(rpc_id, -32601, f"no method {method!r}")
        return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "result": result})

    async def _call(self, request: Request, read: Callable[[], Awaitable[dict[str, Any]]]) -> Response:
        call_id, context = new_call_id(), {"span_id": None, "tool": None, "cause": None}
        received_ns = self.attempt.clock_ns()  # the harness's call starts here, before verification and journaling queue it
        try:
            self.attempt.require_auth(request)
            context["span_id"] = self.attempt.span_id(request)
            self.attempt.require_active()
            call = await read()
            context["tool"], context["cause"] = call["name"], call.get("cause")
            return await self._run(call_id, call, context["span_id"], received_ns)
        except ServiceError as error:
            await self.attempt.recorder.record(
                "tool_broker", "tool.rejected", {"call_id": call_id, "code": error.code, "message": error.message, "http_status": error.status, **context}
            )
            return self._envelope_error(error, call_id)

    @staticmethod
    def _envelope_error(error: ServiceError, call_id: str) -> Response:
        response = error_response(error, call_id)
        validate("ToolResult", json.loads(response.body))
        return response

    async def _verify_cause(self, call: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        """The adaptation record when the actual arguments differ from the proposal, after verifying the link."""
        cause = call.get("cause")
        if cause is None:
            return None, None
        proposal = await self.registry.lookup(cause["model_call_id"], cause["tool_call_id"], self.proposal_wait_s)
        if proposal is None:
            raise ServiceError(409, "unknown_proposal", f"no proposal {cause['tool_call_id']!r} in model call {cause['model_call_id']!r} of this attempt")
        if proposal.name != call["name"]:
            raise ServiceError(409, "tool_mismatch", f"the model proposed {proposal.name!r}, the call is for {call['name']!r}")
        same = proposal.arguments is not None and canonical(proposal.arguments) == canonical(call["arguments"])
        link = {"model_call_id": cause["model_call_id"], "tool_call_id": cause["tool_call_id"]}
        if same:
            return link, None
        return link, {
            **link,
            "proposal_arguments": proposal.arguments,
            "proposal_raw_arguments": proposal.raw_arguments,
            "proposal_arguments_error": proposal.arguments_error,
            "actual_arguments": call["arguments"],
        }

    async def _run(self, call_id: str, call: dict[str, Any], span_id: str | None, received_ns: int) -> Response:
        name, arguments = call["name"], call["arguments"]
        tool: ToolPolicy | None = self.attempt.policy.tool(name)
        if tool is None:
            raise ServiceError(403, "tool_not_available", f"{name!r} is not an available tool for this attempt")
        link, adaptation = await self._verify_cause(call)
        input_validator, output_validator = self._validators[name]
        if problem := _schema_problem(input_validator, arguments):
            raise ServiceError(400, "invalid_arguments", f"arguments violate the input schema at {problem}")
        recorder = self.attempt.recorder
        arguments_sha = await recorder.payload(json_bytes(arguments))
        await recorder.record(
            "tool_broker",
            "tool.invoked",
            {
                "call_id": call_id,
                "tool": name,
                "writes": tool.writes,
                "span_id": span_id,
                "cause": link,
                "adapted": adaptation is not None,
                "adaptation": adaptation,
                "arguments_sha256": arguments_sha,
                "received_ns": received_ns,
            },
            [arguments_sha],
        )
        started = self.attempt.clock_ns()
        failure: ServiceError | None = None
        output: dict[str, Any] | None = None
        with self.attempt.tracked() as scope:
            try:
                async with self._lock.write() if tool.writes else self._lock.read():
                    output = await self.runner.run(name, arguments, self.attempt.workspace)
            except ToolError as error:
                failure = ServiceError(error.status, error.code, error.message)
        if scope.cancelled_caught:
            failure = ServiceError(403, "revoked", "the attempt's service admission was revoked while the tool ran")
        if failure is None and output is not None and (problem := _schema_problem(output_validator, output)):
            failure = ServiceError(502, "invalid_output", f"tool output violates the output schema at {problem}")
        duration = self.attempt.clock_ns() - started
        if failure is not None or output is None:
            failure = failure or ServiceError(500, "tool_failed", "the tool returned nothing")
            await recorder.record("tool_broker", "tool.completed", {"call_id": call_id, "tool": name, "ok": False, "duration_ns": duration, "error": {"code": failure.code, "message": failure.message}})
            return self._envelope_error(failure, call_id)
        output_sha = await recorder.payload(json_bytes(output))
        await recorder.record("tool_broker", "tool.completed", {"call_id": call_id, "tool": name, "ok": True, "duration_ns": duration, "output_sha256": output_sha}, [output_sha])
        envelope = {"output": output}
        validate("ToolResult", envelope)
        return JSONResponse(envelope, headers={CALL_HEADER: call_id})


class PluginToolRunner:
    """Runs the permitted tools of one plugin through a [PluginSession] confined to the case workspace.

    The session starts the plugin with only the plugin's own folder, the workspace, the read-only ``fixtures`` folder if
    given, and with only the environment
    variables ``allowed_env`` names: no request, result or private reference files are mounted and no ambient credentials
    pass through. With a ``launcher`` the plugin runs in the case's own tool container (see
    [nanoagent.uploaded.sandbox.ToolLauncher]) and ``workspace`` is the path both sandboxes see. Reference tools are
    refused at construction and at call time. Use it as ``async with`` in the task that serves the attempt (the
    session's process scope is task-bound).
    """

    def __init__(
        self,
        manifest: PluginManifest,
        workspace: Path,
        permitted: tuple[str, ...],
        *,
        allowed_env: frozenset[str] = frozenset(),
        fixtures: Path | None = None,
        timeout: float = 300,
        launcher: PluginLauncher | None = None,
    ) -> None:
        references = {task.reference for task in manifest.tasks if task.reference}
        private = sorted(set(permitted) & references)
        if private:
            raise ValueError(f"{manifest.id}: reference tools {private} run privately and cannot be permitted to a harness")
        unknown = sorted(set(permitted) - {tool.name for tool in manifest.tools})
        if unknown:
            raise ValueError(f"{manifest.id} has no tools {unknown}")
        ungranted = sorted(set(manifest.env) - allowed_env)
        if ungranted:
            raise ValueError(f"{manifest.id} declares environment variables {ungranted} that the attempt's tool policy does not grant")
        self._permitted = frozenset(permitted)
        self._session = PluginSession(manifest, workspace, timeout=timeout, fixtures=fixtures, launcher=launcher)

    async def __aenter__(self) -> PluginToolRunner:
        await self._session.__aenter__()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self._session.__aexit__(*exc)

    async def run(self, name: str, arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
        if name not in self._permitted:
            raise ToolError("tool_not_available", f"{name!r} is not a permitted tool", 403)
        if workspace != self._session.workspace:
            raise ToolError("workspace_mismatch", "the runner serves a different workspace", 500)
        try:
            return await self._session.call(name, arguments)
        except TimeoutError as error:
            raise ToolError("tool_timeout", f"{name} exceeded {self._session.timeout} s") from error
        except ValueError as error:
            raise ToolError("invalid_arguments", str(error), 400) from error
        except RuntimeError as error:
            raise ToolError("tool_failed", str(error)) from error
