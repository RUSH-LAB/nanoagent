"""Typed, OmegaConf-backed structured run configuration.

A run is described by :class:`RunConfig`, which nests :class:`ModelConfig` (how to reach the
model — SGLang served name, endpoint, sampling, prices) and :class:`AgentConfig` (how to drive
the loop — system prompt, step/cost limits), plus ``tools`` (the toolset, as tool-config YAML
paths; see :func:`~nanoagent.extensions.get_tools`) and ``task`` / ``output`` for what to run and
where to write it. :class:`InteractiveConfig` and :class:`BatchConfig` extend it for the
``chat`` and batch ``run`` modes; :class:`BrowseConfig` is a standalone schema for the
``browse`` viewer. Everything is yaml-driven — the CLIs take no argparse flags, only
``key=value`` tokens (see :func:`load_config_args`), so all knobs live in the YAML.

A YAML (plus optional dotted ``key=value`` overrides) is merged onto the structured
schema by :func:`load_config`. Two rules, enforced recursively at load time:

  * NO field has a default — every leaf is ``MISSING`` and must be set explicitly in the YAML
    (a config fully specifies the run; nothing is silently filled in). An unset leaf raises; a
    nullable field that is "off" must still be present, set to ``null`` (e.g. ``cost_limit: null``),
    and an empty collection must be written out (e.g. ``tools: []``);
  * unknown keys are rejected (OmegaConf struct mode).

CLI entry points pass ``["<file>.yaml", "agent.max_steps=30", ...]``; later specs win.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, TypeVar

from omegaconf import MISSING
# The loader itself is slimconfig (github.com/zeyuyang8/slimconfig), the extracted standalone
# package this repo's copy grew into: `load_config` merges specs onto a schema with the two rules
# documented above, and `peek` reads one key before a schema is chosen. Re-exported under their own
# names here, so `from nanoagent.runtime.config import load_config` keeps working.
from slimconfig import Spec, load_config, peek as _peek

T = TypeVar("T")


@dataclass
class ModelConfig:
    """How to reach one model — an SGLang ``/v1`` endpoint.

    nanoagent supports a single transport, ``backend: "sglang"`` (see
    :meth:`~nanoagent.runtime.model.Model.from_config`): the OpenAI SDK against ``base_url`` (an SGLang
    ``/v1`` endpoint), using ``model`` (the served name) and ``extra_body``.

    Every field is required (no defaults — a config must set each one explicitly); ``Optional``
    fields may be ``null`` but must still be present. That all-required contract is the ONLY
    reason this is not just :class:`~nanoagent.inference.config.LeanInferConfig`: the fields are a strict subset of
    it, by the same names, so :meth:`~nanoagent.runtime.model.Model.from_config` translates by field-name
    projection (pinned by ``tests/test_model_config_projection.py``).
    """

    model: str = MISSING
    # transport: the built-in "sglang" (OpenAI SDK over base_url), or the name of a
    # backend plugin — see nanoagent.inference.plugins.
    backend: str = MISSING
    # SGLang endpoint.
    base_url: str | None = MISSING
    # OpenAI-style key passed through to the backend; the sglang backend ignores it (SGLang
    # accepts any key). May be null, but must be present.
    api_key: str | None = MISSING
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
    # (e.g. {repetition_penalty: 1.05} to break thinking-model repeat loops); {} = none.
    extra_body: dict[str, Any] = MISSING
    input_price: float = MISSING
    output_price: float = MISSING


@dataclass
class AgentConfig:
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
    # or a log tailer to consume live (see :mod:`nanoagent.runtime.events`). null = don't write one.
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
class AgentDefinitionConfig:
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
class HarnessConfig:
    """Select the agent implementation behind NanoAgent's stable run API."""

    type: str = MISSING
    # null uses the adapter's default executable. A list is executed directly, never by a shell.
    command: list[str] | None = MISSING
    cwd: str | None = MISSING
    # Adapter-owned, server-side settings. They are never accepted from a run request.
    options: dict[str, Any] = MISSING

    def __post_init__(self) -> None:
        if self.type not in {MISSING, "native", "hermes", "pi"}:
            raise ValueError(f"harness.type must be native, hermes, or pi; got {self.type!r}")
        if isinstance(self.command, list) and (
            not self.command or any(not isinstance(part, str) or not part for part in self.command)
        ):
            raise ValueError("harness.command must be null or a non-empty list of strings")
        if self.type == "native" and self.command is not None:
            raise ValueError("harness.command must be null for the native harness")


@dataclass
class HarnessProfileConfig:
    """One server-approved harness/model combination exposed to API clients."""

    label: str = MISSING
    model: str = MISSING
    harness: HarnessConfig = field(default_factory=HarnessConfig)
    # Native profiles may override ModelConfig fields such as base_url or temperature.
    model_overrides: dict[str, Any] = MISSING

    def __post_init__(self) -> None:
        if isinstance(self.label, str) and not self.label.strip():
            raise ValueError("profile label must be non-empty")
        if isinstance(self.model, str) and not self.model.strip():
            raise ValueError("profile model must be non-empty")
        if (
            self.harness.type not in {MISSING, "native"}
            and isinstance(self.model_overrides, dict)
            and self.model_overrides
        ):
            raise ValueError("model_overrides are only valid for native harness profiles")


@dataclass
class RunConfig(AgentDefinitionConfig):
    """An agent definition plus what a CLI run should execute and persist."""

    # the task to run; null selects batch mode (see BatchConfig.tasks)
    task: str | None = MISSING
    # single: trajectory .json (null = a timestamped file under expdir/run/); batch: output dir
    output: str | None = MISSING


@dataclass
class InteractiveConfig(RunConfig):
    """An interactive ``chat`` session: a :class:`RunConfig` plus the confirm/yolo toggle.

    ``task`` is the optional opening task (null = prompt interactively); ``output`` is the FOLDER
    the session trajectory is saved into on exit, named ``<yymmdd-hhmmss>.traj.json`` by the time
    the chat started (null = the default folder ``expdir/chat/``).
    """

    yolo: bool = MISSING  # run tool calls without confirmation
    # A .session.json (branches and all) or a .traj.json (its transcript as the one branch) to
    # carry on from; null starts fresh.
    resume: str | None = MISSING
    commands: list[str] = MISSING  # .md prompt templates: notes/review.md becomes /review
    models: dict[str, ModelConfig] = MISSING  # what /model can switch to; {} = the primary only
    theme: dict[str, str] = MISSING  # rich styles for the REPL's named colours; {} = the defaults
    images: bool = MISSING  # draw an image a tool returns inline, instead of printing its path


@dataclass
class BatchConfig(RunConfig):
    """A batch run: a :class:`RunConfig` plus the tasks file and batch-level knobs.

    Inherits ``model`` / ``agent`` from :class:`RunConfig` so the model block is written
    once. ``tasks`` (a JSONL of ``{task_id, task}``) is what selects batch mode; ``output``
    is the output directory; the inherited ``task`` is unused (leave null). Compose the agent
    harness and the batch knobs with ``harness_cfg=<harness.yaml> batch_cfg=<batch.yaml>``
    (later specs win).
    """

    tasks: str = MISSING  # JSONL of {task_id, task} rows
    concurrency: int = MISSING
    filter: str = MISSING  # regex on task_id; "" = no filter
    slice: str = MISSING  # "a:b" slice; "" = no slice
    shuffle: bool = MISSING
    redo: bool = MISSING
    timeout: float | None = MISSING  # per-rollout wall-clock cap (s); null = no cap, overrun killed + scored zero (required)

    def __post_init__(self) -> None:
        # concurrency sizes asyncio.Semaphore(concurrency) in run_batch; a value < 1 builds
        # Semaphore(0), which deadlocks the fan-out forever (every `async with semaphore` blocks).
        # Concrete-int-only so the MISSING sentinel ("???") survives schema construction
        # (OmegaConf.structured(BatchConfig) builds it with concurrency == "???"); an unset
        # concurrency is caught later by load_config's _missing_fields.
        if isinstance(self.concurrency, int) and self.concurrency < 1:
            raise ValueError(f"concurrency must be >= 1, got {self.concurrency}")
        # timeout is the per-rollout wall-clock cap, fed to
        # asyncio.wait_for(agent.run(...), timeout) in run_batch. A value <= 0 makes wait_for
        # cancel the rollout before it does any work, silently scoring EVERY task in the batch
        # zero, so a non-positive timeout is always a config error (null = no cap). Concrete-
        # numeric-only so the None default (and the MISSING sentinel) survive schema construction.
        if isinstance(self.timeout, (int, float)) and self.timeout <= 0:
            raise ValueError(f"timeout must be > 0 or null, got {self.timeout}")


@dataclass
class BrowseConfig:
    """The ``browse`` trajectory viewer: just where to look."""

    # a *.traj.json file, or a directory searched recursively for them
    path: str = MISSING


def _ordered_specs(args: list[str]) -> list[Spec]:
    """Split bare ``key=value`` tokens into merge order: ``*_cfg`` files first, then overrides.

    Two token shapes, distinguished by the key:

      * ``<label>_cfg=<path>`` — a config **file** to merge in. The label (e.g.
        ``model_cfg``, ``batch_cfg``) is just a readable name; only ``<path>`` is used, so
        you say exactly which file is which instead of relying on argument order.
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
