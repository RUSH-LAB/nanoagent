"""The agent a web prompt runs against one plugin: the server's model and loop, the plugin's tasks.

Its tools are the plugin's tasks, one tool each, named by the task's id and taking its input. A
call runs the task the verified way (:func:`nanoagent.plugin.tasks.run_task`) in the caller's
workspace and returns the task's typed output and its verdict, which the plugin's page draws.
The plugin's own tools are used only inside its tasks. Each run records its provenance graph
(:class:`GraphRunner`), the chat's own loop with each task's run inside its call.
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
from nanoagent.harness.base import ProgressSink, RunnerRequest, RunnerResult
from nanoagent.harness.nanoagent import AgentFactory, NanoAgentRunner
from nanoagent.harness.registry import RunnerProfile
from nanoagent.plugin import PluginManifest
from nanoagent.plugin.dataflow import Decider
from nanoagent.plugin.manifest import TaskDefinition
from nanoagent.plugin.provenance import PARTS, LoopRecorder, NodeType, Provenance
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
    verdict as JSON; an agent or decide task's model calls count in the chat's cost. While it runs
    it reports how the task is going (:meth:`report`)."""

    def __init__(
        self,
        manifest: PluginManifest,
        task: TaskDefinition,
        workspace: Path,
        make_agent: Callable[[str], Agent],
        make_decider: Callable[[str], Decider],
        timeout: float,
        reasoning: bool,
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
        self._reasoning = reasoning

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
            on_event=self.report,
            stage=staged_from(self._workspace),
        )
        profile = outcome.agent.profile if outcome.agent is not None else None
        model_calls = (
            ()
            if profile is None
            else tuple(dataclasses.replace(call, kind="tool") for step in profile.steps for call in step.model_calls)
        )
        return ToolText(json.dumps({"output": outcome.output, "verdict": outcome.verdict.to_dict()}), model_calls=model_calls)

    def report(self, kind: str, data: dict[str, Any]) -> None:
        """Pass on a task event for the page to show while the task runs: its reference tool
        (``task.reference``), each tool it calls (``task.tool``, name and whether it failed), what
        its agent writes (``task.delta``, reasoning only where the host shows reasoning), that
        its result is being checked (``task.result``, empty), and once it ends, its provenance
        graph (``task.graph``, :mod:`nanoagent.plugin.provenance`), which the session keeps. What
        the task returned and its verdict come with the call's result, so they are not repeated here."""
        if kind in ("task.reference", "task.graph"):
            self.progress(kind, data)
        elif kind == "task.tool":
            self.progress(kind, {"name": data["name"], "isError": data["isError"]})
        elif kind == "task.delta" and (data["kind"] == "content" or self._reasoning):
            self.progress(kind, data)
        elif kind == "task.result":
            self.progress(kind, {})


class GraphRunner:
    """A run of NanoAgent's loop, built by ``factory``, recorded as its provenance graph
    (:mod:`nanoagent.plugin.provenance`) while it runs. The graph starts with the system prompt
    the agent is built with, the turns before when there are any, and the message; the chat's
    replies and the tasks they call follow, each task's own run drawn
    inside its call from its ``task.graph`` events, which go no further. Each change is a
    ``{"type": "graph", "patch": ...}`` event, and once the run ends, done or not, the whole graph
    is ``{"type": "graph", "graph": ...}``."""

    name = NanoAgentRunner.name
    capabilities = NanoAgentRunner.capabilities

    def __init__(self, cfg: WebConfig, factory: AgentFactory) -> None:
        self._runner = NanoAgentRunner(cfg, agent_factory=self._built(factory))
        self._graph: Provenance | None = None

    def _built(self, factory: AgentFactory) -> AgentFactory:
        """``factory``, with the system prompt each agent it builds is given put in the run's graph."""

        def build(instructions: str | None) -> tuple[Agent, str]:
            agent, prompt = factory(instructions)
            if self._graph is None:
                raise RuntimeError("an agent is built only while a run records its graph")
            self._graph.value("system", NodeType.SYSTEM_PROMPT, PARTS[NodeType.SYSTEM_PROMPT].label, prompt)
            return agent, prompt

        return build

    def __getattr__(self, name: str) -> Any:
        return getattr(self._runner, name)

    async def run(self, request: RunnerRequest, emit: ProgressSink) -> RunnerResult:
        graph = self._graph = Provenance(lambda patch: emit({"type": "graph", "patch": patch}))
        inputs = ["system", "message"]
        if request.messages:
            graph.value("history", NodeType.EARLIER_TURNS, PARTS[NodeType.EARLIER_TURNS].label, {"messages": len(request.messages)})
            inputs.insert(1, "history")
        graph.value("message", NodeType.USER_MESSAGE, PARTS[NodeType.USER_MESSAGE].label, request.input)
        loop = LoopRecorder(graph, inputs, runs=lambda _name: NodeType.TASK)

        def relay(event: dict[str, Any]) -> None:
            match event["type"]:
                case "delta":
                    loop.delta(event["kind"], event["text"])
                case "tool_start":
                    loop.tool_started(event["id"], event["name"])
                case "tool_progress" if event["event"] == "task.graph":
                    graph.merge(event["data"], prefix=f"{loop.node(event['id'])}/", parent=loop.node(event["id"]))
                    return
                case "tool":
                    loop.tool_done(event["id"], event["name"], event["arguments"], event["output"], event["is_error"])
                case "step":
                    loop.step_done(event["metrics"])
            emit(event)

        result = None
        try:
            result = await self._runner.run(request, relay)
        finally:
            steps = (result.profile or {}).get("steps") if result is not None else None
            loop.finish(result.answer if result is not None and result.error is None else None, steps[-1] if steps else None)
            emit({"type": "graph", "graph": graph.to_dict()})
        return result


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
            TaskTool(
                manifest,
                task,
                workspace,
                task_agent(model, limits),
                task_decider(model, limits),
                cfg.request_timeout,
                cfg.include_reasoning,
            )
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
        runner=GraphRunner(cfg, factory),
    )
