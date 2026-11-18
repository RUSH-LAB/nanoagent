"""Abstract scenario actions -> concrete tool calls, per harness.

``render(act, tools, harness)`` finds the harness's tools in the request's own tool list (never guessing a
name) and returns what the model reply must contain. It raises :class:`ActionError` when a needed tool is
absent; the server answers that with HTTP 599 and a protocol violation.

``act`` is None (final text only), the string ``"malformed"`` or ``"text_only"``, a one-key mapping
(``{wait: seconds}``, ``{answer: value}``, ``{refuse: reason}``, ``{malformed: true}``) or a list of those
(several tool calls in one turn).
"""

from __future__ import annotations

import json
import shlex
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


class ActionError(Exception):
    pass


@dataclass(frozen=True)
class RenderedCall:
    name: str
    arguments: str  # a JSON text


@dataclass
class Rendered:
    text: str = ""
    tool_calls: list[RenderedCall] = field(default_factory=list)


def find_tool(tools: list[Any], name: str) -> str:
    """The request's tool named ``name``, exactly, else the one tool whose name ends with it (a prefixed MCP name)."""
    names = [tool.name for tool in tools]
    if name in names:
        return name
    suffixed = [n for n in names if n.endswith(name)]
    if len(suffixed) == 1:
        return suffixed[0]
    raise ActionError(f"needs a {name!r} tool, request has {names}" if not suffixed else f"{name!r} is ambiguous among {suffixed}")


def _call(tools: list[Any], name: str, arguments: Any) -> RenderedCall:
    return RenderedCall(find_tool(tools, name), json.dumps(arguments))


def _nanoagent(kind: str, value: Any, tools: list[Any]) -> Rendered:
    """NanoAgent: the plugin's own tools, plus ``submit`` (whose parameters are the task's output schema)."""
    match kind:
        case "wait":
            return Rendered(tool_calls=[_call(tools, "wait", {"wait_seconds": value})])
        case "answer":
            return Rendered(tool_calls=[_call(tools, "submit", value)])
        case "refuse":
            return Rendered(text=str(value))
        case "malformed":
            return Rendered(tool_calls=[_call(tools, "submit", {"malformed": True})])
        case "text_only":
            return Rendered()
        case "decide":
            # The structured answer of a decide task's question batch: the JSON object the request's schema asks for.
            return Rendered(text=json.dumps(value))
    raise ActionError(f"unknown action {kind!r}")


def _codex(kind: str, value: Any, tools: list[Any]) -> Rendered:
    """Codex 0.167: ``exec_command {cmd}`` runs in the workspace (its cwd is the run's workspace, which the prompt names
    as ``{workspace}/answer.json``), so ``answer.json`` is relative."""

    def shell(cmd: str) -> Rendered:
        return Rendered(tool_calls=[_call(tools, "exec_command", {"cmd": cmd})])

    def write(content: str) -> Rendered:
        return shell(f"printf %s {shlex.quote(content)} > answer.json")

    match kind:
        case "wait":
            return shell(f"sleep {value}")
        case "answer":
            return write(json.dumps(value))
        case "refuse":
            return write(json.dumps({"refused": str(value)}))
        case "malformed":
            return write(json.dumps({"malformed": True}))
        case "text_only":
            return Rendered()
    raise ActionError(f"unknown action {kind!r}")


def _bash(extra: dict[str, str], tool: str = "bash") -> Callable[[str, Any, list[Any]], Rendered]:
    """PI and dsh: ``bash {command}`` (dsh also requires a ``description``) runs in the workspace (the runner's cwd,
    which the prompt names as ``{workspace}/answer.json``), so ``answer.json`` is relative."""

    def render_one(kind: str, value: Any, tools: list[Any]) -> Rendered:
        def shell(command: str) -> Rendered:
            return Rendered(tool_calls=[_call(tools, tool, {**extra, "command": command})])

        def write(content: str) -> Rendered:
            return shell(f"printf %s {shlex.quote(content)} > answer.json")

        match kind:
            case "wait":
                return shell(f"sleep {value}")
            case "answer":
                return write(json.dumps(value))
            case "refuse":
                return write(json.dumps({"refused": str(value)}))
            case "malformed":
                return write(json.dumps({"malformed": True}))
            case "text_only":
                return Rendered()
        raise ActionError(f"unknown action {kind!r}")

    return render_one


def _probe(kind: str, value: Any, tools: list[Any]) -> Rendered:
    """The scripted uploaded-harness probe: ``{call: {name, arguments}}`` is a call to any tool the request lists, with exactly those arguments."""
    match kind:
        case "call":
            return Rendered(tool_calls=[_call(tools, value["name"], value["arguments"])])
        case "text_only":
            return Rendered()
    raise ActionError(f"unknown action {kind!r}")


# Per-harness renderers: (kind, value, request tools) -> Rendered. Later agents add the shell-tool harnesses
# here: claude (Bash), codex (shell / exec_command), pi (bash), dsh (terminal): wait -> `sleep s`,
# answer -> write answer.json, refuse -> write {"refused": why}, malformed -> the same schema-invalid object NanoAgent submits.
HARNESS_RENDERERS: dict[str, Callable[[str, Any, list[Any]], Rendered]] = {
    "nanoagent": _nanoagent,
    "probe": _probe,
    "pi": _bash({}),
    "dsh": _bash({"description": "Run the step"}),
    "claude": _bash({}, "Bash"),
    "codex": _codex,
}


def _actions(act: Any) -> list[tuple[str, Any]]:
    if act is None:
        return [("text_only", None)]
    if isinstance(act, str):
        return [(act, None)]
    if isinstance(act, list):
        return [pair for item in act for pair in _actions(item)]
    if isinstance(act, dict) and len(act) == 1:
        [(kind, value)] = act.items()
        return [(kind, value)]
    raise ActionError(f"an action is None, a word, a one-key mapping or a list of those, not {act!r}")


def render(act: Any, tools: list[Any], harness: str) -> Rendered:
    renderer = HARNESS_RENDERERS.get(harness)
    if renderer is None:
        raise ActionError(f"no action renderer for harness {harness!r} yet")
    out = Rendered()
    for kind, value in _actions(act):
        one = renderer(kind, value, tools)
        out.text = "\n".join(part for part in (out.text, one.text) if part)
        out.tool_calls.extend(one.tool_calls)
    return out
