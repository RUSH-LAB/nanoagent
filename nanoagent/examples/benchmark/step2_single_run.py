"""Step 2: one run. One harness, on one model, works one case of a plugin's task once; the run pins
the case's right answer, profiles the harness to one standard, and checks its answer with the
plugin's verifier.

The case is one input of a plugin's task, from the cases file, which says whether it is to be
answered or refused. The run unpacks the plugin from the RUSH marketplace's package in the local
RUSH database (helpinghands' `npm run local`, a copy of production's), checked against its SHA-256,
into its own folder, and readies its Python environment: setup, before any clock starts. The task's
manifest decides how the case is pinned and worked (`reference_tool`):
  * an agent or decide task with a reference tool: the reference pins the answer, and NanoAgent works
    the case as RUSH Lab does, the reference pinned, then its agent with the task's tools, which
    submits the task's output, or its decider on the run's model, which chooses every value of it.
  * an agent task with no reference: nothing is pinned, and the verifier judges the output with
    reference None; NanoAgent's agent works it as above.
  * a tool task, which RUSH answers by calling its one tool: its reference tool, or else that one
    tool, pins the answer, and NanoAgent works it as an agent task, its agent given the task's tools
    and submit, not the direct call.
A case to answer the pinning tool cannot answer, or a case to refuse it answers, fails the run; a
case with no tool to pin it is taken as the cases file says. Every other harness
(Claude Code, Codex, Hermes, PI, DeepSeek Harness) gets the case's prompt and its own tools, and
writes its answer to answer.json in its workspace. How each harness starts, and how it reaches each
provider, is the config's `harnesses` table. The plugin's verifier judges the answer against the
pinned one; a case to refuse is right when refused.

The profile is RUSH's dashboard figures, measured alike for every harness:
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
  * CPU seconds: the CPU time the run's processes used while the harness worked, which shows when
    runs side by side (step 3) competed for the machine."""

import asyncio
import base64
import hashlib
import io
import json
import logging
import os
import resource
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback
import uuid
from collections.abc import Iterator
from contextlib import AsyncExitStack, contextmanager, redirect_stderr
from dataclasses import dataclass, field, replace
from enum import Enum
from pathlib import Path
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run, Workspace, build_output, output_schema

from step2_coding_environment import coding_environment, fetch_npm, npm_package_cache

from nanoagent import __version__
from nanoagent.core.agent import AgentResult, StopReason
from nanoagent.harness import Conversation, HarnessProfile
from nanoagent.harness.base import ProgressSink, Runner, RunnerRequest, RunnerResult
from nanoagent.harness.nanoagent import NanoAgentConfig
from nanoagent.harness.subprocess import SubprocessRunner
from nanoagent.llm.openrouter import OpenRouterConfig
from nanoagent.plugin import load_manifest, sandbox
from nanoagent.plugin.install import INSTALL_HOSTS, SYNC, SYNC_TIMEOUT
from nanoagent.plugin.python import PluginPython, plugin_python
from nanoagent.plugin.runtime import call_tool_async
from nanoagent.plugin.tasks import ModelDecider, PinnedReference, TaskNotSubmitted, run_task
from nanoagent.plugin.verifier import Verification, verify_task
from nanoagent.profiler import RunProfile, normalize_usage
from nanoagent.runtime.build import build_agent
from nanoagent.runtime.config import AgentDefinitionConfig
from nanoagent.runtime.model import Model
from nanoagent.trajectory.atif import AtifTrajectory, to_atif

# The marketplace's package of a plugin, one tab-separated line: version, SHA-256, package (base64,
# which Postgres breaks into lines of 76 characters, joined back here).
PACKAGE_QUERY = """select v.version, v.sha256, replace(encode(v.package, 'base64'), E'\\n', '')
from market_plugin p join market_plugin_version v on v.plugin_id = p.id and v.version = p.version
where p.id = :'id'"""


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
    OPENROUTER_API_KEY = "OPENROUTER_API_KEY"


class Option(Enum):
    """The runner options a harness or route may set; every runner also gets the run's model."""

    PROVIDER = "provider"
    API_KEY_ENV = "api_key_env"
    PACKAGE = "package"
    TOOLS = "tools"
    BASE_URL = "base_url"
    LOCAL_PROVIDER = "local_provider"
    SANDBOX = "sandbox"
    MAX_TOKENS = "max_tokens"


@dataclass
class Route(Config):
    """How a harness reaches one provider."""

    options: dict[Option, str | int] = MISSING
    # Variables set to these values, and variables copied from this process's environment by the name
    # given, so a key never lands in the run's config.yaml.
    env: dict[Variable, str] = MISSING
    env_from: dict[Variable, str] = MISSING


@dataclass
class HarnessConfig(Config):
    """A coding harness's runner command, relative to nanoagent/, and its routes."""

    command: list[str] = MISSING
    options: dict[Option, str] = MISSING
    # API-key routes by provider. DSH's direct DeepSeek route is built into its adapter.
    routes: dict[Provider, Route] = MISSING


@dataclass
class NanoAgentLoopConfig(Config):
    harness: NanoAgentConfig = field(default_factory=NanoAgentConfig)
    max_attempts: int = MISSING
    read_timeout: float = MISSING


@dataclass
class Cases(Output):
    """One task of one plugin, and its inputs: to answer, and to refuse."""

    plugin: str
    task: str
    # What a coding agent is told that the task's input does not say: its universe and data source.
    context: str
    answer: list[dict[str, Any]]
    refuse: list[dict[str, Any]]

    def case(self, id: str) -> tuple[dict[str, Any], bool]:
        """The input of case ``id`` (<plugin>-<n>, the inputs to answer first), and whether to refuse it."""
        inputs = [(arguments, False) for arguments in self.answer] + [(arguments, True) for arguments in self.refuse]
        ids = [f"{self.plugin}-{index:02d}" for index in range(1, len(inputs) + 1)]
        if id not in ids:
            raise ValueError(f"{self.plugin}'s cases are {ids[0]} to {ids[-1]}, not {id}")
        return inputs[ids.index(id)]


@dataclass
class SingleRunConfig(Config):
    # The local RUSH database, and the psql that reads its marketplace.
    database: str = MISSING
    psql: str = MISSING
    cases: Cases = MISSING
    case: str = MISSING
    harness: Harness = MISSING
    model: str = MISSING
    # OpenRouter, or null for DSH's direct DeepSeek API-key route.
    provider: Provider | None = MISSING
    # USD per million tokens: input, input read from the provider's cache, and output. The run's cost
    # is its tokens at these prices, the same for every harness (input written to the cache is
    # counted as input).
    input_price: float = MISSING
    cached_input_price: float = MISSING
    output_price: float = MISSING
    # The coding agent's prompt, with {description}, {context}, {arguments}, {input_schema} and
    # {output_schema} and {workspace} filled in for the case.
    prompt: str = MISSING
    # Seconds the harness, and the reference tool, may take before the run fails.
    timeout: float = MISSING
    nanoagent: NanoAgentLoopConfig = field(default_factory=NanoAgentLoopConfig)
    harnesses: dict[Harness, HarnessConfig] = MISSING
    # Where Step 3 warmed the pinned npm packages, if it started this attempt.
    batch_runs: str | None = None


@dataclass
class Case:
    id: str
    # The plugin's folder, its agent task and the case's input.
    plugin: str
    task: str
    arguments: dict[str, Any]
    prompt: str


@dataclass
class SingleRun(Output):
    harness: str
    model: str
    provider: str | None
    plugin: str
    task: str
    plugin_version: str
    case: str
    arguments: dict[str, Any]
    # answer, or refuse: what the right outcome of the case is; and whether the harness's was right,
    # with the verifier's word on its answer.
    expected: str
    correct: bool
    verdict: str
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
    generation_seconds: float | None
    # RUSH's own work around NanoAgent's agent: pinning the reference before it, checking the output
    # after it (null for other harnesses, and for a part that did not run).
    reference_seconds: float | None
    check_seconds: float | None
    cpu_seconds: float
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
    # The right answer, as the reference tool pinned it; null for a case to refuse.
    reference: dict[str, Any] | None
    # The harness's standard profile: every step's model calls and tool calls, on its own clock.
    profile: dict[str, Any]
    # What the harness reports of itself (its cost, its own clock); null when it reports nothing.
    reported: dict[str, Any] | None
    # Every progress event but streamed text, stamped with seconds since the harness got its work.
    timeline: list[dict[str, Any]]


@dataclass
class SingleRunLayout(Layout):
    result: SingleRun
    messages: AtifTrajectory
    # The plugin, unpacked from its package; and the harness's own work, whatever files it writes.
    plugin: Workspace
    workspace: Workspace


@dataclass
class Work:
    """What a harness did with the case, before it is put in the standard's terms."""

    seconds: float
    cpu_seconds: float
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
    verification: Verification | None = None


class Timed:
    """``runner`` with its run timed on one outside clock and its progress events stamped on it."""

    def __init__(self, runner: Runner) -> None:
        self.runner = runner
        self.name = runner.name
        self.capabilities = runner.capabilities
        self.result: RunnerResult | None = None
        self.seconds = 0.0
        self.cpu_seconds = 0.0
        self.timeline: list[dict[str, Any]] = []

    async def run(self, request: RunnerRequest, emit: ProgressSink) -> RunnerResult:
        started = time.monotonic()
        used = cpu()

        def stamped(event: dict[str, Any]) -> None:
            if event["type"] != "delta":
                self.timeline.append({"t": time.monotonic() - started, **event})
            emit(event)

        self.result = await self.runner.run(request, stamped)
        self.seconds = time.monotonic() - started
        self.cpu_seconds = cpu() - used
        return self.result

    async def aclose(self) -> None:
        await self.runner.aclose()

    def availability(self) -> tuple[bool, str | None]:
        return self.runner.availability()


async def nanoagent_work(
    config: SingleRunConfig, case: Case, workspace: Path, reference: PinnedReference | None, reference_seconds: float | None
) -> Work:
    """NanoAgent working the case's plugin task as RUSH Lab does; a tool task as an agent task, its
    agent given the task's tools, with the tool that pinned the answer as its reference."""
    if config.provider is not Provider.OPENROUTER:
        raise ValueError(f"NanoAgent runs here on OpenRouter only: provider is {config.provider}")
    manifest = load_manifest(case.plugin)
    task = manifest.task(case.task)
    if task.runner == "tool":
        task = replace(task, runner="agent", reference=reference_tool(task))
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
    marks: dict[str, float] = {}
    result: AgentResult | None = None
    decider: ModelDecider | None = None
    timeline: list[dict[str, Any]] = []

    def start() -> None:
        # The reference is pinned: the agent's, or the decider's, run starts.
        marks["agent"] = time.monotonic()
        marks["agent_cpu"] = cpu()

    def make_decider(system_prompt: str) -> ModelDecider:
        nonlocal decider
        start()
        limits = loop.harness
        decider = ModelDecider(
            Model.from_config(llm.runtime()),
            system_prompt,
            max_steps=limits.max_steps,
            cost_limit=limits.cost_limit,
            token_limit=limits.token_limit,
        )
        return decider

    def make_agent(system_prompt: str):
        start()
        definition = AgentDefinitionConfig(
            model=llm.runtime(), agent=loop.harness.runtime(system_prompt=system_prompt), tools=[], tools_dir=None, allowed_tools=None
        )
        agent = build_agent(definition)
        run = agent.run

        async def kept(*args: Any, **kwargs: Any):
            # The agent's result, kept even when the task then fails for want of a submission.
            nonlocal result
            result = await run(*args, **kwargs)
            return result

        agent.run = kept
        return agent

    def on_event(kind: str, data: dict[str, Any]) -> None:
        now = time.monotonic()
        # The agent's answer, or the decider's output (a decide task has no task.answer): its work is done.
        if kind in {"task.answer", "task.result"} and "answer" not in marks:
            marks["answer"] = now
            marks["answer_cpu"] = cpu()
        if kind in {"task.tool", "task.decision", "task.answer", "task.result", "task.verdict"} and "agent" in marks:
            timeline.append({"t": now - marks["agent"], "type": kind, **({"name": data["name"]} if "name" in data else {})})

    output = refused = error = verification = None
    try:
        outcome = await run_task(
            manifest,
            task,
            case.arguments,
            workspace,
            make_agent=make_agent,
            make_decider=make_decider,
            timeout=config.timeout,
            on_event=on_event,
            stage=lambda _folder: None,
            pinned_reference=reference,
        )
        output = outcome.output
        verification = outcome.verdict
        if task.runner == "decide":
            result = outcome.agent
    except TaskNotSubmitted as failure:
        if result is None:
            raise
        if result.stop_reason is StopReason.ANSWER:
            refused = result.answer.strip() or str(failure)
        elif result.stop_reason is StopReason.ERROR:
            error = result.error or str(failure)
    except Exception as failure:
        # The decider stopped before an output (its limits, a tool it chose failing): its run fails
        # with what it did.
        if decider is None or "answer" in marks:
            raise
        result = replace(decider.record(), stop_reason=StopReason.ERROR, error=f"{type(failure).__name__}: {failure}")
        error = result.error
        marks["answer"] = time.monotonic()
        marks["answer_cpu"] = cpu()
    ended = time.monotonic()
    assert result is not None
    messages = AtifTrajectory.from_dict(
        to_atif(result, session_id=str(uuid.uuid4()), harness="nanoagent", harness_version=__version__, model=config.model)
    )
    return Work(
        seconds=marks["answer"] - marks["agent"],
        cpu_seconds=marks["answer_cpu"] - marks["agent_cpu"],
        profile=result.profile.to_dict(),
        timeline=timeline,
        stop_reason="refused" if refused else result.stop_reason.value,
        answer=result.answer,
        output=output,
        refused=refused,
        error=error,
        messages=messages,
        reference_seconds=reference_seconds,
        check_seconds=ended - marks["answer"] if verification is not None else None,
        verification=verification,
    )


@contextmanager
def other_runner(config: SingleRunConfig, workspace: Path) -> Iterator[SubprocessRunner]:
    """Launch the coding harness inside the benchmark's workspace sandbox."""
    harness = config.harness
    if harness not in config.harnesses:
        raise ValueError(f"the config's harnesses table has no {harness.value}")
    settings = config.harnesses[harness]
    options: dict[str, Any] = {"model": config.model}
    options |= {option.value: value for option, value in settings.options.items()}
    route = None
    credentials: set[str] = set()
    if config.provider is None:
        if Option.PROVIDER in settings.options:
            raise ValueError(f"{harness.value} has a provider option set with provider: null")
        if harness is not Harness.DSH:
            raise ValueError(f"{harness.value} requires a configured API-key provider")
        credentials.add("DEEPSEEK_API_KEY")
        provider = "DeepSeek"
    else:
        provider = config.provider.value
        route = settings.routes.get(config.provider)
        if route is None:
            raise ValueError(f"{harness.value} has no route to {provider} in the config")
        options |= {option.value: value for option, value in route.options.items()}
        if Option.API_KEY_ENV.value in options:
            credentials.add(options[Option.API_KEY_ENV.value])

    required = credentials | (set(route.env_from.values()) if route is not None else set())
    if not required:
        raise ValueError(f"{harness.value} on {provider} requires an API key in its route config")
    missing = sorted(name for name in required if not os.environ.get(name))
    if missing:
        raise ValueError(f"{harness.value} on {provider} needs {', '.join(missing)} set")
    package = options.get(Option.PACKAGE.value)
    cache = npm_package_cache(Path(config.batch_runs), package) if package and config.batch_runs is not None else None
    with coding_environment(workspace, credential_names=credentials, npm_cache=cache) as (prefix, env):
        if package and cache is None:
            fetch_npm(package, prefix, {name: value for name, value in env.items() if name not in credentials}, cwd=workspace)
        if harness is Harness.DSH and Option.SANDBOX.value in options:
            env["DSH_PERMISSION_MODE"] = options.pop(Option.SANDBOX.value)
        if route is not None:
            env |= {variable.value: value for variable, value in route.env.items()}
            env |= {variable.value: os.environ[source] for variable, source in route.env_from.items()}
        command = []
        for part in settings.command:
            path = Path(part)
            command.append(str(path.absolute()) if path.parent != Path(".") and path.is_file() else part)
        runner = SubprocessRunner(harness.value, command, cwd=workspace, options=options, launch_prefix=prefix, env=env)
        available, reason = runner.availability()
        if not available:
            raise RuntimeError(reason)
        yield runner


def read_answer(workspace: Path) -> tuple[dict[str, Any] | None, str | None, str | None]:
    """The output, refusal or failure a coding agent's answer.json gives."""
    try:
        fd = os.open(workspace / "answer.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None, None, "wrote no answer.json"
    except OSError as error:
        return None, None, f"cannot open answer.json: {error.strerror}"
    try:
        with os.fdopen(fd, encoding="utf-8") as answer:
            if not stat.S_ISREG(os.fstat(answer.fileno()).st_mode):
                return None, None, "answer.json is not a regular file"
            value = json.load(answer)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        return None, None, f"answer.json is not UTF-8 JSON: {error}"
    if not isinstance(value, dict):
        return None, None, "answer.json is not a JSON object"
    if set(value) == {"refused"}:
        reason = value["refused"]
        if not isinstance(reason, str) or not reason.strip():
            return None, None, 'answer.json needs a nonempty refusal reason'
        return None, reason, None
    return value, None, None


async def other_work(config: SingleRunConfig, case: Case, workspace: Path) -> Work:
    """A coding harness given the case's prompt, answering in answer.json."""
    async with AsyncExitStack() as stack:
        runner = stack.enter_context(other_runner(config, workspace))
        timed = Timed(runner)
        stack.push_async_callback(timed.aclose)
        chat = Conversation.start(
            HarnessProfile(id=config.harness.value, label=config.harness.value, harness=config.harness.value, model=config.model, runner=timed),
            instructions="",
            system_prompt="",
            workspace=workspace,
            render=False,
        )
        used = cpu()
        try:
            await asyncio.wait_for(chat.run_task(case.prompt), config.timeout)
        except TimeoutError:
            # The harness's own failure: it fails with what it did in the time it had, the runner's
            # profile unreported, so only the timeline and the conversation so far.
            return Work(
                seconds=config.timeout,
                cpu_seconds=cpu() - used,
                profile=RunProfile(duration_s=config.timeout, usage={}, cost=0.0).to_dict(),
                timeline=timed.timeline,
                stop_reason="timeout",
                answer="",
                output=None,
                refused=None,
                error=f"timed out after {config.timeout:g} s",
                messages=chat.trajectory(),
            )
    result = timed.result
    if result.profile is None:
        raise RuntimeError(f"{config.harness.value}'s runner reports no profile, so the run cannot be profiled")
    output, refused, failure = read_answer(workspace) if result.error is None else (None, None, None)
    return Work(
        seconds=timed.seconds,
        cpu_seconds=timed.cpu_seconds,
        profile=dict(result.profile),
        timeline=timed.timeline,
        stop_reason=result.stop_reason,
        answer=result.answer,
        output=output,
        refused=refused,
        error=result.error or failure,
        messages=chat.trajectory(),
    )


def unpack(database: str, psql: str, plugin: str, folder: Path) -> str:
    """Unpack the marketplace package of ``plugin`` into ``folder`` after checking its SHA-256."""
    found = subprocess.run(
        [psql, database, "--no-psqlrc", "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-v", f"id={plugin}"],
        input=PACKAGE_QUERY,
        capture_output=True,
        text=True,
    )
    if found.returncode != 0:
        raise RuntimeError(f"psql could not read {plugin} from {database}: {found.stderr.strip()}")
    rows = [line for line in found.stdout.splitlines() if line]
    if len(rows) != 1:
        raise RuntimeError(f"the marketplace has {len(rows)} packages of {plugin}, not one")
    version, sha256, encoded = rows[0].split("\t")
    package = base64.b64decode(encoded)
    if hashlib.sha256(package).hexdigest() != sha256:
        raise RuntimeError(f"{plugin} {version}'s package does not match the SHA-256 the marketplace recorded")
    with tarfile.open(fileobj=io.BytesIO(package), mode="r:gz") as archive:
        tops = {Path(member.name).parts[0] for member in archive.getmembers()}
        if tops != {plugin}:
            raise RuntimeError(f"{plugin}'s package holds {sorted(tops)}, not the one folder {plugin}")
        archive.extractall(folder, filter="data")
    return version


def isolate() -> PluginPython:
    """Configure the sandbox plugin tools run in, on this platform; the Python they run on."""
    kind = {"darwin": "seatbelt", "linux": "bwrap"}.get(sys.platform)
    if kind is None:
        raise RuntimeError(f"benchmark isolation is unsupported on {sys.platform}")
    python = plugin_python(sys.executable)
    if kind == "bwrap" and Path(sys._base_executable).parent.parent.is_symlink() and "UV_PYTHON_INSTALL_DIR" not in os.environ:
        # uv-managed venvs may use a version alias as well as the resolved runtime prefix.
        managed = Path(subprocess.check_output(["uv", "python", "dir"], text=True).strip())
        if python.prefix.is_relative_to(managed):
            os.environ["UV_PYTHON_INSTALL_DIR"] = str(managed)
    sandbox.configure(kind, python)
    return python


@contextmanager
def prepared_plugin(source: Path, python: PluginPython) -> Iterator[Path]:
    """Install outside the checkout so uv cannot discover the benchmark's parent project."""
    with tempfile.TemporaryDirectory(prefix="nanoagent-benchmark-plugin-") as directory:
        root = Path(directory).resolve() / source.name
        shutil.copytree(source, root, symlinks=True)
        sync = [*SYNC, "--python", str(python.executable), "--quiet"]
        with sandbox.launch(sync, root=root, env={}, writable=[root], hosts=INSTALL_HOSTS) as (argv, env):
            subprocess.run(argv, cwd=root, env=env, check=True, timeout=SYNC_TIMEOUT)
        yield root


def reference_tool(task) -> str | None:
    """The tool that pins the task's right answer, as its manifest says: its reference tool; for a
    tool task without one, its one tool, whose output RUSH gives; None for an agent task without one,
    which its verifier judges with reference None."""
    if task.reference is not None:
        return task.reference
    match task.runner:
        case "tool":
            [tool] = task.tools
            return tool
        case "agent":
            return None
    raise ValueError(f"task {task.id!r}: the benchmark cannot pin a {task.runner} task without a reference tool")


async def pin(manifest, tool: str | None, arguments: dict[str, Any], refuse: bool, timeout: float) -> dict[str, Any] | None:
    """``tool``'s answer to a case to answer; None for a case to refuse, which it refuses, and for a
    task with no tool to pin it."""
    if tool is None:
        return None
    with tempfile.TemporaryDirectory() as scratch:
        try:
            output = await call_tool_async(manifest, tool, arguments, workspace=Path(scratch), timeout=timeout)
        except RuntimeError as error:
            if refuse and f"{manifest.id} {tool} failed:" in str(error):
                return None
            raise RuntimeError(f"{tool} could not answer {json.dumps(arguments)}, a case to answer: {error}") from error
    if refuse:
        raise RuntimeError(f"{tool} answered {json.dumps(arguments)}, a case to refuse")
    return output


def judge(manifest, task, case: Case, work: Work, reference: dict[str, Any] | None, refuse: bool, workspace: Path) -> tuple[bool, str]:
    """Whether the harness's outcome was right, and why."""
    if work.error is not None:
        return False, work.error
    if refuse:
        return (True, f"refused: {work.refused}") if work.refused else (False, "did not refuse a case to refuse")
    if work.refused:
        return False, f"refused a case to answer: {work.refused}"
    if work.output is None:
        return False, "did not submit an answer"
    verdict = work.verification
    if verdict is None:
        try:
            build_output(work.output, task.output_type)
        except (TypeError, ValueError) as error:
            return False, f"invalid answer: {error}"
        verdict = verify_task(manifest, task.id, case.arguments, work.output, reference, workspace)
    return verdict.valid, verdict.message


@contextmanager
def logged():
    """Everything a step writes into its run.log, as slimconfig puts its stdout there: stderr, every
    logged warning and, when the step fails, its traceback."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    logging.getLogger().addHandler(handler)
    try:
        with redirect_stderr(sys.stdout):
            try:
                yield
            except BaseException:
                traceback.print_exc()
                raise
    finally:
        logging.getLogger().removeHandler(handler)


def cpu() -> float:
    """CPU seconds this process and its ended children have used."""
    own, children = resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN)
    return own.ru_utime + own.ru_stime + children.ru_utime + children.ru_stime


class SingleRunner(Run):
    """Pin the case's answer, run the harness on it, profile it and judge its answer."""

    config: SingleRunConfig
    layout: SingleRunLayout

    def main(self) -> int:
        with logged():
            return self.work()

    def work(self) -> int:
        config = self.config
        arguments, refuse = config.cases.case(config.case)
        python = isolate()
        version = unpack(config.database, config.psql, config.cases.plugin, Path(self.layout.plugin))
        with prepared_plugin(Path(self.layout.plugin, config.cases.plugin), python) as folder:
            return self.run_case(folder, version, arguments, refuse)

    def run_case(self, folder: Path, version: str, arguments: dict[str, Any], refuse: bool) -> int:
        config = self.config
        manifest = load_manifest(folder)
        task = manifest.task(config.cases.task)
        tool = reference_tool(task)
        pin_started = time.monotonic()
        reference = asyncio.run(pin(manifest, tool, arguments, refuse, config.timeout))
        reference_seconds = None if tool is None else time.monotonic() - pin_started
        # NanoAgent is given no pinned answer when no tool pins a case to answer.
        pinned = None if tool is None and not refuse else PinnedReference(reference)
        workspace = Path(self.layout.workspace).resolve()
        case = Case(
            id=config.case,
            plugin=str(folder),
            task=task.id,
            arguments=arguments,
            prompt=config.prompt.format(
                description=task.description,
                context=config.cases.context.strip(),
                arguments=json.dumps(arguments, indent=2),
                input_schema=json.dumps(output_schema(task.input_type), indent=2),
                output_schema=json.dumps(output_schema(task.output_type), indent=2),
                workspace=workspace,
            ),
        )
        if config.harness is Harness.NANOAGENT:
            work = asyncio.run(nanoagent_work(config, case, workspace, pinned, reference_seconds))
        else:
            work = asyncio.run(other_work(config, case, workspace))
        correct, verdict = judge(manifest, task, case, work, reference, refuse, workspace)
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
        self.layout.result = run = SingleRun(
            harness=config.harness.value,
            model=config.model,
            provider=None if config.provider is None else config.provider.value,
            plugin=config.cases.plugin,
            task=task.id,
            plugin_version=version,
            case=case.id,
            arguments=arguments,
            expected="refuse" if refuse else "answer",
            correct=correct,
            verdict=verdict,
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
            cpu_seconds=work.cpu_seconds,
            steps=len(steps),
            model_calls=sum(len(step["model_calls"]) for step in steps),
            tool_calls=sum(len(step["tool_calls"]) for step in steps),
            stop_reason=work.stop_reason,
            answer=work.answer,
            output=work.output,
            refused=work.refused,
            error=work.error,
            reference=reference,
            profile=own,
            reported=reported,
            timeline=work.timeline,
        )
        self.layout.messages = work.messages
        print(
            f"{run.harness} · {run.case}: {'right' if run.correct else 'wrong'} · latency {run.latency_seconds:.1f}s"
            f" · model {run.model_seconds:.1f}s · tools {run.tools_seconds:.1f}s · overhead {run.overhead_seconds:.1f}s"
            f" · {run.input_tokens:,} in / {run.output_tokens:,} out · ${run.cost:.4f} · cpu {run.cpu_seconds:.1f}s"
        )
        if not run.correct:
            print(f"{run.harness} · {run.case}: {run.verdict}")
        # A failed run keeps its result, and fails.
        return 1 if run.error else 0


if __name__ == "__main__":
    SingleRunner().run()
