"""The agent a web prompt runs against one plugin: the server's model and loop, the plugin's tools."""

from __future__ import annotations

from pathlib import Path

from nanoagent.core.agent import Agent, ChatModel
from nanoagent.runtime.config import AgentConfig
from nanoagent.extensions import get_hooks
from nanoagent.harness.nanoagent import NanoAgentRunner
from nanoagent.harness.registry import RunnerProfile
from nanoagent.plugin import PluginManifest, plugin_tools
from nanoagent.runtime.build import build_prompt_and_tools
from nanoagent.web.config import WebConfig


def plugin_prompt(manifest: PluginManifest) -> str:
    """What the agent is told about the plugin it operates: its tasks and its README."""
    tasks = "\n".join(
        f"- {task.id}: {task.description}. {task.instructions} (tools: {', '.join(task.tools)})"
        for task in manifest.tasks
    )
    readme = (manifest.root / "README.md").read_text(encoding="utf-8").strip()
    return (
        f"You operate the {manifest.name} plugin. Do what the user asks with its tools, then "
        "report briefly what was done. Files the tools save stay in the user's workspace, "
        "where the user can open them; refer to them by their paths there."
        f"\n\nIts tasks:\n{tasks}\n\nIts README:\n{readme}"
    )


def plugin_profile(
    cfg: WebConfig,
    model: ChatModel,
    manifest: PluginManifest,
    workspace: Path,
    *,
    model_name: str | None = None,
    agent: AgentConfig | None = None,
) -> RunnerProfile:
    """A one-run profile: NanoAgent's loop with ``manifest``'s tools writing into ``workspace``.

    ``model_name`` names ``model`` when it is not the configured one, and ``agent`` holds the run's
    limits when it set its own.
    """
    limits = agent or cfg.agent

    def factory(instructions: str | None) -> tuple[Agent, str]:
        suffix = plugin_prompt(manifest)
        clean = instructions.strip() if instructions else ""
        if clean:
            suffix += f"\n\nApplication instructions:\n{clean}"
        prompt, tools = build_prompt_and_tools(
            cfg.agent, cfg.tools, cfg.tools_dir, cfg.allowed_tools, suffix
        )
        agent = Agent(
            model,
            [*tools, *plugin_tools(manifest, workspace, session=None)],
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
