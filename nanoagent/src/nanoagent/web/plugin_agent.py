"""The agent a web prompt runs against one plugin: the server's model and loop, the plugin's tasks.

Its tools are the plugin's tasks, one tool each, named by the task's id and taking its input. A
call runs the task the verified way (:func:`nanoagent.plugin.tasks.run_task`) in the caller's
workspace and returns the task's typed output and its verdict, which the plugin's page draws.
The plugin's own tools are used only inside its tasks.
"""

from __future__ import annotations

import dataclasses
import json
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from nanoagent.core.agent import Agent, ChatModel, DecisionModel
from nanoagent.core.tool import Tool, ToolText
from nanoagent.extensions import get_hooks
from nanoagent.harness.nanoagent import NanoAgentRunner
from nanoagent.harness.registry import RunnerProfile
from nanoagent.plugin import PluginManifest
from nanoagent.plugin.dataflow import Decider
from nanoagent.plugin.manifest import TaskDefinition
from nanoagent.plugin.tasks import ModelDecider, run_task
from nanoagent.runtime.build import build_prompt_and_tools
from nanoagent.runtime.config import AgentConfig
from nanoagent.web.config import WebConfig


class PluginModel(ChatModel, DecisionModel, Protocol):
    """What a plugin run's model does: chat, for the chat and its agent tasks, and answer, for its
    decide tasks."""


def staged_from(workspace: Path) -> Callable[[Path], None]:
    """How a web task stages its inputs: they are already the caller's workspace files, so the
    workspace needs nothing and the reference tool's scratch folder gets a copy of it."""

    def stage(folder: Path) -> None:
        if folder != workspace:
            shutil.copytree(workspace, folder, dirs_exist_ok=True)

    return stage


def task_agent(model: ChatModel, limits: AgentConfig) -> Callable[[str], Agent]:
    """What builds an agent task's agent: ``model`` within ``limits``, given its system prompt."""

    def make_agent(system_prompt: str) -> Agent:
        return Agent(
            model,
            [],
            system_prompt=system_prompt,
            max_steps=limits.max_steps,
            cost_limit=limits.cost_limit,
            token_limit=limits.token_limit,
            context_window=limits.context_window,
            hooks=get_hooks(limits.hooks),
        )

    return make_agent


def task_decider(model: DecisionModel, limits: AgentConfig) -> Callable[[str], Decider]:
    """What builds a decide task's decider: ``model`` within ``limits``, given its system prompt."""

    def make_decider(system_prompt: str) -> Decider:
        return ModelDecider(
            model,
            system_prompt,
            max_steps=limits.max_steps,
            cost_limit=limits.cost_limit,
            token_limit=limits.token_limit,
        )

    return make_decider


class TaskTool(Tool):
    """One of the plugin's tasks as the chat agent's tool. Its result is the task's output and
    verdict as JSON; an agent or decide task's model calls count in the chat's cost."""

    def __init__(
        self,
        manifest: PluginManifest,
        task: TaskDefinition,
        workspace: Path,
        make_agent: Callable[[str], Agent],
        make_decider: Callable[[str], Decider],
        timeout: float,
    ) -> None:
        self.NAME = task.id
        self.PARAMETERS = task.input
        self._description = task.description
        self._manifest = manifest
        self._task = task
        self._workspace = workspace
        self._make_agent = make_agent
        self._make_decider = make_decider
        self._timeout = timeout

    @property
    def description(self) -> str:
        return self._description

    async def run(self, **arguments: Any) -> str:
        outcome = await run_task(
            self._manifest,
            self._task,
            arguments,
            self._workspace,
            make_agent=self._make_agent,
            make_decider=self._make_decider,
            timeout=self._timeout,
            on_event=lambda _kind, _data: None,
            stage=staged_from(self._workspace),
        )
        profile = outcome.agent.profile if outcome.agent is not None else None
        model_calls = (
            ()
            if profile is None
            else tuple(dataclasses.replace(call, kind="tool") for step in profile.steps for call in step.model_calls)
        )
        return ToolText(json.dumps({"output": outcome.output, "verdict": outcome.verdict.to_dict()}), model_calls=model_calls)


def plugin_prompt(manifest: PluginManifest) -> str:
    """What the agent is told about the plugin it operates through its tasks."""
    return (
        f"You operate the {manifest.name} plugin through its tasks: each of your tools is one task. "
        "Turn what the user asks into the input of the task that does it, and call that task; ask "
        "the user only for what you cannot work out. The page shows the user each task's result "
        "and whether it passed its check, so do not repeat the result: say in a sentence or two "
        "what you did. Files the tasks save stay in the user's workspace; refer to them by their "
        "paths there."
    )


def plugin_profile(
    cfg: WebConfig,
    model: PluginModel,
    manifest: PluginManifest,
    workspace: Path,
    *,
    model_name: str | None = None,
    agent: AgentConfig | None = None,
) -> RunnerProfile:
    """A one-run profile: NanoAgent's loop with ``manifest``'s tasks run in ``workspace``.

    ``model_name`` names ``model`` when it is not the configured one, and ``agent`` holds the run's
    limits when it set its own; an agent task's agent and a decide task's decider run on the same
    model within them.
    """
    limits = agent or cfg.agent

    def factory(instructions: str | None) -> tuple[Agent, str]:
        suffix = plugin_prompt(manifest)
        clean = instructions.strip() if instructions else ""
        if clean:
            suffix += f"\n\nApplication instructions:\n{clean}"
        # The server's prompt; the chat's only tools are the plugin's tasks.
        prompt, _tools = build_prompt_and_tools(cfg.agent, cfg.tools, cfg.tools_dir, cfg.allowed_tools, suffix)
        tasks = [
            TaskTool(manifest, task, workspace, task_agent(model, limits), task_decider(model, limits), cfg.request_timeout)
            for task in manifest.tasks
        ]
        agent = Agent(
            model,
            tasks,
            system_prompt=prompt,
            max_steps=limits.max_steps,
            cost_limit=limits.cost_limit,
            token_limit=limits.token_limit,
            context_window=limits.context_window,
            hooks=get_hooks(limits.hooks),
        )
        return agent, prompt

    return RunnerProfile(
        id=f"plugin-{manifest.id}",
        label=f"{manifest.name} · NanoAgent",
        harness=NanoAgentRunner.name,
        model=model_name or cfg.model.model,
        runner=NanoAgentRunner(cfg, agent_factory=factory),
    )
