"""The dialect-neutral engine: scenarios, the per-run ledger and the choice of what each request gets.

Usage vocabulary. A scenario's ``usage.prompt`` is the TOTAL prompt tokens of the call, cached reads and
cache writes included (so ``cached + cache_write <= prompt``). Each dialect converts that to its own wire
fields (chat: ``prompt_tokens`` is the total; Anthropic: ``input_tokens`` excludes cache; responses:
``input_tokens`` is the total) and the ledger records the NORMALIZED usage the wire actually carried:
``input`` is again the total including cache. A dialect that cannot carry a field (Anthropic has no
reasoning count, responses has no cache-write count) normalizes it to 0, because that is what the client sees.

Scenario YAML::

    _ > mockllm.engine.Scenario:
    name: two-step-answer
    turns:
      - {ttfb: 0.6, stream: {chunks: 10, gap: 0.05}, text: "Working.", act: {wait: 1.0}, usage: {prompt: 1000, completion: 50}}

Turns a harness never requests are simply unused: a scenario may end with a closing turn that only some harnesses
reach (a coding harness asks the model once more after the shell call that writes answer.json, where NanoAgent's
refusal is final text). Checks therefore use what the ledger shows was served (``Ledger.main_calls`` and their
``turn_index``), never the scenario's turn count.

Generation lookup (OpenRouter's ``GET /api/v1/generation?id=…``): a scenario that sets ``generation.lookup`` gives every
successful reply an ``x-generation-id: gen-…`` header and serves the call's accounting at the endpoint, but only
``generation.delay`` seconds after the reply completed (404 until then, as OpenRouter does for about 20 s). The record
carries ``total_cost`` (``generation.cost``) and native token counts (``generation.native`` where set, else the call's own
usage). A scenario without ``lookup`` sends no generation ID, so the endpoint is never asked.

Turn timing: the first byte leaves ``ttfb`` after arrival, then each of ``chunks`` chunks leaves ``gap`` after
the previous one, so a call's server span is ``ttfb + chunks * gap``.
"""

from __future__ import annotations

import dataclasses
import secrets
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, get_args, get_origin, get_type_hints

from slimconfig import Output, build_output, load_yaml
from slimconfig.names import schema_name

from .actions import ActionError, Rendered, render


@dataclass
class Stream(Output):
    chunks: int = 1
    gap: float = 0.0


@dataclass
class Usage(Output):
    prompt: int = 0  # total prompt tokens, cached reads and cache writes included
    cached: int = 0
    completion: int = 0
    reasoning: int = 0
    cache_write: int = 0


@dataclass
class Generation(Output):
    lookup: bool = False
    # Seconds after a reply completes during which its generation 404s.
    delay: float = 0.0
    # The generation's total_cost in USD.
    cost: float = 0.0
    # Native token counts the lookup reports instead of the wire usage, for the fields set (non-zero).
    native: Usage = field(default_factory=Usage)


@dataclass
class Turn(Output):
    ttfb: float = 0.0
    stream: Stream = field(default_factory=Stream)
    reasoning: str = ""
    text: str = ""
    # An abstract action (see actions.py): None (plain text), "malformed", {wait: s}, {answer: x}, {refuse: why},
    # or a list of those (several tool calls in one turn).
    act: Any = None
    usage: Usage = field(default_factory=Usage)
    # An injected HTTP error: the turn answers with this status and is consumed; the next turn is the retry.
    status: int | None = None
    # How many consecutive requests this turn serves; 0 serves every remaining request (a provider that always errs).
    repeat: int = 1
    # A stream that dies: the reply stops after this many body chunks, without its closing frames. None sends it whole.
    cut: int | None = None
    # False answers without any usage object (a provider that did not report it); the ledger records no usage for the call.
    report_usage: bool = True


@dataclass
class Expect(Output):
    correct: bool | None = None
    verdict_contains: str = ""


@dataclass
class Scenario(Output):
    name: str
    case: str = ""
    turns: list[Turn] = field(default_factory=list)
    # The usage a side call (another model, or no tools) reports.
    side_usage: Usage = field(default_factory=Usage)
    expect: Expect = field(default_factory=Expect)
    # Harnesses this scenario does not apply to, with the reason (carried for the test matrix, not used here).
    na: dict[str, str] = field(default_factory=dict)
    generation: Generation = field(default_factory=Generation)


def _filled(value: Any, cls: type) -> Any:
    """``value`` with every field it omits set to the class's default, so YAML may write only what differs."""
    if not dataclasses.is_dataclass(cls) or not isinstance(value, dict):
        return value
    hints = get_type_hints(cls)
    out = dict(value)
    for f in dataclasses.fields(cls):
        if f.name not in out:
            if f.default is not dataclasses.MISSING:
                out[f.name] = f.default
            elif f.default_factory is not dataclasses.MISSING:
                made = f.default_factory()
                out[f.name] = dataclasses.asdict(made) if dataclasses.is_dataclass(made) else made
        else:
            hint = hints[f.name]
            if get_origin(hint) is list and dataclasses.is_dataclass(get_args(hint)[0]):
                out[f.name] = [_filled(item, get_args(hint)[0]) for item in out[f.name]]
            else:
                out[f.name] = _filled(out[f.name], hint)
    return out


def load_scenario(path: str | Path) -> Scenario:
    """Load a scenario YAML whose first line is ``_ > mockllm.engine.Scenario:``."""
    data = load_yaml(path)
    header = [key for key in data if isinstance(key, str) and key.startswith("_ >")]
    if len(header) != 1 or header[0][3:].strip() != schema_name(Scenario):
        raise ValueError(f"{path} must start with `_ > {schema_name(Scenario)}:`, found {header}")
    del data[header[0]]
    return build_output(_filled(data, Scenario), Scenario)


@dataclass(frozen=True)
class NormalizedUsage:
    """Usage as a client sees it on the wire, in one vocabulary: ``input`` includes cached reads and cache writes."""

    input: int = 0
    cached: int = 0
    cache_write: int = 0
    output: int = 0
    reasoning: int = 0

    def __add__(self, other: NormalizedUsage) -> NormalizedUsage:
        return NormalizedUsage(*(a + b for a, b in zip(dataclasses.astuple(self), dataclasses.astuple(other), strict=True)))


@dataclass(frozen=True)
class ToolSpec:
    name: str
    schema: dict[str, Any]


@dataclass
class ParsedRequest:
    dialect: str
    path: str
    model: str
    messages: list[Any]
    tools: list[ToolSpec]
    stream: bool
    stream_options: dict[str, Any] | None
    auth_header: str  # "x-api-key", "authorization" or ""
    auth: str  # the key, a bearer's "Bearer " stripped
    body: dict[str, Any]


@dataclass
class Call:
    """One request the mock received."""

    dialect: str
    path: str
    arrival: float
    request: ParsedRequest | None = None
    kind: str = "violation"  # main | side | error (an injected status) | violation (HTTP 599)
    status: int = 0
    first_byte: float | None = None
    last_byte: float | None = None
    usage: NormalizedUsage | None = None  # what the reply carried; None when it carried none (errors, violations)
    turn_index: int | None = None
    aborted: bool = False  # the client closed the connection before the reply ended

    @property
    def span(self) -> float:
        """Server span: arrival to last byte."""
        if self.last_byte is None:
            raise ValueError("the call has no last byte")
        return self.last_byte - self.arrival


@dataclass
class Lookup:
    """One ``GET /generation`` the mock received: which generation, and what it answered."""

    generation_id: str
    status: int
    time: float


@dataclass
class GenerationRecord:
    generation_id: str
    model: str
    usage: Usage
    streamed: bool
    created: float  # wall clock, seconds
    completed: float | None = None  # perf_counter at the end of the reply; None while it is in flight


class Ledger:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._calls: list[Call] = []
        self._lookups: list[Lookup] = []
        self.violations: list[str] = []

    def add(self, call: Call) -> None:
        with self._lock:
            self._calls.append(call)

    def add_lookup(self, lookup: Lookup) -> None:
        with self._lock:
            self._lookups.append(lookup)

    @property
    def lookups(self) -> list[Lookup]:
        with self._lock:
            return list(self._lookups)

    def violate(self, message: str) -> None:
        with self._lock:
            self.violations.append(message)

    @property
    def calls(self) -> list[Call]:
        with self._lock:
            return list(self._calls)

    def of_kind(self, kind: str) -> list[Call]:
        return [call for call in self.calls if call.kind == kind]

    @property
    def main_calls(self) -> list[Call]:
        return self.of_kind("main")

    @property
    def side_calls(self) -> list[Call]:
        return self.of_kind("side")

    def usage(self, *kinds: str) -> NormalizedUsage:
        """The summed normalized usage of the calls of these kinds (default: main calls only)."""
        total = NormalizedUsage()
        for call in self.calls:
            if call.kind in (kinds or ("main",)) and call.usage is not None:
                total += call.usage
        return total

    def server_spans(self, kind: str = "main") -> list[float]:
        return [call.span for call in self.of_kind(kind)]

    def assert_clean(self) -> None:
        if self.violations:
            raise AssertionError(f"the mock saw protocol violations: {self.violations}")


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str  # a JSON text


@dataclass
class Reply:
    reasoning: str
    text: str
    tool_calls: list[ToolCall]


@dataclass
class Plan:
    """What the engine decided for one request."""

    kind: str
    status: int = 200
    message: str = ""
    turn: Turn | None = None
    turn_index: int | None = None
    reply: Reply | None = None
    usage: Usage | None = None


def _substituted(value: Any, refs: dict[str, Any]) -> Any:
    """``value`` with every string ``"@name"`` replaced by ``refs[name]``."""
    if isinstance(value, str) and value.startswith("@") and value[1:] in refs:
        return refs[value[1:]]
    if isinstance(value, dict):
        return {key: _substituted(item, refs) for key, item in value.items()}
    if isinstance(value, list):
        return [_substituted(item, refs) for item in value]
    return value


class Run:
    """One registered run: its scenario, its cursor over the turns, its ledger. Isolated from every other run."""

    SIDE_REPLY = "ok"

    def __init__(self, scenario: Scenario, harness: str, model: str, refs: dict[str, Any] | None = None) -> None:
        self.scenario = scenario
        self.harness = harness
        self.model = model
        self.refs = refs or {}
        self.ledger = Ledger()
        self._lock = threading.Lock()
        self._index = 0
        self._served = 0
        self._calls = 0
        self._generations: dict[str, GenerationRecord] = {}

    def is_main(self, request: ParsedRequest) -> bool:
        # A scripted turn answers a request with tools, or a structured answer a decide task asks for (a `response_format`).
        return request.model == self.model and (bool(request.tools) or "response_format" in request.body)

    def _pop(self) -> tuple[int, Turn] | None:
        with self._lock:
            if self._index >= len(self.scenario.turns):
                return None
            index, turn = self._index, self.scenario.turns[self._index]
            self._served += 1
            if turn.repeat and self._served >= turn.repeat:
                self._index += 1
                self._served = 0
            return index, turn

    def plan(self, request: ParsedRequest) -> Plan:
        if not self.is_main(request):
            return Plan("side", reply=Reply("", self.SIDE_REPLY, []), usage=self.scenario.side_usage)
        popped = self._pop()
        if popped is None:
            return Plan("violation", 599, f"scenario {self.scenario.name!r} has no turns left for request {request.path}")
        index, turn = popped
        if turn.status is not None:
            return Plan("error", turn.status, f"injected error from turn {index}", turn, index)
        try:
            rendered = render(_substituted(turn.act, self.refs), request.tools, self.harness)
        except ActionError as error:
            return Plan("violation", 599, f"turn {index} cannot render for {self.harness}: {error}", turn, index)
        return Plan("main", turn=turn, turn_index=index, reply=self._reply(turn, rendered), usage=turn.usage)

    def _reply(self, turn: Turn, rendered: Rendered) -> Reply:
        with self._lock:
            first = self._calls
            self._calls += len(rendered.tool_calls)
        calls = [ToolCall(f"call_{first + n}", call.name, call.arguments) for n, call in enumerate(rendered.tool_calls)]
        text = "\n".join(part for part in (turn.text, rendered.text) if part)
        return Reply(turn.reasoning, text, calls)

    def start_generation(self, request: ParsedRequest, usage: Usage) -> str | None:
        """The generation ID of a reply about to be sent, or None when the scenario has no generation lookup."""
        if not self.scenario.generation.lookup:
            return None
        generation_id = f"gen-{secrets.token_hex(10)}"
        with self._lock:
            self._generations[generation_id] = GenerationRecord(generation_id, request.model, usage, request.stream, time.time())
        return generation_id

    def finish_generation(self, generation_id: str) -> None:
        with self._lock:
            self._generations[generation_id].completed = time.perf_counter()

    def generation(self, generation_id: str) -> dict[str, Any] | None:
        """OpenRouter's generation record, or None while it is unknown or still inside its delay after completion."""
        with self._lock:
            record = self._generations.get(generation_id)
        setting = self.scenario.generation
        if record is None or record.completed is None or time.perf_counter() < record.completed + setting.delay:
            return None
        native = {name: getattr(setting.native, name) or getattr(record.usage, name) for name in ("prompt", "cached", "completion", "reasoning")}
        return {
            "id": record.generation_id,
            "total_cost": setting.cost,
            "cache_discount": None,
            "upstream_inference_cost": setting.cost,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(record.created)),
            "model": record.model,
            "provider_name": "MockProvider",
            "streamed": record.streamed,
            "cancelled": False,
            "finish_reason": "stop",
            "native_finish_reason": "stop",
            "tokens_prompt": native["prompt"],
            "tokens_completion": native["completion"],
            "native_tokens_prompt": native["prompt"],
            "native_tokens_completion": native["completion"],
            "native_tokens_reasoning": native["reasoning"],
            "native_tokens_cached": native["cached"],
            "usage": setting.cost,
            "origin": "mock",
            "is_byok": False,
        }

    def begin(self, dialect: str, path: str) -> Call:
        call = Call(dialect, path, time.perf_counter())
        self.ledger.add(call)
        return call
