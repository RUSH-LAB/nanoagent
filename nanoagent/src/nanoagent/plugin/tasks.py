"""Running one plugin task the verified way, the same for `nanoagent plugin run/agent` and the web.

A ``runner: tool`` task calls its tool once, and its output is the tool's. A ``runner: agent``
task pins its reference tool's output first (in a scratch workspace the agent never sees), then
lets an agent work the task with only the task's tools, sharing one plugin process, and the
task's output is what the agent last passes to :data:`SUBMIT`. Either way the plugin's
``verify_task`` judges the output. Progress goes to ``on_event(type, data)``, with the ``task.*`` types of the
web protocol (docs/plans/plugin-ui.md).
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from slimconfig import build_output

from nanoagent.core.agent import Agent, AgentResult
from nanoagent.core.tool import Tool
from nanoagent.plugin.manifest import SUBMIT, PluginManifest, TaskDefinition
from nanoagent.plugin.runtime import PluginSession, call_tool_async, plugin_tools
from nanoagent.plugin.verifier import Verification, verify_task

TaskEvents = Callable[[str, dict[str, Any]], None]


@dataclass(frozen=True)
class TaskOutcome:
    reference: dict[str, Any] | None  # the reference tool's pinned output (agent tasks)
    output: dict[str, Any]  # the task's output, an instance of its output class as JSON
    agent: AgentResult | None  # the agent's run (agent tasks)
    verdict: Verification


class SubmitTool(Tool):
    """Submit the task's result. Call it once the task is done; if you call it again, the last
    submission is the result."""

    def __init__(self, task: TaskDefinition) -> None:
        self.NAME = SUBMIT
        self.PARAMETERS = task.output
        self._task = task
        self.output: dict[str, Any] | None = None

    def run(self, **arguments: Any) -> str:
        build_output(arguments, self._task.output_type)
        self.output = arguments
        return "Submitted."


def task_prompt(manifest: PluginManifest, task: TaskDefinition, arguments: dict[str, Any]) -> tuple[str, str]:
    """The system prompt and the opening user message for an agent working ``task``."""
    system = (
        f"You work one task with the {manifest.name} plugin's tools. Every file a tool saves goes "
        "into your workspace; paths you pass to tools are relative to it.\n\n"
        f"Task: {task.description}.\n{task.instructions}\n\n"
        f"When the task is done, call {SUBMIT} with its result."
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
) -> TaskOutcome:
    """Run ``task`` in ``workspace`` and judge it.

    ``make_agent(system_prompt)`` builds the agent for an agent task (None for a tool task).
    ``stage(folder)`` puts the task's input files into a workspace before anything reads them;
    it is called for ``workspace`` and for the reference tool's scratch workspace.
    """
    try:
        build_output(arguments, task.input_type)
    except ValueError as error:
        raise ValueError(f"invalid input for task {task.id}: {error}") from error
    on_event("task.started", {"task": task.id})
    stage(workspace)
    if task.runner == "tool":
        [tool] = task.tools
        output = await call_tool_async(manifest, tool, arguments, workspace=workspace, timeout=timeout)
        on_event("task.result", {"response": output})
        verdict = await _verdict(manifest, task, arguments, output, None, workspace, on_event)
        return TaskOutcome(reference=None, output=output, agent=None, verdict=verdict)

    if make_agent is None:
        raise ValueError(f"task {task.id!r} is an agent task: it needs an agent")
    reference = None
    if task.reference is not None:
        on_event("task.reference", {"tool": task.reference})
        with tempfile.TemporaryDirectory(prefix=f"nanoagent-{manifest.id}-reference-") as scratch:
            stage(Path(scratch))
            reference = await call_tool_async(
                manifest, task.reference, arguments, workspace=Path(scratch), timeout=timeout
            )

    system, user = task_prompt(manifest, task, arguments)
    agent = make_agent(system)
    submit = SubmitTool(task)
    agent.add_tool(submit)
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
    async with PluginSession(manifest, workspace, timeout=timeout) as session:
        for tool in plugin_tools(manifest, workspace, task.tools, session=session):
            agent.add_tool(tool)
        # Streamed, though nothing reads the text, so the run's profile measures time to first token.
        result = await agent.run(user, on_step=on_step, on_delta=lambda _kind, _text: None)
    on_event("task.answer", {"text": result.answer})
    if submit.output is None:
        raise RuntimeError(f"the agent ended task {task.id!r} without calling {SUBMIT}")
    on_event("task.result", {"response": submit.output})
    verdict = await _verdict(manifest, task, arguments, submit.output, reference, workspace, on_event)
    return TaskOutcome(reference=reference, output=submit.output, agent=result, verdict=verdict)


async def _verdict(
    manifest: PluginManifest,
    task: TaskDefinition,
    arguments: dict[str, Any],
    output: dict[str, Any],
    reference: dict[str, Any] | None,
    workspace: Path,
    on_event: TaskEvents,
) -> Verification:
    verdict = await asyncio.to_thread(verify_task, manifest, task.id, arguments, output, reference, workspace)
    on_event("task.verdict", verdict.to_dict())
    return verdict
