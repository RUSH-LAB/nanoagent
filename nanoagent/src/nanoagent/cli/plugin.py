"""`nanoagent plugin`: start a plugin, inspect one, or run one of its tasks as a slimconfig run.

    nanoagent plugin new <folder>
    nanoagent plugin inspect <path>
    nanoagent plugin run config=<run.yaml> home=<run folder> [-- key=value ...]    # runner: tool
    nanoagent plugin agent config=<run.yaml> home=<run folder> [-- key=value ...]  # runner: agent

Every run folder holds config.yaml, metadata.json and run.log, ``workspace/`` (the only folder
the plugin may write to) and ``verdict.json``, the plugin's :func:`verify_task` verdict on the
finished task; the run exits 1 unless that verdict is valid. The files a config lists under
``inputs`` are copied into ``workspace/inputs/`` first, so tools, the reference tool and the
verifier read them as ``inputs/<name>`` and the run folder holds everything it was judged on. A tool run adds ``result.json`` (the
tool's verified response). An agent run adds ``reference.json`` (the task's reference tool output,
pinned before the agent starts) and ``messages.json`` (the agent's conversation, as ATIF); the
agent's tools share one plugin process for the whole run.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Folder, Layout, Output, Run, load_output, plain_output

from nanoagent import __version__
from nanoagent.harness.nanoagent import NanoAgentConfig
from nanoagent.llm.bedrock import BedrockConfig
from nanoagent.core.agent import Agent
from nanoagent.plugin import PluginError, PluginManifest, load_manifest
from nanoagent.plugin.manifest import TaskDefinition
from nanoagent.plugin.scaffold import create_plugin
from nanoagent.plugin.tasks import run_task
from nanoagent.plugin.verifier import Verification
from nanoagent.runtime.build import build_agent
from nanoagent.runtime.config import AgentDefinitionConfig
from nanoagent.trajectory.atif import AtifTrajectory, to_atif

_USAGE = """usage:
  nanoagent plugin new <folder>
  nanoagent plugin inspect <path>
  nanoagent plugin run config=<run.yaml> home=<run folder> [-- key=value ...]
  nanoagent plugin agent config=<run.yaml> home=<run folder> [-- key=value ...]"""


@dataclass
class PluginRunConfig(Config):
    # The plugin folder (a `nanoagent.plugin/v1` package).
    plugin: str = MISSING
    # One of the plugin's tasks whose runner is `tool`.
    task: str = MISSING
    # The task's input: a JSON file of its contract input class (see nanoagent.plugin.contract).
    arguments: str = MISSING
    # Files the task reads, copied to workspace/inputs/<file name>; [] for none.
    inputs: list[str] = MISSING
    # Seconds the plugin may take per tool call, launch included.
    timeout: float = MISSING


@dataclass
class PluginAgentConfig(Config):
    plugin: str = MISSING
    # One of the plugin's tasks whose runner is `agent`.
    task: str = MISSING
    arguments: str = MISSING
    inputs: list[str] = MISSING
    timeout: float = MISSING
    # The model, and the agent loop's limits.
    llm: BedrockConfig = field(default_factory=BedrockConfig)
    harness: NanoAgentConfig = field(default_factory=NanoAgentConfig)


@dataclass
class PluginResult(Output):
    plugin: str
    task: str
    tool: str
    response: dict[str, Any]


@dataclass
class PluginReference(Output):
    # The task's reference tool and its pinned output; both null when the task has none.
    tool: str | None
    response: dict[str, Any] | None


@dataclass
class PluginVerdict(Output):
    task: str
    valid: bool
    score: float
    message: str
    details: dict[str, Any]


@dataclass
class PluginRunLayout(Layout):
    result: PluginResult
    verdict: PluginVerdict
    workspace: Folder


@dataclass
class PluginAgentLayout(Layout):
    reference: PluginReference
    messages: AtifTrajectory
    verdict: PluginVerdict
    workspace: Folder


def _task(config: PluginRunConfig | PluginAgentConfig, runner: str) -> tuple[PluginManifest, TaskDefinition]:
    manifest = load_manifest(Path(config.plugin))
    task = manifest.task(config.task)
    if task.runner != runner:
        command = "run" if task.runner == "tool" else "agent"
        raise ValueError(f"task {task.id!r} has runner {task.runner!r}: run it with `nanoagent plugin {command}`")
    return manifest, task


def _arguments(path: str, task: TaskDefinition) -> dict[str, Any]:
    """The task's input from its JSON file, checked into the task's contract input class."""
    return plain_output(load_output(path, task.input_type))


def stage_inputs(paths: list[str], workspace: Path) -> None:
    """Copy each input file to ``workspace/inputs/<file name>``."""
    names = [Path(path).name for path in paths]
    if len(set(names)) != len(names):
        raise ValueError(f"inputs must have distinct file names: {names}")
    for path in map(Path, paths):
        if not path.is_file():
            raise FileNotFoundError(f"input file not found: {path}")
        (workspace / "inputs").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, workspace / "inputs" / path.name)


def _print_event(kind: str, data: dict[str, Any]) -> None:
    """A task's progress, as lines in run.log."""
    if kind == "task.tool":
        print(f"tool: {data['name']}({json.dumps(data['arguments'])}){' ERROR' if data['isError'] else ''}")
    elif kind == "task.result":
        print(json.dumps(data["response"], indent=2))
    elif kind == "task.answer":
        print(f"agent: {data['text']}")
    elif kind == "task.verdict":
        print(f"verdict: {'valid' if data['valid'] else 'INVALID'} ({data['score']:.2f}) {data['message']}")
    elif kind == "task.reference":
        print(f"reference: {data['tool']}")


def _verdict(task: TaskDefinition, verification: Verification) -> PluginVerdict:
    return PluginVerdict(task=task.id, **verification.to_dict())


class PluginRun(Run):
    """One `runner: tool` task: its tool called once, against the run folder's workspace."""

    config: PluginRunConfig
    layout: PluginRunLayout

    def main(self) -> int:
        manifest, task = _task(self.config, "tool")
        outcome = asyncio.run(
            run_task(
                manifest,
                task,
                _arguments(self.config.arguments, task),
                Path(self.layout.workspace),
                make_agent=None,
                timeout=self.config.timeout,
                on_event=_print_event,
                stage=lambda folder: stage_inputs(self.config.inputs, folder),
            )
        )
        response = outcome.response
        self.layout.result = PluginResult(plugin=manifest.id, task=task.id, tool=task.tools[0], response=response)
        self.layout.verdict = _verdict(task, outcome.verdict)
        return 0 if self.layout.verdict.valid else 1


class PluginAgent(Run):
    """One `runner: agent` task: its reference pinned, an agent working it, and its verdict."""

    config: PluginAgentConfig
    layout: PluginAgentLayout

    def main(self) -> int:
        manifest, task = _task(self.config, "agent")

        def make_agent(system_prompt: str) -> Agent:
            definition = AgentDefinitionConfig(
                model=self.config.llm.runtime(),
                agent=self.config.harness.runtime(system_prompt=system_prompt),
                tools=[],
                tools_dir=None,
                allowed_tools=None,
            )
            return build_agent(definition)

        outcome = asyncio.run(
            run_task(
                manifest,
                task,
                _arguments(self.config.arguments, task),
                Path(self.layout.workspace),
                make_agent=make_agent,
                timeout=self.config.timeout,
                on_event=_print_event,
                stage=lambda folder: stage_inputs(self.config.inputs, folder),
            )
        )
        self.layout.reference = PluginReference(tool=task.reference, response=outcome.reference)
        self.layout.messages = AtifTrajectory.from_dict(
            to_atif(
                outcome.agent,
                session_id=str(uuid.uuid4()),
                harness="nanoagent",
                harness_version=__version__,
                model=self.config.llm.model,
            )
        )
        self.layout.verdict = _verdict(task, outcome.verdict)
        return 0 if self.layout.verdict.valid else 1


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    if argv[:1] == ["new"] and len(argv) == 2:
        try:
            manifest = create_plugin(Path(argv[1]))
        except (ValueError, FileExistsError, RuntimeError) as error:
            print(error, file=sys.stderr)
            return 1
        print(f"created plugin {manifest.id} in {manifest.root}")
        return 0
    if argv[:1] == ["inspect"] and len(argv) == 2:
        try:
            manifest = load_manifest(Path(argv[1]))
        except PluginError as error:
            print(error, file=sys.stderr)
            return 1
        print(json.dumps(manifest.public(), indent=2))
        return 0
    if argv[:1] in (["run"], ["agent"]):
        # slimconfig's launcher reads `config=` / `home=` / `-- overrides` from sys.argv.
        sys.argv = [f"{Path(sys.argv[0]).name} plugin {argv[0]}", *argv[1:]]
        (PluginRun if argv[0] == "run" else PluginAgent)().run()
    print(_USAGE)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
