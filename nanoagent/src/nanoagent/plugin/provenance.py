"""An agent run as a provenance graph: what each call used and generated, and where each value came from.

The graph has two kinds of node, as in W3C PROV: *values* (entities), data, and *calls*
(activities), what made them. Each node's ``type`` (:class:`NodeType`) says which it is, starting
from the messages of NanoAgent's loop, whose transcript is chat messages of four roles: the
``system`` prompt, the ``user``'s message, each ``assistant`` reply (what the model thought, its
``reasoning_content``, what it wrote, its ``content``, and the tools it called, its
``tool_calls``) and each ``tool`` result. A reply is a call, an agent reply, that used what was
new in its conversation and generated its tool calls and, the last, the agent's message; running
a tool call is a call that used it and generated its result. A plugin task is a tool call whose
run is drawn inside it, its nodes naming it as their ``parent``: its input, its own loop, a decide
task's decisions, its reference tool, its output, and the verifier's verdict on it. An agent
reply and a decision hold the model requests they made in ``modelCalls`` (tokens, cost and
timing), and a reply what it thought and wrote, streamed, in ``reasoning`` and ``text``.

Its edges are only what the run recorded, never inferred:

- ``used``: a call took a value: a tool its call, the verifier what it judges, a reply what is
  new in its conversation (the system prompt and the message, then each tool result since the
  reply before it);
- ``generated``: a call returned a value: a tool its result, a reply each tool call it made and,
  the last, the agent's message;
- ``continued``: a reply carried on the conversation of the one before it, so it read all that
  one read too;
- ``copied``: a field of a value is a copy of a field of an earlier value (a decide task's copied
  field, asked or forced), from ``fromPath`` to ``toPath``;
- ``chose``: a decision chose ``option`` for the field ``toPath`` of a value, or chose the next
  call; a copied field a decision picked the source of has both edges, its option the source's path.

A field a decide task's types fixed (its one option is not a copy) has no edge. A decide task's
node ids are the values' paths in its state (``input``, ``calls[0].arguments``,
``calls[0].output``, ``output``), so a decide path such as ``calls[0].output.entries[2].key``
names a node and a field in it.

A graph is built as the run goes, each change a *patch* passed to ``on_patch``: ``node`` (a new
node), ``edge``, ``update`` (fields of a node set) and ``append`` (text streamed onto a node's
field). :func:`apply` applies one to a graph's JSON, as a page drawing it live does.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Callable
from enum import StrEnum
from typing import Any, Literal

Patch = dict[str, Any]
Graph = dict[str, list[dict[str, Any]]]


class NodeType(StrEnum):
    """What a node of a run's graph is, a value or a call (:data:`CALLS`)."""

    # The messages of the loop's transcript.
    SYSTEM_PROMPT = "system_prompt"  # the system message
    USER_MESSAGE = "user_message"  # the user message the turn answers
    EARLIER_TURNS = "earlier_turns"  # the user and assistant messages of the turns before it
    AGENT_REPLY = "agent_reply"  # one assistant message: one model request, a call
    TOOL_CALL = "tool_call"  # one of a reply's tool calls: a tool's name and arguments
    TOOL = "tool"  # running a tool call, a call
    TOOL_RESULT = "tool_result"  # a tool message: what running a tool call returned
    AGENT_MESSAGE = "agent_message"  # the last reply's content: the agent's answer
    # A plugin task's run, inside its call.
    TASK = "task"  # running a tool call that is a plugin task, a call
    TASK_INPUT = "task_input"
    REFERENCE = "reference"  # its reference tool, a call
    REFERENCE_OUTPUT = "reference_output"
    DECISION = "decision"  # a decide task's choice, made by a model request, a call
    TASK_OUTPUT = "task_output"
    VERIFIER = "verifier"  # the plugin's verify_task, a call
    VERDICT = "verdict"


CALLS = frozenset({NodeType.AGENT_REPLY, NodeType.TOOL, NodeType.TASK, NodeType.REFERENCE, NodeType.DECISION, NodeType.VERIFIER})
Relation = Literal["used", "generated", "continued", "copied", "chose"]
_PLACE = re.compile(r"(input|output|calls\[\d+\]\.(?:arguments|output))(?:\.(.+))?")


def place(path: str) -> tuple[str, str]:
    """The node a decide state path names, and the field in it (``""`` for the whole value)."""
    found = _PLACE.fullmatch(path)
    if found is None:
        raise ValueError(f"{path!r} names no value of a task run")
    return found[1], found[2] or ""


def apply(graph: Graph, patch: Patch) -> None:
    """Apply ``patch`` to ``graph``, a graph's JSON, in place."""
    match patch["op"]:
        case "node":
            graph["nodes"].append(copy.deepcopy(patch["node"]))
        case "edge":
            graph["edges"].append(dict(patch["edge"]))
        case "update":
            [node] = [node for node in graph["nodes"] if node["id"] == patch["id"]]
            node.update(copy.deepcopy(patch["set"]))
        case "append":
            [node] = [node for node in graph["nodes"] if node["id"] == patch["id"]]
            node[patch["field"]] = node.get(patch["field"], "") + patch["text"]
        case op:
            raise ValueError(f"unknown graph patch {op!r}")


class Provenance:
    """The graph of one run, built as it runs: each change goes to ``on_patch`` as it is made,
    and :meth:`to_dict` is the whole graph."""

    def __init__(self, on_patch: Callable[[Patch], None]) -> None:
        self._graph: Graph = {"nodes": [], "edges": []}
        self._on_patch = on_patch
        self._decisions = 0

    def _send(self, patch: Patch) -> None:
        apply(self._graph, patch)
        self._on_patch(patch)

    def _node(self, id: str, type: NodeType, label: str, fields: dict[str, Any]) -> None:
        kind = "call" if type in CALLS else "value"
        self._send({"op": "node", "node": {"id": id, "type": type.value, "kind": kind, "label": label, **fields}})

    def value(self, id: str, type: NodeType, label: str, value: Any) -> None:
        self._node(id, type, label, {"value": value})

    def building(self, id: str, type: NodeType, label: str) -> None:
        """A value not known yet: ``incomplete`` until :meth:`built` gives it its value, and so
        for good when the run fails meanwhile."""
        self._node(id, type, label, {"value": None, "incomplete": True})

    def built(self, id: str, value: Any) -> None:
        self.update(id, value=value, incomplete=False)

    def call(self, id: str, type: NodeType, label: str, **fields: Any) -> None:
        self._node(id, type, label, {"isError": False, **fields})

    def update(self, id: str, **fields: Any) -> None:
        self._send({"op": "update", "id": id, "set": fields})

    def append(self, id: str, field: str, text: str) -> None:
        self._send({"op": "append", "id": id, "field": field, "text": text})

    def edge(self, source: str, target: str, relation: Relation, **detail: Any) -> None:
        self._send({"op": "edge", "edge": {"from": source, "to": target, "relation": relation, **detail}})

    def ran(self, call: str, type: NodeType, label: str, used: str, generated: tuple[str, NodeType, str, Any]) -> None:
        """A tool run: it used the value ``used`` and generated ``generated``, an ``(id, type, label, value)``."""
        self.call(call, type, label)
        self.edge(used, call, "used")
        self.value(*generated)
        self.edge(call, generated[0], "generated")

    def decision(self, label: str, model_calls: list[dict[str, Any]]) -> str:
        """A new decision's node id: ``label`` says what it chose, and ``model_calls`` are the
        profile JSON of the model requests that chose it."""
        decision = f"decisions[{self._decisions}]"
        self._decisions += 1
        self.call(decision, NodeType.DECISION, label, modelCalls=model_calls)
        return decision

    def decided(self, fields: list[tuple[str, str | list[str]]], forced: dict[str, str], sources: set[str], model_calls: list[dict[str, Any]]) -> None:
        """A batch of a decide task's field choices: ``fields`` the ``(path, option)`` each asked
        question was answered with, one decision made by ``model_calls``, and ``forced`` the fields
        filled with no question. An option in ``sources``, the paths of the values the fields
        could copy, is a copy."""
        # Named by the fields it chose, e.g. "Chose label, differs".
        names = dict.fromkeys(re.findall(r"[A-Za-z_]\w*", path)[-1] for path, _ in fields)
        decision = self.decision(f"Chose {', '.join(names)}", model_calls) if fields else None
        for path, option in [*fields, *forced.items()]:
            target, field = place(path)
            if isinstance(option, str) and option in sources:
                source, source_field = place(option)
                self.edge(source, target, "copied", fromPath=source_field, toPath=field)
            if decision is not None and path not in forced:
                self.edge(decision, target, "chose", toPath=field, option=option)

    def merge(self, patch: Patch, *, prefix: str, parent: str) -> None:
        """Apply ``patch``, made by another run's graph, as the run of the call ``parent``: its
        ids prefixed with ``prefix``, and each of its nodes with no parent inside ``parent``."""
        patch = copy.deepcopy(patch)
        if patch["op"] == "node":
            node = patch["node"]
            node["id"] = prefix + node["id"]
            node["parent"] = prefix + node["parent"] if "parent" in node else parent
        elif patch["op"] == "edge":
            patch["edge"]["from"] = prefix + patch["edge"]["from"]
            patch["edge"]["to"] = prefix + patch["edge"]["to"]
        else:
            patch["id"] = prefix + patch["id"]
        self._send(patch)

    def to_dict(self) -> Graph:
        return copy.deepcopy(self._graph)


class LoopRecorder:
    """An agent loop drawn into ``graph`` as it runs: each model request an agent reply that
    ``continued`` the one before it and ``used`` what is new in its conversation, starting with
    ``inputs``; each tool call it made (which it ``generated``), its run (of the type
    ``runs(name)``) and its result, which the next reply uses; and the last reply's message. Node
    ids start with ``prefix``.

    Feed it the loop's events: :meth:`delta`, :meth:`tool_started`, :meth:`tool_done`,
    :meth:`step_done` after each request with tool calls, and :meth:`finish` once it ends.
    """

    def __init__(self, graph: Provenance, inputs: list[str], *, prefix: str = "", runs: Callable[[str], NodeType] = lambda _name: NodeType.TOOL) -> None:
        self._graph = graph
        self._fresh = list(inputs)
        self._prefix = prefix
        self._runs = runs
        self._step: str | None = None
        self._last: str | None = None
        self._steps = 0
        self._calls: dict[str, str] = {}  # a tool call's id -> its node's id
        self.arguments: dict[str, str] = {}  # a tool's name -> its last call's arguments node

    def _open(self) -> str:
        if self._step is None:
            self._step = f"{self._prefix}steps[{self._steps}]"
            self._steps += 1
            self._graph.call(self._step, NodeType.AGENT_REPLY, f"Agent reply {self._steps}", reasoning="", text="", running=True, modelCalls=[])
            if self._last is not None:
                self._graph.edge(self._last, self._step, "continued")
            for value in self._fresh:
                self._graph.edge(value, self._step, "used")
            self._fresh = []
        return self._step

    def delta(self, kind: str, text: str) -> None:
        self._graph.append(self._open(), "reasoning" if kind == "reasoning" else "text", text)

    def tool_started(self, call_id: str, name: str) -> None:
        step = self._open()
        at = f"{self._prefix}calls[{len(self._calls)}]"
        self._calls[call_id] = at
        self._graph.building(f"{at}.arguments", NodeType.TOOL_CALL, f"{name} call")
        self._graph.edge(step, f"{at}.arguments", "generated")
        self._graph.call(at, self._runs(name), name, running=True)
        self._graph.edge(f"{at}.arguments", at, "used")

    def node(self, call_id: str) -> str:
        """The node of the tool call ``call_id``."""
        return self._calls[call_id]

    def tool_done(self, call_id: str, name: str, arguments: Any, output: Any, is_error: bool) -> None:
        if call_id not in self._calls:
            self.tool_started(call_id, name)
        at = self._calls[call_id]
        self._graph.built(f"{at}.arguments", arguments)
        self._graph.update(at, running=False, isError=is_error)
        self._graph.value(f"{at}.output", NodeType.TOOL_RESULT, f"{name} result", output)
        self._graph.edge(at, f"{at}.output", "generated")
        self._fresh.append(f"{at}.output")
        self.arguments[name] = f"{at}.arguments"

    def step_done(self, step: dict[str, Any] | None) -> None:
        """The request open now ended: ``step`` is its step's profile JSON, whose own model
        requests (not those of the tools it called) become its ``modelCalls``, and whose tool
        calls' times their calls' ``duration_s``."""
        if self._step is not None:
            calls = [call for call in (step or {}).get("model_calls", []) if call["kind"] != "tool"]
            self._graph.update(self._step, running=False, modelCalls=calls)
            for call in (step or {}).get("tool_calls", []):
                if call["id"] in self._calls:
                    self._graph.update(self._calls[call["id"]], duration_s=call["duration_s"])
            self._last, self._step = self._step, None

    def finish(self, answer: str | None, step: dict[str, Any] | None) -> None:
        """The loop ended: ``answer`` is what its last request wrote, None when it failed."""
        last = self._step
        self.step_done(step)
        if answer and last is not None:
            self._graph.value(f"{self._prefix}answer", NodeType.AGENT_MESSAGE, "Agent message", answer)
            self._graph.edge(last, f"{self._prefix}answer", "generated")
