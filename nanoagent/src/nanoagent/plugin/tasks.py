"""Running one plugin task the verified way, the same for `nanoagent plugin run/agent` and the web.

A ``runner: tool`` task calls its tool once, and its output is the tool's. A ``runner: agent``
task pins its reference tool's output first (in a scratch workspace the agent never sees), then
lets an agent work the task with only the task's tools, sharing one plugin process, and the
task's output is what the agent last passes to :data:`SUBMIT`. A ``runner: decide`` task pins its
reference the same way, then calls its tools and builds its output itself, every value chosen by a
:class:`~nanoagent.plugin.dataflow.Decider` or copied (:func:`~nanoagent.plugin.dataflow.fill`),
and each batch of choices is a ``task.decision`` event; an agent task's agent streams what it writes
as ``task.delta`` events. Every way, the plugin's
``verify_task`` judges the output. Progress goes to ``on_event(type, data)``, with the ``task.*`` types of the
web protocol (docs/plans/plugin-ui.md).
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from slimconfig import build_output

from nanoagent.core.agent import Agent, AgentResult, DecisionModel, Reply, StopReason, ToolCall
from nanoagent.core.messages import assistant_message
from nanoagent.core.tool import Tool
from nanoagent.plugin.dataflow import Answers, Decider, Question, answer_schema, check, fill, values
from nanoagent.plugin.manifest import SUBMIT, PluginManifest, TaskDefinition
from nanoagent.plugin.runtime import PluginSession, call_tool_async, plugin_tools
from nanoagent.plugin.verifier import Verification, verify_task
from nanoagent.profiler import Profiler

TaskEvents = Callable[[str, dict[str, Any]], None]
ANSWER = "answer"  # the name a decider's model answers under


@dataclass(frozen=True)
class TaskOutcome:
    reference: dict[str, Any] | None  # the reference tool's pinned output (agent and decide tasks)
    output: dict[str, Any]  # the task's output, an instance of its output class as JSON
    agent: AgentResult | None  # the agent's run (agent tasks), or the decider's requests (decide tasks)
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


def decide_prompt(manifest: PluginManifest, task: TaskDefinition) -> str:
    """The system prompt for a model deciding ``task``."""
    return (
        f"You decide one task worked with the {manifest.name} plugin's tools. NanoAgent calls the tools and "
        "builds the task's output; you only choose. Each request gives the state so far, the task input and "
        "every tool call with its output, and a batch of questions. Answer each question with one of its "
        "options; never write a value of your own. An option such as calls[0].output.entries[2].key names "
        "the value at that path in the state, and null means no value.\n\n"
        f"Task: {task.description}.\n{task.instructions}"
    )


class ModelDecider:
    """A :class:`~nanoagent.plugin.dataflow.Decider` that asks ``model`` once per batch of questions,
    its answer held to their options by :func:`~nanoagent.plugin.dataflow.answer_schema`.

    Each request is the system prompt and one user message with the state and the questions. It
    raises before a request past ``max_steps`` requests, ``cost_limit`` dollars or ``token_limit``
    total tokens (None for no cap).
    """

    def __init__(
        self,
        model: DecisionModel,
        system: str,
        *,
        max_steps: int,
        cost_limit: float | None,
        token_limit: int | None,
    ) -> None:
        self._model = model
        self._messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
        self._max_steps = max_steps
        self._cost_limit = cost_limit
        self._token_limit = token_limit
        self._profiler = Profiler()
        self._durations: list[dict[str, float]] = []

    async def decide(self, state: dict[str, Any], questions: list[Question]) -> Answers:
        spent = self._profiler.snapshot()
        if len(spent.steps) >= self._max_steps:
            raise RuntimeError(f"the decider made its {self._max_steps} requests (max_steps) and the task is not done")
        if self._cost_limit is not None and spent.cost >= self._cost_limit:
            raise RuntimeError(f"the decider spent ${spent.cost:.4f}, reaching its cost_limit of ${self._cost_limit}")
        if self._token_limit is not None and spent.usage.get("total_tokens", 0) >= self._token_limit:
            raise RuntimeError(f"the decider used {spent.usage.get('total_tokens', 0)} tokens, reaching its token_limit")
        asked = "\n".join(f"- {question.id}: {question.text}\n  options: {', '.join(question.options)}" for question in questions)
        user = {"role": "user", "content": f"State:\n{json.dumps(state, indent=2)}\n\nQuestions:\n{asked}"}
        step = self._profiler.start_step(len(spent.steps) + 1)
        timer = step.start_model_call()
        try:
            answer = await self._model.answer([self._messages[0], user], name=ANSWER, schema=answer_schema(questions))
        except Exception as error:
            step.finish_model_call(timer, error=f"{type(error).__name__}: {error}")
            step.finish()
            raise
        record = step.finish_model_call(timer, usage=answer.usage, cost=answer.cost)
        step.finish()
        self._durations.append({"model": record.duration_s, "tools": 0.0})
        call = ToolCall(id=f"{ANSWER}-{len(self._durations)}", name=ANSWER, arguments=json.dumps(answer.value))
        self._messages += [user, assistant_message(Reply(content=None, tool_calls=[call]))]
        return Answers(answer.value)

    def record(self) -> AgentResult:
        """Every request as a transcript of ``answer`` calls, with its usage, cost and profile."""
        profile = self._profiler.snapshot()
        return AgentResult(
            answer="",
            messages=list(self._messages),
            tool_calls=[],
            steps=len(profile.steps),
            stop_reason=StopReason.ANSWER,
            usage=dict(profile.usage),
            cost=profile.cost,
            step_durations=list(self._durations),
            profile=profile,
        )


async def run_task(
    manifest: PluginManifest,
    task: TaskDefinition,
    arguments: dict[str, Any],
    workspace: Path,
    *,
    make_agent: Callable[[str], Agent] | None,
    make_decider: Callable[[str], Decider] | None,
    timeout: float,
    on_event: TaskEvents,
    stage: Callable[[Path], None],
) -> TaskOutcome:
    """Run ``task`` in ``workspace`` and judge it.

    ``make_agent(system_prompt)`` builds the agent for an agent task, and ``make_decider(system_prompt)``
    the decider for a decide task (each None when the task does not need it).
    ``stage(folder)`` puts the task's input files into a workspace before anything reads them;
    it is called for ``workspace`` and for the reference tool's scratch workspace.
    """
    try:
        build_output(arguments, task.input_type)
    except ValueError as error:
        raise ValueError(f"invalid input for task {task.id}: {error}") from error
    on_event("task.started", {"task": task.id})
    stage(workspace)
    match task.runner:
        case "tool":
            [tool] = task.tools
            output = await call_tool_async(manifest, tool, arguments, workspace=workspace, timeout=timeout)
            on_event("task.result", {"response": output})
            verdict = await _verdict(manifest, task, arguments, output, None, workspace, on_event)
            return TaskOutcome(reference=None, output=output, agent=None, verdict=verdict)
        case "agent":
            if make_agent is None:
                raise ValueError(f"task {task.id!r} is an agent task: it needs an agent")
            reference = await _pin_reference(manifest, task, arguments, timeout, on_event, stage)
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
                result = await agent.run(
                    user, on_step=on_step, on_delta=lambda kind, text: on_event("task.delta", {"kind": kind, "text": text})
                )
            on_event("task.answer", {"text": result.answer})
            if submit.output is None:
                raise RuntimeError(f"the agent ended task {task.id!r} without calling {SUBMIT}")
            on_event("task.result", {"response": submit.output})
            verdict = await _verdict(manifest, task, arguments, submit.output, reference, workspace, on_event)
            return TaskOutcome(reference=reference, output=submit.output, agent=result, verdict=verdict)
        case "decide":
            if make_decider is None:
                raise ValueError(f"task {task.id!r} is a decide task: it needs a decider")
            reference = await _pin_reference(manifest, task, arguments, timeout, on_event, stage)
            decider = make_decider(decide_prompt(manifest, task))
            state: dict[str, Any] = {"task": task.id, "input": arguments, "calls": []}

            async def ask(questions: list[Question], forced: dict[str, str]) -> dict[str, str | list[str]]:
                answers = await decider.decide(state, questions) if questions else Answers({})
                check(questions, answers)
                on_event(
                    "task.decision",
                    {
                        "questions": [asdict(question) for question in questions],
                        "answers": answers.values,
                        "probabilities": answers.probabilities,
                        "forced": forced,
                    },
                )
                return answers.values

            async with PluginSession(manifest, workspace, timeout=timeout) as session:
                while True:
                    pool = values(arguments, task.input_type, "input")
                    for index, call in enumerate(state["calls"]):
                        pool += values(call["output"], manifest.tool(call["tool"]).output_type, f"calls[{index}].output")
                    step = Question("next", "one", "What comes next: a tool to call, or submit the task's output?", (*task.tools, SUBMIT))
                    [chosen] = (await ask([step], {})).values()
                    if chosen == SUBMIT:
                        output = await fill(task.output_type, "output", pool, ask)
                        break
                    tool_input = await fill(manifest.tool(chosen).input_type, f"calls[{len(state['calls'])}].arguments", pool, ask)
                    tool_output = await session.call(chosen, tool_input)
                    state["calls"].append({"tool": chosen, "arguments": tool_input, "output": tool_output})
                    on_event("task.tool", {"name": chosen, "arguments": tool_input, "output": tool_output, "isError": False})
            build_output(output, task.output_type)
            on_event("task.result", {"response": output})
            verdict = await _verdict(manifest, task, arguments, output, reference, workspace, on_event)
            return TaskOutcome(reference=reference, output=output, agent=decider.record(), verdict=verdict)
        case runner:
            raise ValueError(f"task {task.id!r}: unknown runner {runner!r}")


async def _pin_reference(
    manifest: PluginManifest,
    task: TaskDefinition,
    arguments: dict[str, Any],
    timeout: float,
    on_event: TaskEvents,
    stage: Callable[[Path], None],
) -> dict[str, Any] | None:
    """The reference tool's output, from a scratch workspace the task never sees; None without one."""
    if task.reference is None:
        return None
    on_event("task.reference", {"tool": task.reference})
    with tempfile.TemporaryDirectory(prefix=f"nanoagent-{manifest.id}-reference-") as scratch:
        stage(Path(scratch))
        return await call_tool_async(manifest, task.reference, arguments, workspace=Path(scratch), timeout=timeout)


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
