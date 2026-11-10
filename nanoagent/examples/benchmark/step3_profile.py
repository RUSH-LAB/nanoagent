"""Step 3: one harness run once on one case of step 2, and profiled to one standard.

NanoAgent works the case as RUSH Lab does: the task's reference pinned, then its agent with the
plugin's tools, which ends by submitting the task's output. Every other harness (Claude Code, Codex,
Hermes, PI, DeepSeek Harness) gets the case's prompt and its own tools, and writes its answer to
answer.json in its workspace. How each harness starts, and how it reaches each provider, is the
config's `harnesses` table.

The standard is RUSH's dashboard figures, measured alike for every harness:
  * End-to-End Latency: this process's clock, from giving the harness its work to having its answer.
    For NanoAgent that is its agent's run; pinning the reference before it and checking the output
    after it are RUSH's own work, kept apart as reference_seconds and check_seconds.
  * Model Time: the time a model call is in flight. Tool Time: the time at least one tool runs, so
    tools running together count once. Overhead: the rest of the latency (starting the harness, its
    own work, the relay). These come from the harness's standard profile (nanoagent.profiler's
    RunProfile: each step's model calls and tool calls), which NanoAgent records itself and every
    other harness's runner records from the harness's events. A harness whose runner reports no such
    profile fails the run.
  * Input Tokens: every token sent to the model, cached or not (cache reads and writes broken out).
    Output Tokens: every token generated (reasoning broken out). Both as the harness accounts them,
    calls it makes outside its steps included.
  * Cost: those tokens at the config's prices, alike for every harness; the harness's own figures
    (its cost, and its own clock where it has one) are kept as `reported`.
Whether the answer is right is step 4's."""

import asyncio
import json
import os
import time
import uuid
from contextlib import AsyncExitStack, contextmanager
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run, Workspace

from nanoagent import __version__
from nanoagent.harness import Conversation, HarnessProfile
from nanoagent.harness.base import ProgressSink, Runner, RunnerRequest, RunnerResult
from nanoagent.harness.nanoagent import NanoAgentConfig
from nanoagent.harness.subprocess import SubprocessRunner
from nanoagent.llm.openrouter import OpenRouterConfig
from nanoagent.plugin import load_manifest
from nanoagent.plugin.manifest import SUBMIT
from nanoagent.plugin.tasks import run_task
from nanoagent.profiler import RunProfile, normalize_usage
from nanoagent.runtime.build import build_agent
from nanoagent.runtime.config import AgentDefinitionConfig
from nanoagent.trajectory.atif import ATIF_VERSION, AtifTrajectory, to_atif
from step2_cases import Case, Cases


class Harness(Enum):
    NANOAGENT = "nanoagent"
    CLAUDE = "claude"
    CODEX = "codex"
    HERMES = "hermes"
    PI = "pi"
    DSH = "dsh"


class Provider(Enum):
    OPENROUTER = "openrouter"


class Variable(Enum):
    """The environment variables a route may set for its harness."""

    ANTHROPIC_BASE_URL = "ANTHROPIC_BASE_URL"
    ANTHROPIC_AUTH_TOKEN = "ANTHROPIC_AUTH_TOKEN"
    ANTHROPIC_API_KEY = "ANTHROPIC_API_KEY"


class Option(Enum):
    """The runner options a harness or route may set; every runner also gets the run's model."""

    PROVIDER = "provider"
    API_KEY_ENV = "api_key_env"
    PACKAGE = "package"
    TOOLS = "tools"
    BASE_URL = "base_url"
    LOCAL_PROVIDER = "local_provider"


@dataclass
class Route(Config):
    """How a harness reaches one provider."""

    options: dict[Option, str] = MISSING
    # Variables set to these values, and variables copied from this process's environment by the name
    # given, so a key never lands in the run's config.yaml.
    env: dict[Variable, str] = MISSING
    env_from: dict[Variable, str] = MISSING


@dataclass
class HarnessConfig(Config):
    """A harness other than NanoAgent: its runner, run from nanoagent/, and its routes."""

    command: list[str] = MISSING
    options: dict[Option, str] = MISSING
    # A provider without a route here is one the harness does not run on; provider null is its own
    # login, with no route.
    routes: dict[Provider, Route] = MISSING


@dataclass
class NanoAgentLoopConfig(Config):
    harness: NanoAgentConfig = field(default_factory=NanoAgentConfig)
    max_attempts: int = MISSING
    read_timeout: float = MISSING


@dataclass
class ProfileConfig(Config):
    # Step 2's cases, and the one this run works.
    cases: Cases = MISSING
    case: str = MISSING
    harness: Harness = MISSING
    model: str = MISSING
    # openrouter, or null for the harness's own login (NanoAgent runs on openrouter only).
    provider: Provider | None = MISSING
    # USD per million tokens: input, input read from the provider's cache, and output. The run's cost
    # is its tokens at these prices, the same for every harness (input written to the cache is
    # counted as input).
    input_price: float = MISSING
    cached_input_price: float = MISSING
    output_price: float = MISSING
    # Seconds the run may take before it fails.
    timeout: float = MISSING
    nanoagent: NanoAgentLoopConfig = field(default_factory=NanoAgentLoopConfig)
    harnesses: dict[Harness, HarnessConfig] = MISSING


@dataclass
class StandardProfile(Output):
    harness: str
    model: str
    provider: str | None
    case: str
    # RUSH's dashboard figures (see the module's docstring).
    latency_seconds: float
    model_seconds: float
    tools_seconds: float
    overhead_seconds: float
    input_tokens: int
    output_tokens: int
    cost: float
    # Their breakdown: input read from and written to the cache, reasoning within the output; the
    # first token since the harness started (null when it streams none) and the time spent streaming.
    cached_input_tokens: int
    cache_write_tokens: int
    reasoning_tokens: int
    ttft_seconds: float | None
    generation_seconds: float
    # RUSH's own work around NanoAgent's agent: pinning the reference before it, checking the output
    # after it (null for other harnesses, and for a part that did not run).
    reference_seconds: float | None
    check_seconds: float | None
    steps: int
    model_calls: int
    tool_calls: int
    stop_reason: str
    # The harness's last reply, as text.
    answer: str
    # The task's output it gave (NanoAgent's submission, or answer.json); null when it refused or failed.
    output: dict[str, Any] | None
    # Why it refused the case; null when it answered or failed.
    refused: str | None
    # What failed, when it neither answered nor refused.
    error: str | None
    # The harness's standard profile: every step's model calls and tool calls, on its own clock.
    profile: dict[str, Any]
    # What the harness reports of itself (its cost, its own clock); null when it reports nothing.
    reported: dict[str, Any] | None
    # Every progress event but streamed text, stamped with seconds since the harness got its work.
    timeline: list[dict[str, Any]]


@dataclass
class ProfileLayout(Layout):
    profile: StandardProfile
    messages: AtifTrajectory
    # The harness's own work, whatever files it writes (answer.json among them).
    workspace: Workspace


@dataclass
class Work:
    """What a harness did with the case, before it is put in the standard's terms."""

    seconds: float
    profile: dict[str, Any]
    timeline: list[dict[str, Any]]
    stop_reason: str
    answer: str
    output: dict[str, Any] | None
    refused: str | None
    error: str | None
    messages: AtifTrajectory
    reference_seconds: float | None = None
    check_seconds: float | None = None


class Timed:
    """``runner`` with its run timed on one outside clock and its progress events stamped on it."""

    def __init__(self, runner: Runner) -> None:
        self.runner = runner
        self.name = runner.name
        self.capabilities = runner.capabilities
        self.result: RunnerResult | None = None
        self.seconds = 0.0
        self.timeline: list[dict[str, Any]] = []

    async def run(self, request: RunnerRequest, emit: ProgressSink) -> RunnerResult:
        started = time.monotonic()

        def stamped(event: dict[str, Any]) -> None:
            if event["type"] != "delta":
                self.timeline.append({"t": time.monotonic() - started, **event})
            emit(event)

        self.result = await self.runner.run(request, stamped)
        self.seconds = time.monotonic() - started
        return self.result

    async def aclose(self) -> None:
        await self.runner.aclose()

    def availability(self) -> tuple[bool, str | None]:
        return self.runner.availability()


@contextmanager
def environment(values: dict[str, str]):
    """``os.environ`` with ``values`` set, as it was again afterwards."""
    saved = {name: os.environ.get(name) for name in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for name, value in saved.items():
            if value is None:
                del os.environ[name]
            else:
                os.environ[name] = value


async def nanoagent_work(config: ProfileConfig, case: Case, workspace: Path) -> Work:
    """NanoAgent working the case's plugin task as RUSH Lab does."""
    if config.provider is not Provider.OPENROUTER:
        raise ValueError(f"NanoAgent runs here on OpenRouter only: provider is {config.provider}")
    manifest = load_manifest(case.plugin)
    task = manifest.task(case.task)
    loop = config.nanoagent
    llm = OpenRouterConfig(
        model=config.model,
        max_tokens=None,
        temperature=None,
        max_attempts=loop.max_attempts,
        read_timeout=loop.read_timeout,
        input_price=config.input_price,
        output_price=config.output_price,
    )
    started = time.monotonic()
    marks: dict[str, float] = {}
    runs: list[Any] = []
    timeline: list[dict[str, Any]] = []

    def make_agent(system_prompt: str):
        # The reference is pinned: the agent's run starts.
        marks["agent"] = time.monotonic()
        definition = AgentDefinitionConfig(
            model=llm.runtime(), agent=loop.harness.runtime(system_prompt=system_prompt), tools=[], tools_dir=None, allowed_tools=None
        )
        agent = build_agent(definition)
        run = agent.run

        async def kept(*args: Any, **kwargs: Any):
            # The agent's result, kept even when the task then fails for want of a submission.
            runs.append(await run(*args, **kwargs))
            return runs[-1]

        agent.run = kept
        return agent

    def on_event(kind: str, data: dict[str, Any]) -> None:
        now = time.monotonic()
        if kind == "task.answer":
            marks["answer"] = now
        if kind in {"task.tool", "task.answer", "task.result", "task.verdict"} and "agent" in marks:
            timeline.append({"t": now - marks["agent"], "type": kind, **({"name": data["name"]} if "name" in data else {})})

    output = refused = None
    try:
        outcome = await run_task(
            manifest,
            task,
            case.arguments,
            workspace,
            make_agent=make_agent,
            make_decider=None,
            timeout=config.timeout,
            on_event=on_event,
            stage=lambda _folder: None,
        )
        output = outcome.output
    except RuntimeError as error:
        # NanoAgent refuses a case when its reference tool does, before its agent starts, or when its
        # agent ends without submitting.
        refusals = (f"{manifest.id} {task.reference} failed:", f"the agent ended task {task.id!r} without calling {SUBMIT}")
        if not any(refusal in str(error) for refusal in refusals):
            raise
        refused = str(error)
    ended = time.monotonic()
    if not runs:
        # Refused at the reference: the agent never ran, so it has no steps.
        result_profile, answer = RunProfile(duration_s=0.0, usage={}, cost=0.0).to_dict(), ""
        agent = {"name": "nanoagent", "version": __version__, "model_name": config.model}
        metrics = {
            "total_prompt_tokens": 0,
            "total_completion_tokens": 0,
            "total_cached_tokens": 0,
            "total_steps": 0,
            "extra": {"cost": 0.0, "stop_reason": "refused"},
        }
        messages = AtifTrajectory(schema_version=ATIF_VERSION, session_id=str(uuid.uuid4()), agent=agent, steps=[], final_metrics=metrics)
    else:
        result = runs[-1]
        result_profile, answer = result.profile.to_dict(), result.answer
        messages = AtifTrajectory.from_dict(
            to_atif(result, session_id=str(uuid.uuid4()), harness="nanoagent", harness_version=__version__, model=config.model)
        )
    agent_started = marks.get("agent", ended)
    answered = marks.get("answer", ended)
    return Work(
        seconds=answered - agent_started,
        profile=result_profile,
        timeline=timeline,
        stop_reason="refused" if refused else "answer",
        answer=answer,
        output=output,
        refused=refused,
        error=None,
        messages=messages,
        reference_seconds=agent_started - started,
        check_seconds=ended - answered if "answer" in marks else None,
    )


def other_runner(config: ProfileConfig) -> tuple[SubprocessRunner, dict[str, str]]:
    """The harness with only its own tools, and the environment it runs in."""
    if config.harness not in config.harnesses:
        raise ValueError(f"the config's harnesses table has no {config.harness.value}")
    harness = config.harnesses[config.harness]
    options: dict[str, Any] = {"model": config.model} | {option.value: value for option, value in harness.options.items()}
    route: dict[str, str] = {}
    if config.provider is not None:
        if config.provider not in harness.routes:
            raise ValueError(f"{config.harness.value} has no route to {config.provider.value} in the config")
        way = harness.routes[config.provider]
        options |= {option.value: value for option, value in way.options.items()}
        for variable, source in way.env_from.items():
            if source not in os.environ:
                raise ValueError(f"{config.harness.value} on {config.provider.value} needs {source} set")
        route = {variable.value: value for variable, value in way.env.items()}
        route |= {variable.value: os.environ[source] for variable, source in way.env_from.items()}
    runner = SubprocessRunner(config.harness.value, tuple(harness.command), options=options)
    available, reason = runner.availability()
    if not available:
        raise RuntimeError(reason)
    return runner, route


def read_answer(workspace: Path) -> tuple[dict[str, Any] | None, str | None, str | None]:
    """The output, refusal or failure a coding agent's answer.json gives."""
    answer = workspace / "answer.json"
    if not answer.is_file():
        return None, None, "wrote no answer.json"
    try:
        value = json.loads(answer.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return None, None, f"answer.json is not JSON: {error}"
    if not isinstance(value, dict):
        return None, None, "answer.json is not a JSON object"
    if set(value) == {"refused"}:
        return None, str(value["refused"]), None
    return value, None, None


async def other_work(config: ProfileConfig, case: Case, workspace: Path) -> Work:
    """A coding harness given the case's prompt, answering in answer.json."""
    runner, route = other_runner(config)
    async with AsyncExitStack() as stack:
        timed = Timed(runner)
        stack.push_async_callback(timed.aclose)
        chat = Conversation.start(
            HarnessProfile(id=config.harness.value, label=config.harness.value, harness=config.harness.value, model=config.model, runner=timed),
            instructions="",
            system_prompt="",
            workspace=workspace,
            render=False,
        )
        with environment(route):
            await asyncio.wait_for(chat.run_task(case.prompt), config.timeout)
    result = timed.result
    if result.profile is None:
        raise RuntimeError(f"{config.harness.value}'s runner reports no profile, so the run cannot be profiled")
    output, refused, failure = read_answer(workspace) if result.error is None else (None, None, None)
    return Work(
        seconds=timed.seconds,
        profile=dict(result.profile),
        timeline=timed.timeline,
        stop_reason=result.stop_reason,
        answer=result.answer,
        output=output,
        refused=refused,
        error=result.error or failure,
        messages=chat.trajectory(),
    )


class Profile(Run):
    """Run the harness once on the case and profile it."""

    config: ProfileConfig
    layout: ProfileLayout

    def main(self) -> int:
        config = self.config
        cases = {case.id: case for case in config.cases.cases}
        if config.case not in cases:
            raise ValueError(f"step 2 has no case {config.case}: its cases are {sorted(cases)}")
        case = cases[config.case]
        workspace = Path(self.layout.workspace)
        work = asyncio.run(nanoagent_work(config, case, workspace) if config.harness is Harness.NANOAGENT else other_work(config, case, workspace))
        own = dict(work.profile)
        reported = own.pop("reported", None)
        usage = normalize_usage(own["usage"])
        tokens = {
            name: usage.get(name, 0) for name in ("prompt_tokens", "completion_tokens", "cached_tokens", "cache_write_tokens", "reasoning_tokens")
        }
        cost = (
            (tokens["prompt_tokens"] - tokens["cached_tokens"]) * config.input_price
            + tokens["cached_tokens"] * config.cached_input_price
            + tokens["completion_tokens"] * config.output_price
        )
        steps = own["steps"]
        self.layout.profile = run = StandardProfile(
            harness=config.harness.value,
            model=config.model,
            provider=None if config.provider is None else config.provider.value,
            case=case.id,
            latency_seconds=work.seconds,
            model_seconds=own["model_s"],
            tools_seconds=own["tools_s"],
            overhead_seconds=max(0.0, work.seconds - own["model_s"] - own["tools_s"]),
            input_tokens=tokens["prompt_tokens"],
            output_tokens=tokens["completion_tokens"],
            cost=cost / 1e6,
            cached_input_tokens=tokens["cached_tokens"],
            cache_write_tokens=tokens["cache_write_tokens"],
            reasoning_tokens=tokens["reasoning_tokens"],
            ttft_seconds=own["ttft_s"],
            generation_seconds=own["generation_s"],
            reference_seconds=work.reference_seconds,
            check_seconds=work.check_seconds,
            steps=len(steps),
            model_calls=sum(len(step["model_calls"]) for step in steps),
            tool_calls=sum(len(step["tool_calls"]) for step in steps),
            stop_reason=work.stop_reason,
            answer=work.answer,
            output=work.output,
            refused=work.refused,
            error=work.error,
            profile=own,
            reported=reported,
            timeline=work.timeline,
        )
        self.layout.messages = work.messages
        outcome = "refused" if run.refused else "failed" if run.error else "answered"
        print(
            f"{run.harness} · {run.case}: {outcome} · latency {run.latency_seconds:.1f}s"
            f" · model {run.model_seconds:.1f}s · tools {run.tools_seconds:.1f}s · overhead {run.overhead_seconds:.1f}s"
            f" · {run.input_tokens:,} in / {run.output_tokens:,} out · ${run.cost:.4f}"
            f" · {run.steps} steps, {run.tool_calls} tool calls"
        )
        if run.error:
            print(f"{run.harness} failed: {run.error}")
        # A failed run keeps its profile, and fails.
        return 1 if run.error else 0


if __name__ == "__main__":
    Profile().run()
