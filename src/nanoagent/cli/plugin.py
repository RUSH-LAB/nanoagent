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
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from jsonschema import validate
from omegaconf import MISSING
from slimconfig import Config, Folder, Layout, Output, Run

from nanoagent import __version__
from nanoagent.harness.nanoagent import NanoAgentConfig
from nanoagent.llm.bedrock import BedrockConfig
from nanoagent.core.agent import AgentResult
from nanoagent.plugin import PluginError, PluginManifest, PluginSession, call_tool, load_manifest, plugin_tools, verify_task
from nanoagent.plugin.manifest import TaskDefinition
from nanoagent.plugin.scaffold import create_plugin
from nanoagent.plugin.verifier import Verification
from nanoagent.runtime.build import build_agent
from nanoagent.runtime.config import AgentDefinitionConfig, parse_kv_list
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
    # The task's input as `key=value` tokens (see parse_kv_list). A value that parses as JSON but
    # must stay a string is double-quoted: arxiv_id="1706.03762".
    arguments: list[str] = MISSING
    # Files the task reads, copied to workspace/inputs/<file name>; [] for none.
    inputs: list[str] = MISSING
    # Seconds the plugin may take per tool call, launch included.
    timeout: float = MISSING


@dataclass
class PluginAgentConfig(Config):
    plugin: str = MISSING
    # One of the plugin's tasks whose runner is `agent`.
    task: str = MISSING
    arguments: list[str] = MISSING
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


def _verdict(task: TaskDefinition, verification: Verification) -> PluginVerdict:
    print(f"verdict: {'valid' if verification.valid else 'INVALID'} ({verification.score:.2f}) {verification.message}")
    return PluginVerdict(task=task.id, **verification.to_dict())


class PluginRun(Run):
    """One `runner: tool` task: its tool called once, against the run folder's workspace."""

    config: PluginRunConfig
    layout: PluginRunLayout

    def main(self) -> int:
        manifest, task = _task(self.config, "tool")
        [tool] = task.tools
        workspace = Path(self.layout.workspace)
        arguments = parse_kv_list(self.config.arguments)
        stage_inputs(self.config.inputs, workspace)
        response = call_tool(manifest, tool, arguments, workspace=workspace, timeout=self.config.timeout)
        self.layout.result = PluginResult(plugin=manifest.id, task=task.id, tool=tool, response=response)
        print(json.dumps(response, indent=2))
        self.layout.verdict = _verdict(task, verify_task(manifest.root, task.id, arguments, None, workspace))
        return 0 if response.get("ok") and self.layout.verdict.valid else 1


def _agent_prompt(manifest: PluginManifest, task: TaskDefinition, arguments: dict[str, Any]) -> tuple[str, str]:
    system = (
        f"You work one task with the {manifest.name} plugin's tools. Every file a tool saves goes "
        "into your workspace; paths you pass to tools are relative to it.\n\n"
        f"Task: {task.description}.\n{task.instructions}"
    )
    return system, f"Task input:\n{json.dumps(arguments, indent=2)}"


class PluginAgent(Run):
    """One `runner: agent` task: its reference pinned, an agent working it, and its verdict."""

    config: PluginAgentConfig
    layout: PluginAgentLayout

    def main(self) -> int:
        manifest, task = _task(self.config, "agent")
        workspace = Path(self.layout.workspace)
        arguments = parse_kv_list(self.config.arguments)
        validate(arguments, task.input)
        stage_inputs(self.config.inputs, workspace)

        reference = None
        if task.reference is not None:
            # The reference tool writes nowhere the agent can see.
            with tempfile.TemporaryDirectory(prefix=f"nanoagent-{manifest.id}-reference-") as scratch:
                stage_inputs(self.config.inputs, Path(scratch))
                reference = call_tool(manifest, task.reference, arguments, workspace=Path(scratch), timeout=self.config.timeout)
            if not reference.get("ok"):
                raise RuntimeError(f"reference tool {task.reference} failed: {reference.get('error')}")
        self.layout.reference = PluginReference(tool=task.reference, response=reference)

        system, user = _agent_prompt(manifest, task, arguments)
        definition = AgentDefinitionConfig(
            model=self.config.llm.runtime(),
            agent=self.config.harness.runtime(system_prompt=system),
            tools=[],
            tools_dir=None,
            allowed_tools=None,
        )
        agent = build_agent(definition)

        async def work() -> AgentResult:
            # One plugin process for the whole task, so its tools can keep state between calls.
            async with PluginSession(manifest, workspace, timeout=self.config.timeout) as session:
                for tool in plugin_tools(manifest, workspace, task.tools, session=session):
                    agent.add_tool(tool)
                return await agent.run(user)

        print(f"user: {user}")
        result = asyncio.run(work())
        print(f"agent: {result.answer}")
        self.layout.messages = AtifTrajectory.from_dict(
            to_atif(
                result,
                session_id=str(uuid.uuid4()),
                harness="nanoagent",
                harness_version=__version__,
                model=self.config.llm.model,
            )
        )
        self.layout.verdict = _verdict(task, verify_task(manifest.root, task.id, arguments, reference, workspace))
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
