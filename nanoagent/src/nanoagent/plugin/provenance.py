"""An agent run as a provenance graph: what each call used and generated, and where each value came from.

The graph has two kinds of node, as in W3C PROV: *values* (entities), data, and *calls*
(activities, the actions), what made them. Each node's ``type`` (:class:`NodeType`) is one *part*
of the run, which :data:`PARTS` registers: its name, whether it is a call, for a value the types
of call that make it, and how a page shows it, the one place that says so: the page kit draws
every node by its part (``kit/parts.js``, written from :data:`PARTS` by :func:`kit_parts`). The parts start from the messages of
NanoAgent's loop, whose transcript is chat messages of four roles: the ``system`` prompt, the
``user``'s message, each ``assistant`` reply (what the model thought, its ``reasoning_content``,
what it wrote, its ``content``, and the tools it called, its ``tool_calls``) and each ``tool``
result. A reply is a call, a model request, that used what was new in its conversation and
generated what it thought (thinking), what it wrote (assistant, while it calls tools, and the
agent's response for the last) and its tool calls; running a tool call is a call that used it and generated its result. A plugin
task is a tool call whose run is drawn inside it, its nodes naming it as their ``parent``: its
input, its own loop, a decide task's decisions, its reference tool, its output, and the
verifier's verdict on it. A model request and a decision hold the model requests they made in
``modelCalls`` (tokens, cost and timing).

Its edges are only what the run recorded, never inferred:

- ``used``: a call took a value: a tool its call, the verifier what it judges, a reply what is
  new in its conversation (the system prompt and the message, then each tool result since the
  reply before it);
- ``generated``: a call returned a value, one of the parts it makes: a tool its result, a reply
  its thinking, what it wrote and each tool call it made;
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
import json
import re
from collections.abc import Callable
from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal

Patch = dict[str, Any]
Graph = dict[str, list[dict[str, Any]]]


class NodeType(StrEnum):
    """What a node of a run's graph is: one of the run's parts (:data:`PARTS`)."""

    # The messages of the loop's transcript.
    SYSTEM_PROMPT = "system_prompt"  # the system message
    USER_MESSAGE = "user_message"  # the user message the turn answers
    EARLIER_TURNS = "earlier_turns"  # the user and assistant messages of the turns before it
    MODEL_REQUEST = "agent_reply"  # one model request, a call, which writes one assistant message; saved graphs hold this value
    THINKING = "thinking"  # a reply's reasoning_content
    ASSISTANT = "assistant"  # a reply's content, when it went on to call tools
    TOOL_CALL = "tool_call"  # one of a reply's tool calls: a tool's name and arguments
    TOOL = "tool"  # running a tool call, a call
    TOOL_RESULT = "tool_result"  # a tool message: what running a tool call returned
    RESPONSE = "agent_message"  # the last reply's content: the agent's response; saved graphs hold this value
    # A plugin task's run, inside its call.
    TASK = "task"  # running a tool call that is a plugin task, a call
    TASK_INPUT = "task_input"
    REFERENCE = "reference"  # its reference tool, a call
    REFERENCE_OUTPUT = "reference_output"
    DECISION = "decision"  # a decide task's choice, made by a model request, a call
    TASK_OUTPUT = "task_output"
    OUTPUT_CHECK = "verifier"  # the plugin's verify_task, a call; saved graphs hold this value
    VERDICT = "verdict"


# How the chat shows a part in a turn's agent loop (kit/loop.js): "whole", all of it as Markdown;
# "line", on one line opening to all of it; "run", a call whose own run is indented under it; or
# "hidden", not at all.
Chat = Literal["whole", "line", "run", "hidden"]
# How the graph draws a part (kit/graph.js): "card", a call with the parts it made on lines of
# its own and its model requests' tokens and time; "pill", a call by its name, with the parts
# folded into it; "box", a call whose own run is drawn inside it; "tile", a value with a glimpse
# of it; "line", a value on a line of the call it is folded into, by ``fold``.
Shape = Literal["card", "pill", "box", "tile", "line"]
# Which call a line is folded into: the one that generated it, or the one call that used it.
Fold = Literal["maker", "user"]
# Its colour: a model's thinking, a tool's or task's run, a check, a step of no other kind, the
# person, the agent's response, what the run was given, or none.
Hue = Literal["think", "task", "check", "neutral", "user", "answer", "quiet", "plain"]
# How its text is set: Markdown, as typed, as code, as a thought, or plain.
Font = Literal["prose", "typed", "code", "thought", "plain"]


@dataclass(frozen=True)
class Part:
    """One type of node: its name, whether it is a call (an action) or a value, for a value the
    types of call that make it (``made_by``), none for one the run is given, and how a page shows
    it: what it is, in a sentence (``about``), in the chat (``chat``), in the graph (``shape``,
    and for a line the call it is folded into, ``fold``), its colour (``hue``) and its text's
    (``font``). ``named``: its nodes have names of their own (a tool's, a task's), shown in place
    of its part's; ``once``: shown once a session
    while it is the same; ``repeats``: one in a row with the same label shows for all, with how
    many; ``verdict``: its value is a verdict, ``{valid, message}``."""

    label: str
    about: str
    chat: Chat
    shape: Shape
    call: bool = False
    made_by: tuple[NodeType, ...] = ()
    fold: Fold | None = None
    hue: Hue = "plain"
    font: Font = "plain"
    named: bool = False
    once: bool = False
    repeats: bool = False
    verdict: bool = False


PARTS: dict[NodeType, Part] = {
    NodeType.SYSTEM_PROMPT: Part("System prompt", "The instructions the model is given before the conversation.", "line", "tile", hue="quiet", once=True),
    NodeType.USER_MESSAGE: Part("User message", "What the person asked.", "whole", "tile", hue="user", font="typed"),
    NodeType.EARLIER_TURNS: Part("Earlier turns", "The messages of the conversation before this one, which the model read again.", "hidden", "tile", hue="quiet"),
    NodeType.MODEL_REQUEST: Part("Model request", "One request to the model: it reads the conversation so far and thinks, writes, or calls tools.", "hidden", "card", call=True, hue="think"),
    NodeType.THINKING: Part("Thinking", "What the model thought before it answered.", "line", "line", made_by=(NodeType.MODEL_REQUEST,), fold="maker", font="thought"),
    NodeType.ASSISTANT: Part("Assistant", "What the model wrote on its way to calling tools.", "whole", "line", made_by=(NodeType.MODEL_REQUEST,), fold="maker", font="prose"),
    NodeType.TOOL_CALL: Part("Tool call", "A tool the model chose to run, and the input it gave it.", "line", "line", made_by=(NodeType.MODEL_REQUEST, NodeType.DECISION), fold="user", font="code"),
    NodeType.TOOL: Part("Tool", "One of the plugin's tools, run as code on the input it was given.", "hidden", "pill", call=True, hue="task", font="code", named=True),
    NodeType.TOOL_RESULT: Part("Tool result", "What running the tool returned.", "line", "line", made_by=(NodeType.TOOL, NodeType.TASK), fold="maker"),
    NodeType.RESPONSE: Part("Response", "The agent's answer to the person.", "whole", "line", made_by=(NodeType.MODEL_REQUEST,), fold="maker", hue="answer", font="prose"),
    NodeType.TASK: Part("Task", "One of the plugin's tasks: its own run, whose output its check judges.", "run", "box", call=True, hue="task", named=True),
    NodeType.TASK_INPUT: Part("Task input", "The input the task was given.", "line", "tile"),
    NodeType.REFERENCE: Part("Reference", "The plugin's reference tool, run on the same input to give the output the task's is compared with.", "hidden", "pill", call=True, hue="neutral", font="code", named=True),
    NodeType.REFERENCE_OUTPUT: Part("Reference output", "What the reference tool returned.", "line", "line", made_by=(NodeType.REFERENCE,), fold="maker"),
    NodeType.DECISION: Part("Decision", "Fields of the task's output the model chose.", "line", "pill", call=True, hue="think", repeats=True, named=True),
    NodeType.TASK_OUTPUT: Part("Task output", "What the task returned.", "line", "tile", made_by=(NodeType.MODEL_REQUEST, NodeType.DECISION, NodeType.TOOL)),
    NodeType.OUTPUT_CHECK: Part("Output check", "The plugin's own code checking the task's output against its input; no model takes part.", "hidden", "pill", call=True, hue="check"),
    NodeType.VERDICT: Part("Verdict", "Whether the task's output passed its check, and why.", "line", "tile", made_by=(NodeType.OUTPUT_CHECK,), verdict=True),
}
KIT_PARTS = Path(__file__).parent / "v0001" / "page" / "kit" / "parts.js"


def kit_parts() -> str:
    """:data:`PARTS` as the page kit's ``kit/parts.js``: ``TYPES``, each type's value by its name,
    and ``PARTS``, each part by its type's value, in this order. Write it with
    ``python -m nanoagent.plugin.provenance``."""
    types = {type.name: type.value for type in NodeType}
    parts = {type.value: {**asdict(part), "made_by": [made.value for made in part.made_by]} for type, part in PARTS.items()}
    return (
        "// Each type of a run's graph node and how a page shows it: nanoagent.plugin.provenance.PARTS,\n"
        "// written by `python -m nanoagent.plugin.provenance`. Do not edit it here.\n\n"
        f"export const TYPES = {json.dumps(types, indent=2)};\n\n"
        f"export const PARTS = {json.dumps(parts, indent=2)};\n"
    )


CALLS = frozenset(type for type, part in PARTS.items() if part.call)
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
        if patch["op"] == "edge" and patch["edge"]["relation"] == "generated":
            # A call generates only the parts its type makes.
            types = {node["id"]: node["type"] for node in self._graph["nodes"]}
            call, value = NodeType(types[patch["edge"]["from"]]), NodeType(types[patch["edge"]["to"]])
            if call not in PARTS[value].made_by:
                raise ValueError(f"a {call} call does not make a {value}")
        apply(self._graph, patch)
        self._on_patch(patch)

    @staticmethod
    def _typed(type: NodeType) -> dict[str, str]:
        return {"type": type.value, "kind": "call" if PARTS[type].call else "value"}

    def _node(self, id: str, type: NodeType, label: str, fields: dict[str, Any]) -> None:
        self._send({"op": "node", "node": {"id": id, **self._typed(type), "label": label, **fields}})

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

    def retype(self, id: str, type: NodeType, label: str) -> None:
        """The value ``id`` turned out to be a ``type``, named ``label``: a reply's text its response,
        a tool call the task's output it submitted."""
        if PARTS[type].call:
            raise ValueError(f"a value cannot become a {type}, a call")
        self.update(id, **self._typed(type), label=label)

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
    """An agent loop drawn into ``graph`` as it runs: each model request a call that
    ``continued`` the one before it and ``used`` what is new in its conversation, starting with
    ``inputs``, and that ``generated`` what it thought and wrote, as they stream, and each tool call
    it made; each tool call's run (of the type ``runs(name)``) and its result, which the next reply
    uses; and what the last reply wrote, the agent's response. Node ids start with ``prefix``.

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
        self._streamed: set[str] = set()  # the thinking and content nodes made so far
        self.arguments: dict[str, str] = {}  # a tool's name -> its last call's arguments node

    def _open(self) -> str:
        if self._step is None:
            self._step = f"{self._prefix}steps[{self._steps}]"
            self._steps += 1
            self._graph.call(self._step, NodeType.MODEL_REQUEST, PARTS[NodeType.MODEL_REQUEST].label, running=True, modelCalls=[])
            if self._last is not None:
                self._graph.edge(self._last, self._step, "continued")
            for value in self._fresh:
                self._graph.edge(value, self._step, "used")
            self._fresh = []
        return self._step

    def delta(self, kind: str, text: str) -> None:
        """More of what the open request thought (``kind`` "reasoning") or wrote."""
        step = self._open()
        # Named by the assistant message's field it is.
        type, at = (NodeType.THINKING, f"{step}.reasoning") if kind == "reasoning" else (NodeType.ASSISTANT, f"{step}.content")
        if at not in self._streamed:
            self._streamed.add(at)
            self._graph.value(at, type, PARTS[type].label, "")
            self._graph.edge(step, at, "generated")
        self._graph.append(at, "value", text)

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
        """The loop ended: ``answer`` is what its last request wrote, None when it failed, which is
        the agent's response."""
        last = self._step
        self.step_done(step)
        if answer and last is not None:
            at = f"{last}.content"
            if at not in self._streamed:
                self._graph.value(at, NodeType.ASSISTANT, PARTS[NodeType.ASSISTANT].label, answer)
                self._graph.edge(last, at, "generated")
            self._graph.retype(at, NodeType.RESPONSE, PARTS[NodeType.RESPONSE].label)
            self._graph.update(at, value=answer)


if __name__ == "__main__":
    KIT_PARTS.write_text(kit_parts(), encoding="utf-8")
