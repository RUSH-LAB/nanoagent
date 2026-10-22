"""Typed, slimconfig-backed structured run configuration.

A run is described by :class:`RunConfig`, which nests :class:`ModelConfig` (how to reach the
model — SGLang served name, endpoint, sampling, prices) and :class:`AgentConfig` (how to drive
the loop — system prompt, step/cost limits), plus ``tools`` (the toolset, as tool-config YAML
paths; see :func:`~nanoagent.extensions.get_tools`) and ``task`` / ``output`` for what to run and
where to write it. :class:`InteractiveConfig` and :class:`BatchConfig` extend it for the
``chat`` and batch ``run`` modes; :class:`BrowseConfig` is a standalone schema for the
``browse`` viewer. Everything is yaml-driven — the CLIs take no argparse flags, only
``key=value`` tokens (see :func:`load_config_args`), so all knobs live in the YAML.

Every schema subclasses :class:`slimconfig.Config` and is loaded by
:func:`slimconfig.load_config`, so the new-dialect rules apply:

  * NO field has a default — every leaf is ``MISSING`` and must be set explicitly in the YAML
    (a config fully specifies the run; nothing is silently filled in). An unset leaf raises; a
    nullable field that is "off" must still be present, set to ``null`` (e.g. ``cost_limit: null``),
    and an empty collection must be written out (e.g. ``tools: []``);
  * every config file names the class it fills (``_ > nanoagent.runtime.config.BatchConfig:``)
    and every block that fills a nested class names it too
    (``model > nanoagent.runtime.config.ModelConfig:``);
  * unknown keys are rejected, and every value must match its declared type;
  * one file inherits one file (``_default: <path>``, resolved against the CWD) — independent
    files compose at the launch instead, as several ``*_cfg=`` tokens (see :func:`_ordered_specs`).

Three shapes that do not fit "every key is registered" are spelled as values, not keys:

  * free-form knob maps (``extra_body``, both ``options``) are ``key=value`` token lists (see
    :func:`parse_kv_list`) — inline, overridable as a whole, parsed where they are consumed;
  * ``model_overrides`` is a :data:`ModelPart`, a partial :class:`ModelConfig` stating only the
    fields it changes (see :func:`slimconfig.stated`);
  * registries (``profiles``, ``benchmarks``, ``models``) are lists of per-entry YAML files, each
    a complete entry config — the entry's id is its file's stem (see :func:`load_registry`).

CLI entry points pass ``["<file>.yaml", "agent.max_steps=30", ...]``; later specs win.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, TypeVar

import yaml
from omegaconf import MISSING
# The loader itself is slimconfig (github.com/zeyuyang8/slimconfig), the extracted standalone
# package this repo's copy grew into: `load_config` merges specs onto a schema with the rules
# documented above, and `peek` reads one key before a schema is chosen. Re-exported under their own
# names here, so `from nanoagent.runtime.config import load_config` keeps working.
from slimconfig import Config, Spec, load_config, partial_of, stated
from slimconfig import peek as _peek

from nanoagent.extensions import resolve_config

T = TypeVar("T")


def _check_concurrency(value: Any, *, what: str = "concurrency") -> None:
    """Shared fan-out guard: ``asyncio.Semaphore(0)`` would deadlock the batch forever."""
    if isinstance(value, int) and value < 1:
        raise ValueError(f"{what} must be >= 1, got {value}")


def _check_timeout(value: Any, *, what: str = "timeout") -> None:
    """Shared wall-clock guard: ``<= 0`` cancels every rollout before it does any work."""
    if isinstance(value, (int, float)) and value <= 0:
        raise ValueError(f"{what} must be > 0 or null, got {value}")


def _parse_kv_value(raw: str) -> Any:
    """Parse one token value: JSON first, YAML-flow collections second, else the literal string.

    Scalars stay strict JSON on purpose — full-YAML parsing would turn ``level=off`` into False
    and ``date=2024-01-01`` into a date. But a value led by ``[`` or ``{`` that is not valid JSON
    reads as a YAML flow collection, so lists keep their natural spelling (``args=[--foo, bar]``)
    instead of demanding JSON's quoted strings. A bracket-led value that parses as neither is an
    error rather than a silent string: ``extra_args=[--foo`` must fail, not iterate characters.
    """
    try:
        return json.loads(raw)
    except ValueError:
        pass
    if raw[:1] in ("[", "{"):
        try:
            parsed = yaml.safe_load(raw)
        except yaml.YAMLError as error:
            raise ValueError(f"value {raw!r} is neither JSON nor YAML: {error}") from error
        if not isinstance(parsed, (list, dict)):
            raise ValueError(f"value {raw!r} is neither a JSON nor a YAML collection")
        return parsed
    return raw


def parse_kv_list(items: list[str]) -> dict[str, Any]:
    """Parse free-form ``key=value`` tokens into a mapping (see :class:`ModelConfig`).

    Each item splits on its FIRST ``=``; the key is literal (no dotted expansion) and must be
    unique. A value is JSON when it parses as JSON (``retries=3``, ``tags=["a", "b"]``), a YAML
    flow collection when bracket-led (``args=[--foo, bar]``), else the literal string
    (``prompt=You are...``) — see :func:`_parse_kv_value`. A value that would parse as JSON but
    should stay a string must be double-quoted (``port="8080"``). ``key=`` is the empty string;
    ``key=null`` is None.
    """
    parsed: dict[str, Any] = {}
    for item in items:
        key, sep, raw = item.partition("=")
        key = key.strip()
        if not sep or not key:
            raise ValueError(f"expected key=value, got {item!r}")
        if key in parsed:
            raise ValueError(f"duplicate key {key!r} in {items!r}")
        parsed[key] = _parse_kv_value(raw.strip())
    return parsed


def load_registry[T](paths: list[str], schema: type[T]) -> dict[str, T]:
    """Load per-entry config files into ``{file stem: entry}`` (see :class:`BenchmarkRunConfig`).

    Paths resolve like every other config path (the CWD first, then the configs shipped inside
    the package). Each file must be a complete ``schema`` on its own; two files with the same
    stem are an error, since the stem is the id selections (``profile=``, ``benchmark=``,
    ``/model``) name.
    """
    entries: dict[str, T] = {}
    sources: dict[str, str] = {}
    for path in paths:
        resolved = resolve_config(path)
        entry = load_config(schema, [str(resolved)])
        stem = resolved.stem
        if stem in entries:
            raise ValueError(
                f"duplicate entry {stem!r}: {sources[stem]!r} and {path!r} name the same id"
            )
        entries[stem] = entry
        sources[stem] = path
    return entries


class ThemeName(StrEnum):
    """The style names the REPL emits — the only keys a ``theme:`` override can usefully set."""

    agent = "agent"
    tool = "tool"
    notice = "notice"
    warn = "warn"
    error = "error"
    dim = "dim"
    bold = "bold"


@dataclass
class ModelConfig(Config):
    """How to reach one model.

    ``provider`` selects the chat client (see :mod:`nanoagent.inference.providers`): ``"sglang"``,
    ``"vllm"`` and ``"openrouter"`` share one OpenAI-compatible ``/v1`` client, while ``"bedrock"`` uses
    Amazon Bedrock Converse. ``base_url`` is the OpenAI-compatible endpoint. SGLang's ``/generate`` endpoint is
    :class:`~nanoagent.inference.config.GenerateConfig`, a different spec.

    Every field is required (no defaults — a config must set each one explicitly); ``Optional``
    fields may be ``null`` but must still be present. That all-required contract is the ONLY
    reason this is not just :class:`~nanoagent.inference.config.LeanInferConfig`: the fields are a strict subset of
    it, by the same names, so :meth:`~nanoagent.runtime.model.Model.from_config` translates by field-name
    projection (plus :func:`parse_kv_list` on ``extra_body``).
    """

    model: str = MISSING
    # which chat client to build: "sglang", "vllm", "openrouter", or "bedrock".
    provider: str = MISSING
    # OpenAI-compatible /v1 endpoint. null: sglang and vllm reach SGLANG_BASE_URL / VLLM_BASE_URL,
    # and openrouter its own endpoint.
    base_url: str | None = MISSING
    # OpenAI-style key. OpenRouter reads this, or OPENROUTER_API_KEY when null; sglang and vllm
    # this, or SGLANG_API_KEY / VLLM_API_KEY, which a server started without --api-key ignores.
    # May be null, but must be present.
    api_key: str | None = MISSING
    # Bedrock region/profile. null follows boto3's standard region/credential resolution chains.
    # Other providers ignore these fields.
    aws_region: str | None = MISSING
    aws_profile: str | None = MISSING
    # null omits temperature from the request body entirely rather than sending a default: a
    # reasoning deployment behind a gateway rejects an explicit one with a 400. 0.0 is a value
    # and is still sent.
    temperature: float | None = MISSING
    max_tokens: int | None = MISSING
    # Per-request wall-clock read timeout (seconds) on the OpenAI client — forwarded to
    # LeanInferConfig.request_timeout. Bump for long-context workloads where a single
    # decode legitimately needs > 10 min on a shared engine.
    request_timeout: float = MISSING
    # Transient-failure retries (APITimeout / connection / 5xx) with exponential backoff, forwarded
    # to the backend; 4xx fail fast. Set generously so a rollout rides out an SGLang cold-start / warmup
    # thundering herd instead of abandoning the task — the batch has no per-rollout wall-clock cap, so
    # a truly-dead server still ends after max_retries+1 attempts rather than hanging. 0 disables.
    max_retries: int = MISSING
    # extra SGLang sampling params passed through verbatim as the request `extra_body`
    # (e.g. ["repetition_penalty=1.05"] to break thinking-model repeat loops); [] = none.
    # A token list, not a mapping: the key space belongs to the server, so the keys stay values
    # (see :func:`parse_kv_list`) rather than becoming config keys nothing could register.
    extra_body: list[str] = MISSING
    input_price: float = MISSING
    output_price: float = MISSING


# One layer of a ModelConfig: every field, none of them required — what a profile's
# `model_overrides` states (see HarnessProfileConfig). Only the fields the layer sets reach
# `dataclasses.replace`, via `slimconfig.stated`.
ModelPart = partial_of(ModelConfig, name="ModelPart")


@dataclass
class AgentConfig(Config):
    """How to drive the agent loop."""

    system_prompt: str = MISSING
    # Max model turns per task (one human input / one `run_task`). A "turn" is one model call,
    # which may emit several tool calls at once — so this caps turns, not tool-call count. The
    # budget is per task: each new prompt / follow-up resets it (conversation history carries
    # over, the budget does not). Hitting it stops the task with stop_reason="max_steps_reached".
    max_steps: int = MISSING
    # Stop a task once accumulated cost ($) reaches this; null = no cap.
    cost_limit: float | None = MISSING
    # Stop a rollout once accumulated total_tokens reaches this; null = no cap. Read uniformly
    # by Agent.run, so the batch driver and the `run` / `chat` sessions honor it identically.
    # Required (set null for no cap).
    token_limit: int | None = MISSING
    # Context-window budget (tokens) enabling automatic mid-run compaction; null = disabled. When
    # set, the loop summarizes older turns once a reply's prompt_tokens crosses 80% of this,
    # keeping the system prompt and the most recent exchange (see nanoagent.core.agent.compact_messages).
    # Required (set null to disable).
    context_window: int | None = MISSING
    # Lifecycle hooks, as hook-config YAML paths (each naming a `code:` module; see
    # :func:`~nanoagent.extensions.get_hooks`). They can inject a reminder before a model turn or
    # refuse a tool call, which is how a rule the system prompt merely asks for becomes one the
    # harness enforces. [] = none, and then the loop makes no hook call at all.
    hooks: list[str] = MISSING
    # Directory of skills — `<skills_dir>/<name>/SKILL.md` (see :mod:`nanoagent.tools.skill`). Their
    # one-line descriptions are appended to the system prompt and a `skill` tool fetches a body on
    # demand, so N skills cost ~N lines of context instead of N documents. null = no skills.
    skills: str | None = MISSING
    # Project context files (AGENTS.md / CLAUDE.md ...) appended to the system prompt, in order.
    # A sibling `<name>.override.md` REPLACES its file rather than adding to it. [] = none.
    context_files: list[str] = MISSING
    # NDJSON event stream: one line per streamed fragment / step / tool call / run end, for a UI
    # or a log tailer to consume live (see :mod:`nanoagent.execution.events`). null = don't write one.
    events: str | None = MISSING

    def __post_init__(self) -> None:
        # max_steps caps the rollout loop's turns; a non-positive value makes the loop
        # `for _step in range(max_steps)` empty, so the model is never queried and the task
        # returns a degenerate empty answer -- always a config error. Guard on a concrete int
        # only: the MISSING sentinel ("???") default must survive schema construction
        # (OmegaConf.structured / RunConfig() build this with max_steps == "???"), and an unset
        # max_steps is caught later by load_config's _missing_fields.
        if isinstance(self.max_steps, int) and self.max_steps < 1:
            raise ValueError(f"max_steps must be >= 1, got {self.max_steps}")
        # A non-positive cost/token cap short-circuits Agent.run's top-of-loop `cost >= cost_limit` / `tokens >= token_limit`
        # check on step 0 (0.0 >= 0.0 -> True), so the model is never queried and the rollout
        # scores zero with an empty answer -- always a config error, never an intended "no cap"
        # (that is null). Same concrete-numeric-only guard as max_steps: cost_limit defaults to
        # the MISSING sentinel ("???", a str) and token_limit to None, both of which must survive
        # schema construction; a real value reaches here via load_config's to_object.
        if isinstance(self.cost_limit, (int, float)) and self.cost_limit <= 0:
            raise ValueError(f"cost_limit must be > 0 or null, got {self.cost_limit}")
        if isinstance(self.token_limit, int) and self.token_limit <= 0:
            raise ValueError(f"token_limit must be > 0 or null, got {self.token_limit}")


@dataclass
class AgentDefinitionConfig(Config):
    """Everything required to build an agent, independent of how a caller drives it."""

    model: ModelConfig = field(default_factory=ModelConfig)
    agent: AgentConfig = field(default_factory=AgentConfig)
    # The agent's toolset, as tool-config YAML paths. Each path is a per-tool YAML naming a
    # `code:` module; see :func:`~nanoagent.extensions.get_tools`. The list *is* the toolset — add or
    # drop a path to change what the agent has; [] for none.
    tools: list[str] = MISSING
    # Where the agent may WRITE new tools, and where its previously-written ones are loaded from
    # at startup (see :mod:`nanoagent.tools.write`). Distinct from `tools` because those are the
    # toolset a human chose; this is the one the agent extends. null = it cannot extend itself.
    tools_dir: str | None = MISSING
    # Narrow the assembled toolset to these tool NAMES (`bash`, `read`, ... — not YAML paths; one
    # YAML can define several tools). Distinct from `tools` because that says which modules to
    # load and this says which of their tools this run may use, which is what a caller wanting
    # "the usual harness, read-only" is actually asking for. null = every tool it loaded.
    allowed_tools: list[str] | None = MISSING


@dataclass
class HarnessConfig(Config):
    """Select the agent implementation behind NanoAgent's stable run API."""

    type: str = MISSING
    # null uses the adapter's default executable. A list is executed directly, never by a shell.
    command: list[str] | None = MISSING
    cwd: str | None = MISSING
    # Adapter-owned, server-side settings. They are never accepted from a run request.
    # A token list, not a mapping: the key space belongs to the adapter (see :func:`parse_kv_list`).
    options: list[str] = MISSING

    def __post_init__(self) -> None:
        if self.type not in {
            MISSING,
            "nanoagent",
            "hermes",
            "pi",
            "codex",
            "claude",
            "custom",
        }:
            raise ValueError(
                "harness.type must be nanoagent, hermes, pi, codex, claude, or custom; "
                f"got {self.type!r}"
            )
        if isinstance(self.command, list) and (
            not self.command or any(not isinstance(part, str) or not part for part in self.command)
        ):
            raise ValueError("harness.command must be null or a non-empty list of strings")
        if self.type == "nanoagent" and self.command is not None:
            raise ValueError("harness.command must be null for the NanoAgent harness")
        if self.type == "custom" and not isinstance(self.command, list):
            raise ValueError("harness.command must be set for a custom harness")


@dataclass
class HarnessProfileConfig(Config):
    """One server-approved harness/model combination exposed to API clients."""

    label: str = MISSING
    model: str = MISSING
    harness: HarnessConfig = field(default_factory=HarnessConfig)
    # NanoAgent profiles may override ModelConfig fields such as base_url or temperature: a layer
    # stating only what changes (`model_overrides > nanoagent.runtime.config.ModelPart:`), so an
    # unknown override key fails at load instead of reaching `dataclasses.replace`. A bare key
    # (no values under it) states nothing. Never the model name — `model` owns that.
    model_overrides: ModelPart = field(default_factory=ModelPart)  # type: ignore[valid-type]

    def __post_init__(self) -> None:
        if isinstance(self.label, str) and not self.label.strip():
            raise ValueError("profile label must be non-empty")
        if isinstance(self.model, str) and not self.model.strip():
            raise ValueError("profile model must be non-empty")
        if self.harness.type not in {MISSING, "nanoagent"} and stated(self.model_overrides):
            raise ValueError("model_overrides are only valid for NanoAgent harness profiles")


@dataclass
class BenchmarkAdapterConfig(Config):
    """How a named benchmark loads cases and scores runner results."""

    type: str = MISSING
    # Python adapters name a module or .py file. Built-in adapters set this to null.
    code: str | None = MISSING
    # Adapter-owned settings (e.g. the jsonl path). A token list, not a mapping: the key space
    # belongs to the adapter (see :func:`parse_kv_list`).
    options: list[str] = MISSING

    def __post_init__(self) -> None:
        if self.type not in {MISSING, "jsonl_exact_match", "swebench", "python"}:
            raise ValueError(
                "benchmark adapter type must be jsonl_exact_match, swebench, or python; "
                f"got {self.type!r}"
            )
        if self.type == "python" and not self.code:
            raise ValueError("python benchmark adapter requires code")
        if self.type in {"jsonl_exact_match", "swebench"} and self.code is not None:
            raise ValueError(f"{self.type} benchmark adapter code must be null")


@dataclass
class BenchmarkDefinitionConfig(Config):
    """One benchmark name in the operator-owned registry."""

    label: str = MISSING
    version: str = MISSING
    primary_metric: str = MISSING
    adapter: BenchmarkAdapterConfig = field(default_factory=BenchmarkAdapterConfig)

    def __post_init__(self) -> None:
        for name in ("label", "version", "primary_metric"):
            value = getattr(self, name)
            if isinstance(value, str) and not value.strip():
                raise ValueError(f"benchmark {name} must be non-empty")


@dataclass
class BenchmarkRunConfig(AgentDefinitionConfig):
    """One named benchmark evaluated with one named LLM+harness profile."""

    # Registry files, each a complete entry config; the id is the file's stem (see
    # :func:`load_registry`). Separate files because the ids are operator-chosen names — data,
    # not fields — and a mapping can only be keyed by registered names.
    profiles: list[str] = MISSING
    benchmarks: list[str] = MISSING
    profile: str = MISSING
    benchmark: str = MISSING
    output: str = MISSING
    concurrency: int = MISSING
    filter: str = MISSING
    slice: str = MISSING
    shuffle: bool = MISSING
    redo: bool = MISSING
    timeout: float | None = MISSING

    def __post_init__(self) -> None:
        _check_concurrency(self.concurrency, what="benchmark concurrency")
        _check_timeout(self.timeout, what="benchmark timeout")
        if isinstance(self.output, str) and not self.output.strip():
            raise ValueError("benchmark output must be non-empty")
        # `profile` / `benchmark` membership is checked where the registries load (the files are
        # only read there); an unknown selection names the ids that are configured.


@dataclass
class RunConfig(AgentDefinitionConfig):
    """An agent definition plus what a CLI run should execute and persist."""

    # the task to run; null selects batch mode (see BatchConfig.tasks)
    task: str | None = MISSING
    # Single: required trajectory .json path. Batch: required output directory.
    output: str | None = MISSING


@dataclass
class InteractiveConfig(RunConfig):
    """An interactive ``chat`` session: a :class:`RunConfig` plus the confirm/yolo toggle.

    ``task`` is the optional opening task (null = prompt interactively); ``output`` is the required
    folder where the session trajectory is saved on exit.
    """

    yolo: bool = MISSING  # run tool calls without confirmation
    # A .session.json (branches and all) or a .traj.json (its transcript as the one branch) to
    # carry on from; null starts fresh.
    resume: str | None = MISSING
    commands: list[str] = MISSING  # .md prompt templates: notes/review.md becomes /review
    # What /model can switch to, as ModelConfig YAML paths (see :func:`load_registry`); [] = the
    # primary only. Each file is a complete ModelConfig; its stem is the /model name.
    models: list[str] = MISSING
    # rich styles for the REPL's named colours, keyed by ThemeName; {} = the defaults. A key that
    # is not a member fails at load — previously it silently restyled nothing.
    theme: dict[ThemeName, str] = MISSING
    images: bool = MISSING  # draw an image a tool returns inline, instead of printing its path
    # Optional model–harness profiles. Empty preserves the direct NanoAgent configuration above;
    # otherwise `profile` selects one entry and chat / mgen use the same HarnessRegistry as web
    # and benchmark execution.
    profiles: list[str] = field(default_factory=list)
    profile: str | None = None


@dataclass
class BatchConfig(RunConfig):
    """A batch run: a :class:`RunConfig` plus the tasks file and batch-level knobs.

    Inherits ``model`` / ``agent`` from :class:`RunConfig` so the model block is written
    once. ``tasks`` (a JSONL of ``{task_id, task}``) is what selects batch mode; ``output``
    is the output directory; the inherited ``task`` is unused (leave null). Compose the agent
    harness and the batch knobs with ``harness_cfg=<harness.yaml> batch_cfg=<batch.yaml>``
    (later specs win) — each file declares ``BatchConfig`` and sets the keys it owns.
    """

    tasks: str = MISSING  # JSONL of {task_id, task} rows
    concurrency: int = MISSING
    filter: str = MISSING  # regex on task_id; "" = no filter
    slice: str = MISSING  # "a:b" slice; "" = no slice
    shuffle: bool = MISSING
    redo: bool = MISSING
    timeout: float | None = MISSING  # per-rollout wall-clock cap (s); null = no cap, overrun killed + scored zero (required)

    def __post_init__(self) -> None:
        # Concrete-value-only so the MISSING sentinel ("???") and None survive schema
        # construction; an unset value is caught later by load_config's _missing_fields.
        _check_concurrency(self.concurrency)
        _check_timeout(self.timeout)


@dataclass
class BrowseConfig(Config):
    """The ``browse`` trajectory viewer: just where to look."""

    # a *.traj.json file, or a directory searched recursively for them
    path: str = MISSING


def _ordered_specs(args: list[str]) -> list[Spec]:
    """Split bare ``key=value`` tokens into merge order: ``*_cfg`` files first, then overrides.

    Two token shapes, distinguished by the key:

      * ``<label>_cfg=<path>`` — a config **file** to merge in. The label (e.g.
        ``model_cfg``, ``batch_cfg``) is just a readable name; only ``<path>`` is used, so
        you say exactly which file is which instead of relying on argument order. Every file
        declares the schema it fills (``_ > <dotted.path.To.Schema>:``) and may inherit one
        file of its own (``_default: <path>``).
      * ``<dotted.key>=<value>`` — override one leaf (e.g. ``agent.max_steps=30``).

    Files come first so every override wins; since files normally set disjoint keys, the
    order you list things on the command line never changes the result.
    """
    # list[Spec], not list[str]: slimconfig takes list[Spec] and list is invariant, so the
    # narrower element type would not be assignable even though every element here is a str.
    includes: list[Spec] = []
    overrides: list[Spec] = []
    for tok in args:
        key, sep, val = tok.partition("=")
        if not sep:
            raise ValueError(
                f"expected key=value, got {tok!r} "
                "(config file: <name>_cfg=path.yaml; override: dotted.key=value)"
            )
        if key.endswith("_cfg"):
            includes.append(val)  # a file path; merged before overrides
        else:
            overrides.append(tok)
    return includes + overrides


def load_config_args(schema: type[T], args: list[str]) -> T:
    """Build ``schema`` from bare ``key=value`` CLI tokens — order-independent.

    See :func:`_ordered_specs` for the two token shapes (``*_cfg=path.yaml`` files and
    ``dotted.key=value`` overrides).
    """
    return load_config(schema, _ordered_specs(args))


def peek(args: list[str], key: str) -> Any:
    """Return top-level ``key`` from the merged tokens (or ``None``), without validation.

    Lets a CLI pick a schema *before* strict structured loading — e.g. ``run`` treats a
    set ``tasks`` as "batch mode". Unknown keys are tolerated here (no struct check). Thin
    wrapper over :func:`slimconfig.peek` that first puts the bare CLI tokens in merge order.
    """
    return _peek(_ordered_specs(args), key)
