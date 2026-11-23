"""The validation rules of RUSH's benchmark API, ported to Python for the fakes (fake_rush.FakeRush, runner_fakes.FakeRush): a body the
real server refuses with 400 `invalid_request` is refused here, so a test cannot pass on a body the server would not take. Each function
cites its source in helpinghands/src/server/benchmark/validate.js (and limits.js); test_rush_server_smoke.py posts the same bodies to the
real server, so a drift between this port and the JS shows there.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from typing import Any

SHA256 = re.compile(r"^[0-9a-f]{64}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")  # http.js:6
BENCHMARK_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")  # validate.js:16
RUSH_COMMAND = re.compile(r"^rush ([a-z0-9][a-z0-9._-]{0,63})$")  # harness.js
AGENTS = ("claude", "codex", "dsh", "hermes", "nanoagent", "pi")  # harness.js
TASK_KINDS = ("agent", "decide", "tool")  # validate.js:17
CASE_KINDS = ("answer", "refuse")  # validate.js:18
CASE_FIELDS = ("case_id", "kind", "prompt", "arguments", "fixtures", "expected_error")  # validate.js:154
REMOVED_FIELDS = ("context", "coding_template", "task_instructions")  # validate.js:197
PINNED_FIELDS = ("model", "endpoint_profile")  # validate.js PINNED_FIELDS
VERDICTS = ("pass", "fail")  # validate.js:21
EXPLANATIONS = ("invalid_answer", "refused_answer_case", "answered_refusal_case", "execution_failed")  # validate.js:23
EXECUTION_STATUSES = ("answered", "refused", "execution_failed", "canceled", "ended", "worker_error")  # validate.js:25
CHECK_STATUSES = ("passed", "failed", "skipped")  # validate.js:27
SCORABLE = ("answered", "refused", "execution_failed")  # validate.js:33
MAX_CHECKS = 100  # validate.js:28
MAX_FIXTURES_BYTES = 8 * 1024 * 1024  # validate.js:30
MAX_PROMPT_CHARS = 1_000_000  # validate.js:31
MAX_RESULT_BYTES = 64 * 1024  # limits.js:109
CLI_COMMAND = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")  # validate.js:342
CONVERSATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$")  # validate.js:343
BASE64_TEXT = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")  # validate.js:122
# limits.js:11-32: name -> (integer, min, max)
NUMBER_LIMITS: dict[str, tuple[bool, float, float | None]] = {
    "wall_time_ms": (True, 1, None), "max_model_calls": (True, 0, 10_000), "max_output_tokens_per_call": (True, 1, None), "max_cost_usd": (False, 0, None),
    "cpus": (False, 5e-324, None), "memory_mb": (True, 1, None), "pids": (True, 1, None), "workspace_bytes": (True, 1, None),
    "workspace_files": (True, 1, None), "tmp_bytes": (True, 1, None), "build_wall_ms": (True, 1, None), "build_memory_mb": (True, 1, None),
    "build_output_bytes": (True, 1, None), "build_files": (True, 1, None), "build_tmp_bytes": (True, 1, None),
}  # fmt: skip
LIMIT_FIELDS = (*NUMBER_LIMITS, "internet_access")


class Invalid(Exception):
    """What the server answers as `400 invalid_request` (or the code it names)."""

    def __init__(self, message: str, code: str = "invalid_request") -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _object(value: Any, what: str) -> dict[str, Any]:  # validate.js:37
    if not isinstance(value, dict):
        raise Invalid(f"{what} must be an object")
    return value


def _string(value: Any, what: str, *, max: int = 200, optional: bool = False) -> str | None:  # validate.js:41
    if optional and value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > max:
        raise Invalid(f"{what} must be a string of 1 to {max} characters")
    return value


def _integer(value: Any, what: str, *, min: int = 0, max: int = 2**53 - 1) -> int:  # validate.js:46
    if isinstance(value, bool) or not isinstance(value, int) or not min <= value <= max:
        raise Invalid(f"{what} must be an integer from {min} to {max}")
    return value


def _array(value: Any, what: str, *, max: int = 1000, optional: bool = False) -> list[Any]:  # validate.js:63
    if optional and value is None:
        return []
    if not isinstance(value, list) or len(value) > max:
        raise Invalid(f"{what} must be an array of at most {max}")
    return value


def _boolean(value: Any, what: str) -> bool:  # validate.js:79
    if not isinstance(value, bool):
        raise Invalid(f"{what} must be a boolean")
    return value


def _sha256(value: Any, what: str) -> str:  # validate.js:68
    if not isinstance(value, str) or not SHA256.match(value):
        raise Invalid(f"{what} must be a lowercase SHA-256 hex digest")
    return value


def _bounded(value: Any, what: str, max: int) -> dict[str, Any]:  # validate.js:56
    if len(json.dumps(_object(value, what), separators=(",", ":"), ensure_ascii=False).encode()) > max:
        raise Invalid(f"{what} may be {max} bytes at most", "too_large")
    return value


def _only(body: Any, keys: tuple[str, ...]) -> None:  # validate.js:238
    _object(body, "The body")
    extra = next((key for key in body if key not in keys), None)
    if extra:
        raise Invalid(f"{extra} is not a field of this request; it takes {', '.join(keys)}")


def _limit(name: str, value: Any) -> None:  # limits.js:53
    if name == "internet_access":
        if not isinstance(value, bool):
            raise Invalid("limits.internet_access must be a boolean")
        return
    integer, low, high = NUMBER_LIMITS[name]
    number = isinstance(value, (int, float)) and not isinstance(value, bool)
    if not (number and low <= value <= (high if high is not None else float("inf")) and (not integer or float(value).is_integer())):
        raise Invalid(f"limits.{name} must be {'an integer' if integer else 'a number'} of at least {low}")


def _limits(value: Any) -> None:  # limits.js:65
    if value is None:
        return
    if not isinstance(value, dict):
        raise Invalid("limits must be an object")
    if "concurrency" in value:
        raise Invalid("limits.concurrency is not a limit")
    unknown = next((name for name in value if name not in LIMIT_FIELDS), None)
    if unknown:
        raise Invalid(f"limits.{unknown} is not a limit; the limits are {', '.join(LIMIT_FIELDS)}")
    for name, item in value.items():
        if item is not None:  # a null field takes its default
            _limit(name, item)


def _task(value: Any) -> None:  # validate.js:85
    task = _object(value, "task")
    if task.get("kind") not in TASK_KINDS:
        raise Invalid(f"task.kind must be one of {', '.join(TASK_KINDS)}")
    if "instructions" in task:
        raise Invalid("task.instructions is no longer a field of a publication: the prompt of each case says everything its harness is told")
    hosts = [_string(host, "an egress host", max=253) for host in _array(task.get("egress_hosts"), "task.egress_hosts", max=200)]
    if any(index > 0 and hosts[index - 1] >= host for index, host in enumerate(hosts)):
        raise Invalid("task.egress_hosts must be sorted, without repeats")
    _string(task.get("description"), "task.description", max=10_000)
    _object(task.get("input_schema"), "task.input_schema")
    _object(task.get("output_schema"), "task.output_schema")
    names: set[str] = set()
    for raw in _array(task.get("tools"), "task.tools", max=200):
        tool = _object(raw, "A task tool")
        name = _string(tool.get("name"), "a tool name")
        if name in names:
            raise Invalid(f"task.tools lists {name} twice")
        names.add(name)
        _object(tool.get("input_schema"), f"Tool {name}'s input_schema")
        _object(tool.get("output_schema"), f"Tool {name}'s output_schema")
        _boolean(tool.get("writes"), f"Tool {name}'s writes")


def _fixtures(value: Any, case_id: str) -> None:  # validate.js:130
    if value is None:
        return
    what = f"Case {case_id}'s fixtures"
    if not isinstance(value, dict):
        raise Invalid(f"{what} must be an object or null")
    extra = next((key for key in value if key not in ("sha256", "files", "archive")), None)
    if extra:
        raise Invalid(f"{what} has {extra}, which is no field of it; it takes sha256, files, archive")
    digest = _sha256(value.get("sha256"), f"{what}'s sha256")
    for path, file_digest in _object(value.get("files"), f"{what}'s files").items():  # validate.js:121 fixturePath
        parts = path.split("/")
        if not path or len(path) > 1024 or "\0" in path or "\\" in path or path.startswith("/") or any(part in ("", ".", "..") for part in parts):
            raise Invalid(f'{what}\'s file path {json.dumps(path)} must be a relative POSIX path with no empty, "." or ".." part')
        _sha256(file_digest, f"{what}'s digest of {path}")
    archive = value.get("archive")
    if not isinstance(archive, str) or len(archive) % 4 != 0 or not BASE64_TEXT.match(archive):
        raise Invalid(f"{what}'s archive must be the .tar.gz as base64")
    try:
        data = base64.b64decode(archive, validate=True)
    except binascii.Error as error:
        raise Invalid(f"{what}'s archive must be the .tar.gz as base64") from error
    if len(data) > MAX_FIXTURES_BYTES:
        raise Invalid(f"{what} may be {MAX_FIXTURES_BYTES} bytes at most", "fixtures_too_large")
    if not data:
        raise Invalid(f"{what}'s archive is empty")
    if hashlib.sha256(data).hexdigest() != digest:
        raise Invalid(f"{what}'s archive does not hash to its sha256")


def _case(raw: Any, reference: Any) -> None:  # validate.js:160 pinnedCase
    case = _object(raw, "A case")
    case_id = _string(case.get("case_id"), "case_id")
    extra = next((key for key in case if key not in CASE_FIELDS), None)
    if extra:
        raise Invalid(f"Case {case_id} has {extra}, which is no field of a case; it takes {', '.join(CASE_FIELDS)}")
    if case.get("kind") not in CASE_KINDS:
        raise Invalid(f"Case {case_id}'s kind must be one of {', '.join(CASE_KINDS)}")
    prompt = case.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS or "\0" in prompt:
        raise Invalid(f"Case {case_id}'s prompt must be a string of 1 to {MAX_PROMPT_CHARS} characters, not blank")
    if prompt != prompt.strip():
        raise Invalid(f"Case {case_id}'s prompt must not start or end with whitespace")
    _object(case.get("arguments"), f"Case {case_id}'s arguments")
    if "fixtures" not in case:
        raise Invalid(f"Case {case_id}'s fixtures must be an object or null")
    _fixtures(case["fixtures"], case_id)
    if case["kind"] == "refuse":
        _string(case.get("expected_error"), f"Case {case_id}'s expected_error", max=10_000)
        if not isinstance(reference, str):
            raise Invalid(f"private's reference for refusal case {case_id} must be the pinned error string")
    else:
        if case.get("expected_error") is not None:
            raise Invalid(f"Case {case_id} is an answer case and takes no expected_error")
        if reference is not None and not isinstance(reference, dict):
            raise Invalid(f"private's reference for answer case {case_id} must be an object, or null for a task judged without one")


def check_publication(body: Any) -> None:  # validate.js:193 benchmarkPublication and :221 publicationFrame
    _object(body, "The body")
    removed = next((field for field in REMOVED_FIELDS if field in body), None)
    if removed:
        raise Invalid(f"{removed} is no longer a field of a publication: the prompt of each case says everything its harness is told")
    pinned = next((field for field in PINNED_FIELDS if field in body), None)
    if pinned:
        raise Invalid(f"{pinned} is not a field of a publication: every benchmark runs on the server's one model through its one endpoint")
    name = _string(body.get("name"), "name", max=128)
    if not BENCHMARK_NAME.match(name):
        raise Invalid('name is lowercase letters, digits, ".", "_" and "-"')
    _task(body.get("task"))
    _string(body.get("plugin_id"), "plugin_id")
    _string(body.get("plugin_name"), "plugin_name")
    _string(body.get("version"), "version", max=64)
    _sha256(body.get("package_sha256"), "package_sha256")
    _string(body.get("task_id"), "task_id")
    _limits(body.get("limits"))
    cases = _array(body.get("cases"), "cases", max=5000)
    if not cases:
        raise Invalid("A benchmark needs at least one case")
    references = _object(body.get("private"), "private")
    seen: set[str] = set()
    for raw in cases:
        case_id = _string(_object(raw, "A case").get("case_id"), "case_id")
        if case_id in seen:
            raise Invalid(f"case_id {case_id} appears twice")
        seen.add(case_id)
        if case_id not in references:
            raise Invalid(f"private has no reference for case {case_id}")
        _case(raw, references[case_id])
    extra = next((case_id for case_id in references if case_id not in seen), None)
    if extra:
        raise Invalid(f"private has a reference for {extra}, which is no case")


def check_run(body: Any) -> None:  # validate.js:253 runBody, harness.js checkHarness
    _only(body, ("benchmark_id", "harness", "idempotency_key"))
    if not isinstance(body.get("benchmark_id"), str) or not UUID.match(body["benchmark_id"]):
        raise Invalid("benchmark_id must be a UUID")
    harness = body.get("harness")
    if not isinstance(harness, str) or not (harness in AGENTS or RUSH_COMMAND.match(harness)):
        raise Invalid(f"harness must be one of {', '.join(AGENTS)}, or rush <command> for your own agent", "unknown_harness")
    _string(body.get("idempotency_key"), "idempotency_key")


def _chat(value: Any) -> None:  # validate.js:346 chatOf
    chat = _object(value, "a chat")
    if not isinstance(chat.get("agent"), str) or not CLI_COMMAND.match(chat["agent"]):
        raise Invalid("a chat's agent must be a CLI command")
    if not isinstance(chat.get("id"), str) or not CONVERSATION_ID.match(chat["id"]):
        raise Invalid("a chat's id must be its CLI's conversation id")
    _string(chat.get("title"), "a chat's title", max=200)
    for what in ("started_at", "ended_at"):
        text = _string(chat.get(what), f"a chat's {what}", max=40)
        if not re.match(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$", text):
            raise Invalid(f"a chat's {what} must be an ISO 8601 time")
    for what in ("started_ns", "ended_ns"):
        value = chat.get(what)
        # benchmark-context.js:68 nanoseconds: a safe integer, or a string of up to 19 digits (negative allowed) within bigint
        if isinstance(value, bool) or not (isinstance(value, int) or (isinstance(value, str) and re.match(r"^-?\d{1,19}$", value) and -(2**63) <= int(value) < 2**63)):
            raise Invalid(f"a chat's {what} must be a decimal integer string or a safe integer")


def _workspace(workspace: Any) -> None:  # validate.js:365 workspaceOf
    _object(workspace, "workspace")
    if "error" in workspace:
        _string(workspace["error"], "workspace.error", max=500)
        return
    _sha256(workspace.get("sha256"), "workspace.sha256")
    _integer(workspace.get("bytes"), "workspace.bytes", min=1)
    for chunk in _array(workspace.get("chunks"), "workspace.chunks", max=1000):
        _sha256(chunk, "A workspace chunk")


def check_finalize(body: Any) -> None:  # validate.js:374 finalizeBody
    _object(body, "The body")
    execution = _object(body.get("execution"), "execution")
    if execution.get("status") not in EXECUTION_STATUSES:
        raise Invalid(f"execution.status is one of {', '.join(EXECUTION_STATUSES)}")
    verdict = _string(body.get("verdict"), "verdict", optional=True, max=100)
    if verdict is not None and verdict not in VERDICTS:
        raise Invalid(f"verdict is one of {', '.join(VERDICTS)}")
    explanation = _string(body.get("explanation"), "explanation", optional=True, max=100)
    if explanation is not None and explanation not in EXPLANATIONS:
        raise Invalid(f"explanation is one of {', '.join(EXPLANATIONS)}")
    if explanation is not None and verdict != "fail":
        raise Invalid("An explanation comes only with a fail verdict")
    verifier_error = _string(body.get("verifier_error"), "verifier_error", optional=True, max=4000)
    if verdict is not None and verifier_error is not None:
        raise Invalid("Send a verdict or a verifier_error, not both")
    if verdict is not None and execution["status"] not in SCORABLE:
        raise Invalid(f"A {execution['status']} attempt carries no verdict", "verdict_not_allowed")
    if verifier_error is not None and execution["status"] not in ("answered", "refused"):
        raise Invalid(f"A {execution['status']} attempt reached no verifier", "verdict_not_allowed")
    _string(execution.get("reason"), "execution.reason", optional=True, max=200)
    # checks: absent is none; a null is not an array (validate.js:395), so the worker leaves the key out
    if "checks" in body:
        for raw in _array(body["checks"], "checks", max=MAX_CHECKS):
            check = _object(raw, "A check")
            extra = next((key for key in check if key not in ("name", "status")), None)
            if extra:
                raise Invalid(f"A check has {extra}, which is no field of it; it takes name, status")
            if check.get("status") not in CHECK_STATUSES:
                raise Invalid(f"A check's status is one of {', '.join(CHECK_STATUSES)}")
            _string(check.get("name"), "a check's name", max=200)
        if verdict is None:
            raise Invalid("checks come only with a verdict")
    if "resumable" in body and not isinstance(body["resumable"], bool):
        raise Invalid("resumable must be a boolean")
    if "chats" in body:  # validate.js:403: a null is not an array
        for chat in _array(body["chats"], "chats", max=500):
            _chat(chat)
    for attempt_id in _array(body.get("evicted"), "evicted", optional=True, max=10_000):
        if not isinstance(attempt_id, str) or not UUID.match(attempt_id):
            raise Invalid("evicted holds attempt ids")
    _integer(body.get("fence"), "fence", min=1)
    _bounded(body.get("coverage"), "coverage", MAX_RESULT_BYTES)
    _bounded(body.get("metrics"), "metrics", MAX_RESULT_BYTES)
    _integer(body.get("final_cursor_expected"), "final_cursor_expected")
    if "workspace" in body:
        _workspace(body["workspace"])
