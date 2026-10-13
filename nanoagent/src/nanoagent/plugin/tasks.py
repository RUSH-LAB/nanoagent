"""Running one plugin task the verified way, the same for `nanoagent plugin run/agent` and the web.

A ``runner: tool`` task calls its tool once. A ``runner: agent`` task pins its reference tool's
output first (in a scratch workspace the agent never sees), then lets an agent work the task with
only the task's tools, sharing one plugin process. Either way the plugin's ``verify_task`` judges
the finished task. Progress goes to ``on_event(type, data)``, with the ``task.*`` types of the
web protocol (docs/plans/plugin-ui.md).
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from slimconfig import build_output

from nanoagent.core.agent import Agent, AgentResult
from nanoagent.plugin.manifest import PluginManifest, TaskDefinition
from nanoagent.plugin.runtime import PluginSession, call_tool_async, plugin_tools
from nanoagent.plugin.verifier import Verification, verify_task

TaskEvents = Callable[[str, dict[str, Any]], None]


@dataclass(frozen=True)
class TaskOutcome:
    reference: dict[str, Any] | None  # the reference tool's pinned output (agent tasks)
    response: dict[str, Any] | None  # the tool's response (tool tasks)
    agent: AgentResult | None  # the agent's run (agent tasks)
    verdict: Verification


def task_prompt(manifest: PluginManifest, task: TaskDefinition, arguments: dict[str, Any]) -> tuple[str, str]:
    """The system prompt and the opening user message for an agent working ``task``."""
    system = (
        f"You work one task with the {manifest.name} plugin's tools. Every file a tool saves goes "
        "into your workspace; paths you pass to tools are relative to it.\n\n"
        f"Task: {task.description}.\n{task.instructions}"
    )
    return system, f"Task input:\n{json.dumps(arguments, indent=2)}"


async def run_task(
    manifest: PluginManifest,
    task: TaskDefinition,
    arguments: dict[str, Any],
    workspace: Path,
    *,
    make_agent: Callable[[str], Agent] | None,
    timeout: float,
    on_event: TaskEvents,
    stage: Callable[[Path], None],
    environ: Mapping[str, str] | None = None,
) -> TaskOutcome:
    """Run ``task`` in ``workspace`` and judge it.

    ``make_agent(system_prompt)`` builds the agent for an agent task (None for a tool task).
    ``stage(folder)`` puts the task's input files into a workspace before anything reads them;
    it is called for ``workspace`` and for the reference tool's scratch workspace. ``environ`` is
    what the plugin's variables are set from (see :func:`~nanoagent.plugin.runtime.plugin_env`).
    """
    try:
        build_output(arguments, task.input_type)
    except ValueError as error:
        raise ValueError(f"invalid input for task {task.id}: {error}") from error
    on_event("task.started", {"task": task.id})
    stage(workspace)
    if task.runner == "tool":
        [tool] = task.tools
        response = await call_tool_async(manifest, tool, arguments, workspace=workspace, timeout=timeout, environ=environ)
        on_event("task.result", {"response": response})
        verdict = await _verdict(manifest, task, arguments, None, workspace, on_event)
        return TaskOutcome(reference=None, response=response, agent=None, verdict=verdict)

    if make_agent is None:
        raise ValueError(f"task {task.id!r} is an agent task: it needs an agent")
    reference = None
    if task.reference is not None:
        on_event("task.reference", {"tool": task.reference})
        with tempfile.TemporaryDirectory(prefix=f"nanoagent-{manifest.id}-reference-") as scratch:
            stage(Path(scratch))
            reference = await call_tool_async(
                manifest, task.reference, arguments, workspace=Path(scratch), timeout=timeout, environ=environ
            )

    system, user = task_prompt(manifest, task, arguments)
    agent = make_agent(system)
    reported = 0

    def on_step(partial: AgentResult) -> None:
        nonlocal reported
        for call in partial.tool_calls[reported:]:
            on_event(
                "task.tool",
                {"name": call["name"], "arguments": call["arguments"], "output": call["output"], "isError": call["is_error"]},
            )
        reported = len(partial.tool_calls)

    # One plugin process for the whole task, so its tools can keep state between calls.
    async with PluginSession(manifest, workspace, timeout=timeout, environ=environ) as session:
        for tool in plugin_tools(manifest, workspace, task.tools, session=session):
            agent.add_tool(tool)
        # Streamed, though nothing reads the text, so the run's profile measures time to first token.
        result = await agent.run(user, on_step=on_step, on_delta=lambda _kind, _text: None)
    on_event("task.answer", {"text": result.answer})
    verdict = await _verdict(manifest, task, arguments, reference, workspace, on_event)
    return TaskOutcome(reference=reference, response=None, agent=result, verdict=verdict)


async def _verdict(
    manifest: PluginManifest,
    task: TaskDefinition,
    arguments: dict[str, Any],
    reference: dict[str, Any] | None,
    workspace: Path,
    on_event: TaskEvents,
) -> Verification:
    verdict = await asyncio.to_thread(verify_task, manifest, task.id, arguments, reference, workspace)
    on_event("task.verdict", verdict.to_dict())
    return verdict
