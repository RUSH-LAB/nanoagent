"""An agent run as a provenance graph: what each call used and generated, and where each value came from.

The graph has two kinds of node, as in W3C PROV. *Values* (entities) are data: the message a turn
answers, each call's arguments and output, a task's input, output and verdict, the answer.
*Calls* (activities) are each model request of an agent loop (``model``: what it thought and
wrote, as it streamed, and its tokens, cost and timing in ``modelCalls``), each tool call
(``tool``, or ``task`` when the tool is a plugin task, whose own run is drawn inside it: its
nodes name it as their ``parent``), a decide task's decisions (``decision``), its reference tool
(``reference``) and its verifier (``verify``). Its edges are only what the run recorded, never
inferred:

- ``used``: a call took a value: a tool its arguments, the verifier what it judges, a model
  request the values new in its conversation (the message, and each tool output since the
  request before it);
- ``generated``: a call returned a value: a tool its output, a model request the arguments of
  each tool call it made and, the last, the answer;
- ``continued``: a model request carried on the conversation of the one before it, so it read
  all that one read too;
- ``copied``: a field of a value is a copy of a field of an earlier value (a decide task's copied
  field, asked or forced), from ``fromPath`` to ``toPath``;
- ``chose``: a decision chose ``option`` for the field ``toPath`` of a value, or chose the next
  call; a copied field a decision picked the source of has both edges, its option the source's path.

A field a decide task's types fixed (its one option is not a copy) has no edge. A value no call
generated says where it came from in ``origin``: ``user`` (the message), ``session`` (the turns
before it) or ``input`` (a task's input). A decide task's node ids are the values' paths in its
state (``input``, ``calls[0].arguments``, ``calls[0].output``, ``output``), so a decide path such
as ``calls[0].output.entries[2].key`` names a node and a field in it.

A graph is built as the run goes, each change a *patch* passed to ``on_patch``: ``node`` (a new
node), ``edge``, ``update`` (fields of a node set) and ``append`` (text streamed onto a node's
field). :func:`apply` applies one to a graph's JSON, as a page drawing it live does.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Callable
from typing import Any, Literal

Patch = dict[str, Any]
Graph = dict[str, list[dict[str, Any]]]
Origin = Literal["user", "session", "input"]
Role = Literal["model", "tool", "task", "reference", "decision", "verify"]
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

    def value(self, id: str, label: str, value: Any, *, origin: Origin | None = None) -> None:
        node: dict[str, Any] = {"id": id, "kind": "value", "label": label, "value": value}
        if origin is not None:
            node["origin"] = origin
        self._send({"op": "node", "node": node})

    def building(self, id: str, label: str) -> None:
        """A value not known yet: ``incomplete`` until :meth:`built` gives it its value, and so
        for good when the run fails meanwhile."""
        self._send({"op": "node", "node": {"id": id, "kind": "value", "label": label, "value": None, "incomplete": True}})

    def built(self, id: str, value: Any) -> None:
        self.update(id, value=value, incomplete=False)

    def call(self, id: str, role: Role, label: str, **fields: Any) -> None:
        self._send({"op": "node", "node": {"id": id, "kind": "call", "role": role, "label": label, "isError": False, **fields}})

    def update(self, id: str, **fields: Any) -> None:
        self._send({"op": "update", "id": id, "set": fields})

    def append(self, id: str, field: str, text: str) -> None:
        self._send({"op": "append", "id": id, "field": field, "text": text})

    def edge(self, source: str, target: str, relation: Relation, **detail: Any) -> None:
        self._send({"op": "edge", "edge": {"from": source, "to": target, "relation": relation, **detail}})

    def ran(self, call: str, role: Literal["tool", "reference"], label: str, used: str, generated: tuple[str, str, Any]) -> None:
        """A tool call: it used the value ``used`` and generated ``generated``, an ``(id, label, value)``."""
        self.call(call, role, label)
        self.edge(used, call, "used")
        self.value(*generated)
        self.edge(call, generated[0], "generated")

    def decision(self, label: str, model_calls: list[dict[str, Any]]) -> str:
        """A new decision's node id: ``label`` says what it chose, and ``model_calls`` are the
        profile JSON of the model requests that chose it."""
        decision = f"decisions[{self._decisions}]"
        self._decisions += 1
        self.call(decision, "decision", label, modelCalls=model_calls)
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
    """An agent loop drawn into ``graph`` as it runs: each model request a ``model`` call that
    ``continued`` the one before it and ``used`` what is new in its conversation, starting with
    ``inputs``; each tool call it made its arguments (which it ``generated``), the call (of the
    role ``role(name)``) and its output, which the next request uses. Node ids start with ``prefix``.

    Feed it the loop's events: :meth:`delta`, :meth:`tool_started`, :meth:`tool_done`,
    :meth:`step_done` after each request with tool calls, and :meth:`finish` once it ends.
    """

    def __init__(self, graph: Provenance, inputs: list[str], *, prefix: str = "", role: Callable[[str], Role] = lambda _name: "tool") -> None:
        self._graph = graph
        self._fresh = list(inputs)
        self._prefix = prefix
        self._role = role
        self._step: str | None = None
        self._last: str | None = None
        self._steps = 0
        self._calls: dict[str, str] = {}  # a tool call's id -> its node's id
        self.arguments: dict[str, str] = {}  # a tool's name -> its last call's arguments node

    def _open(self) -> str:
        if self._step is None:
            self._step = f"{self._prefix}steps[{self._steps}]"
            self._steps += 1
            self._graph.call(self._step, "model", f"Model request {self._steps}", reasoning="", text="", running=True, modelCalls=[])
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
        self._graph.building(f"{at}.arguments", f"{name} arguments")
        self._graph.edge(step, f"{at}.arguments", "generated")
        self._graph.call(at, self._role(name), name, running=True)
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
        self._graph.value(f"{at}.output", f"{name} output", output)
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
            self._graph.value(f"{self._prefix}answer", "Answer", answer)
            self._graph.edge(last, f"{self._prefix}answer", "generated")
