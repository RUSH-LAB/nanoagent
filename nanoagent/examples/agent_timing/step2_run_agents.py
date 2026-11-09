"""Step 2: every agent works every case of step 1, `repeats` rounds. The agents take turns on each
case, the first in turn changing from case to case, so the network's and the providers' load falls
on them alike. Each attempt is timed by one clock outside every agent, and by the agent's own.

NanoAgent works a case as RUSH Lab does: the plugin task's reference pinned, then its agent with the
plugin's tools. Claude Code gets the case's prompt and its own tools, and writes its answer to
answer.json in its workspace, with its own model or, to compare the two on one model, a model on
OpenRouter."""

import asyncio
import json
import os
import shutil
import sys
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Folder, Layout, Output, Run, build_output, load_layout, plain_output

from nanoagent import __version__
from nanoagent.harness.base import RunnerRequest
from nanoagent.harness.nanoagent import NanoAgentConfig
from nanoagent.harness.subprocess import SubprocessRunner
from nanoagent.llm.openrouter import OpenRouterConfig
from nanoagent.plugin import load_manifest
from nanoagent.plugin.manifest import SUBMIT
from nanoagent.plugin.tasks import run_task
from nanoagent.runtime.build import build_agent
from nanoagent.runtime.config import AgentDefinitionConfig
from nanoagent.trajectory.atif import to_atif
from step1_build_cases import Case, CasesLayout


class System(Enum):
    NANOAGENT = "nanoagent"
    CLAUDE_CODE = "claude-code"
    CLAUDE_CODE_OPENROUTER = "claude-code-openrouter"


# OpenRouter's Anthropic-compatible API, which Claude Code reaches with OPENROUTER_API_KEY.
OPENROUTER_ANTHROPIC_API = "https://openrouter.ai/api"


@dataclass
class NanoAgentSystemConfig(Config):
    llm: OpenRouterConfig = field(default_factory=OpenRouterConfig)
    harness: NanoAgentConfig = field(default_factory=NanoAgentConfig)


@dataclass
class OpenRouterPricesConfig(Config):
    # The model's price per million tokens on OpenRouter; cached input is counted at the full price.
    # Claude Code prices every model as a Claude model, so its cost is counted from its tokens instead.
    input_price: float = MISSING
    output_price: float = MISSING


@dataclass
class ClaudeCodeSystemConfig(Config):
    # Claude Code's --model, or default for the model it picks itself.
    model: str = MISSING
    # The model's OpenRouter prices, when Claude Code's requests go to OpenRouter; null for its own login.
    openrouter: OpenRouterPricesConfig | None = field(default_factory=OpenRouterPricesConfig)


@dataclass
class RunAgentsConfig(Config):
    # Step 1's run folder.
    cases: str = MISSING
    # The ids of the cases to run, or null for every case.
    only: list[str] | None = MISSING
    systems: list[System] = MISSING
    repeats: int = MISSING
    # Seconds an attempt may take before it fails.
    timeout: float = MISSING
    nanoagent: NanoAgentSystemConfig = field(default_factory=NanoAgentSystemConfig)
    claude_code: ClaudeCodeSystemConfig = field(default_factory=ClaudeCodeSystemConfig)
    claude_code_openrouter: ClaudeCodeSystemConfig = field(default_factory=ClaudeCodeSystemConfig)


@dataclass
class Attempt(Output):
    case: str
    system: str
    repeat: int
    # The outside clock: the whole attempt, from launching the agent to having its answer.
    wall_seconds: float
    # The agent working the case by its own clock: NanoAgent's task stage (its reference not
    # included), Claude Code's duration_ms; null when the attempt ended before the agent finished.
    agent_seconds: float | None
    # Of agent_seconds, the time spent waiting on the model's API.
    model_seconds: float | None
    # NanoAgent pinning its own reference before its agent starts; null for Claude Code.
    reference_seconds: float | None
    cost: float
    steps: int
    # The answer, as the agent gave it; null when it refused or failed.
    output: dict[str, Any] | None
    # Why the agent refused the case; null when it answered or failed.
    refused: str | None
    # What failed, when the agent neither answered nor refused.
    error: str | None


@dataclass
class Attempts(Output):
    attempts: list[Attempt]


@dataclass
class RunAgentsLayout(Layout):
    attempts: Attempts
    # Each attempt's own folder, runs/<case>/<system>-<repeat>/: its workspace and what the agent said.
    runs: Folder


async def nanoagent_attempt(config: NanoAgentSystemConfig, case: Case, folder: Path, timeout: float) -> dict[str, Any]:
    manifest = load_manifest(case.plugin)
    task = manifest.task(case.task)

    def make_agent(system_prompt: str):
        definition = AgentDefinitionConfig(
            model=config.llm.runtime(),
            agent=config.harness.runtime(system_prompt=system_prompt),
            tools=[],
            tools_dir=None,
            allowed_tools=None,
        )
        return build_agent(definition)

    workspace = folder / "workspace"
    workspace.mkdir()
    try:
        outcome = await run_task(
            manifest,
            task,
            case.arguments,
            workspace,
            make_agent=make_agent,
            make_decider=None,
            timeout=timeout,
            on_event=lambda kind, data: None,
            stage=lambda _folder: None,
        )
    except RuntimeError as error:
        # NanoAgent refuses a case when its reference tool does, before its agent starts, or when
        # its agent ends without submitting.
        refusals = (f"{manifest.id} {task.reference} failed:", f"the agent ended task {task.id!r} without calling {SUBMIT}")
        if not any(refusal in str(error) for refusal in refusals):
            raise
        return {"refused": str(error)}
    agent = outcome.agent
    trajectory = to_atif(agent, session_id=str(uuid.uuid4()), harness="nanoagent", harness_version=__version__, model=config.llm.model)
    (folder / "messages.json").write_text(json.dumps(trajectory, indent=2), encoding="utf-8")
    return {
        "agent_seconds": outcome.timing.task,
        "model_seconds": agent.profile.model_s if agent.profile is not None else None,
        "reference_seconds": outcome.timing.reference,
        "cost": agent.cost,
        "steps": agent.steps,
        "output": outcome.output,
    }


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


async def claude_code_attempt(config: ClaudeCodeSystemConfig, case: Case, folder: Path) -> dict[str, Any]:
    workspace = folder / "workspace"
    workspace.mkdir()
    # NanoAgent's Claude Code adapter, from the environment this step runs in; it hands Claude Code
    # this process's environment, which points it at OpenRouter for the attempt when asked.
    runner = SubprocessRunner("claude", (str(Path(sys.executable).parent / "nanoagent-claude-runner"),), options={"model": config.model})
    route = (
        {}
        if config.openrouter is None
        else {
            "ANTHROPIC_BASE_URL": OPENROUTER_ANTHROPIC_API,
            "ANTHROPIC_AUTH_TOKEN": os.environ["OPENROUTER_API_KEY"],
            "ANTHROPIC_API_KEY": "",
        }
    )
    with environment(route):
        result = await runner.run(RunnerRequest(input=case.prompt, workspace=str(workspace)), lambda event: None)
    (folder / "reply.txt").write_text(result.answer, encoding="utf-8")
    metrics = result.profile or {}
    if config.openrouter is None:
        cost = result.cost
    else:
        usage = result.usage
        read = usage.get("input_tokens", 0) + usage.get("cache_read_input_tokens", 0) + usage.get("cache_creation_input_tokens", 0)
        cost = (read * config.openrouter.input_price + usage.get("output_tokens", 0) * config.openrouter.output_price) / 1e6
    timing = {
        "agent_seconds": metrics.get("duration_s"),
        "model_seconds": metrics.get("model_s"),
        "cost": cost,
        "steps": result.steps,
    }
    if result.stop_reason == "error":
        return {**timing, "error": f"Claude Code failed: {result.error}"}
    answer = workspace / "answer.json"
    if not answer.is_file():
        return {**timing, "error": "Claude Code wrote no answer.json"}
    try:
        value = json.loads(answer.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return {**timing, "error": f"answer.json is not JSON: {error}"}
    if isinstance(value, dict) and set(value) == {"refused"}:
        return {**timing, "refused": str(value["refused"])}
    if not isinstance(value, dict):
        return {**timing, "error": "answer.json is not a JSON object"}
    return {**timing, "output": value}


def attempt(config: RunAgentsConfig, system: System, case: Case, repeat: int, folder: Path) -> Attempt:
    kept = folder / "attempt.json"
    # A run started again in the same folder keeps every attempt that ended, and works again the
    # one it was stopped in.
    if kept.is_file():
        return build_output(json.loads(kept.read_text(encoding="utf-8")), Attempt)
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    work = (
        nanoagent_attempt(config.nanoagent, case, folder, config.timeout)
        if system is System.NANOAGENT
        else claude_code_attempt(config.claude_code if system is System.CLAUDE_CODE else config.claude_code_openrouter, case, folder)
    )
    started = time.monotonic()
    try:
        found = asyncio.run(asyncio.wait_for(work, config.timeout))
    except TimeoutError:
        found = {"error": f"timed out after {config.timeout:.0f}s"}
    except Exception as error:
        # A failed attempt is a result, counted against its agent; the run goes on to the next.
        found = {"error": f"{type(error).__name__}: {error}"}
    wall = time.monotonic() - started
    values = {
        "agent_seconds": None,
        "model_seconds": None,
        "reference_seconds": None,
        "cost": 0.0,
        "steps": 0,
        "output": None,
        "refused": None,
        "error": None,
        **found,
    }
    made = Attempt(case=case.id, system=system.value, repeat=repeat, wall_seconds=wall, **values)
    # Each attempt is kept as it ends, so a run that stops part way loses none before it.
    kept.write_text(json.dumps(plain_output(made), indent=2), encoding="utf-8")
    return made


class RunAgents(Run):
    """Time every agent on every case, taking turns."""

    config: RunAgentsConfig
    layout: RunAgentsLayout

    def main(self) -> None:
        cases = load_layout(self.config.cases, CasesLayout).cases.cases
        if self.config.only is not None:
            unknown = sorted(set(self.config.only) - {case.id for case in cases})
            if unknown:
                raise ValueError(f"step 1 has no case {', '.join(unknown)}")
            cases = [case for case in cases if case.id in self.config.only]
        systems = self.config.systems
        if System.CLAUDE_CODE_OPENROUTER in systems and not os.environ.get("OPENROUTER_API_KEY"):
            raise ValueError("Claude Code on OpenRouter needs OPENROUTER_API_KEY")
        attempts = []
        for repeat in range(1, self.config.repeats + 1):
            for index, case in enumerate(cases):
                turn = (repeat + index) % len(systems)
                for system in systems[turn:] + systems[:turn]:
                    folder = Path(self.layout.runs) / case.id / f"{system.value}-{repeat}"
                    made = attempt(self.config, system, case, repeat, folder)
                    status = "answered" if made.output is not None else "refused" if made.refused else f"FAILED {made.error}"
                    agent = "-" if made.agent_seconds is None else f"{made.agent_seconds:.1f}s"
                    print(f"{case.id} {system.value} #{repeat}: {status} · wall {made.wall_seconds:.1f}s · agent {agent}")
                    attempts.append(made)
        self.layout.attempts = Attempts(attempts=attempts)


if __name__ == "__main__":
    RunAgents().run()
