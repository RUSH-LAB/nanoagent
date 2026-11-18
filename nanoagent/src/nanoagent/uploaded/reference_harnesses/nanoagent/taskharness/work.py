"""Working the task: the agent loop, or the decide loop, composed from NanoAgent's own parts.

This is what `nanoagent.plugin.tasks.run_task` does for an agent or decide task, minus what the benchmark owns: it pins
no reference and calls no verifier, and the tools are the broker's rather than a local plugin process.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from nanoagent.core.agent import Agent, AgentResult, DecisionModel, Reply, StopReason, ToolCall
from nanoagent.core.messages import assistant_message
from nanoagent.core.tool import Tool
from nanoagent.plugin.dataflow import Answers, Decider, Question, answer_schema, check, fill, values
from nanoagent.profiler import Profiler
from taskharness import screen
from taskharness.broker import CURRENT_TOOL_CALL, Broker, BrokerTool, ToolSpec
from taskharness.events import CURRENT_SPAN
from taskharness.schema_types import SchemaTypes, validator

SUBMIT = "submit"  # the tool an agent submits through, and the option a decider picks to submit
ANSWER = "answer"  # the name a decider's model answers under


class SpanSink(Protocol):
    async def start(self, kind: str, name: str, *, parent: str | None = None) -> str: ...

    async def end(self, span: str, status: str = "ok") -> None: ...


@dataclass(frozen=True)
class Outcome:
    """What the task's work ended with: a submitted output, or the text of an agent that ended without one."""

    output: dict[str, Any] | None
    refusal: str | None


class SubmitTool(Tool):
    """Submit the task's result. Call it once the task is done; if you call it again, the last
    submission is the result."""

    def __init__(self, output_schema: dict[str, Any]) -> None:
        self.NAME = SUBMIT
        self.PARAMETERS = output_schema
        self._check = validator(output_schema)
        self.output: dict[str, Any] | None = None

    def run(self, **arguments: Any) -> str:
        self._check(arguments)
        self.output = arguments
        return "Submitted."


class ModelDecider:
    """A :class:`~nanoagent.plugin.dataflow.Decider` that asks ``model`` once per batch of questions, as
    `nanoagent.plugin.tasks.ModelDecider` does: the system prompt, then one user message with the state and the questions."""

    def __init__(self, model: DecisionModel, system: str | None, *, max_steps: int) -> None:
        self._model = model
        self._messages: list[dict[str, Any]] = [{"role": "system", "content": system}] if system is not None else []
        self._max_steps = max_steps
        self._profiler = Profiler()

    async def decide(self, state: dict[str, Any], questions: list[Question]) -> Answers:
        spent = self._profiler.snapshot()
        if len(spent.steps) >= self._max_steps:
            raise RuntimeError(f"the decider made its {self._max_steps} requests (max_model_calls) and the task is not done")
        asked = "\n".join(f"- {question.id}: {question.text}\n  options: {', '.join(question.options)}" for question in questions)
        user = {"role": "user", "content": f"State:\n{json.dumps(state, indent=2)}\n\nQuestions:\n{asked}"}
        step = self._profiler.start_step(len(spent.steps) + 1)
        timer = step.start_model_call()
        try:
            answer = await self._model.answer([*self._messages[:1], user], name=ANSWER, schema=answer_schema(questions))
        except Exception as error:
            step.finish_model_call(timer, error=f"{type(error).__name__}: {error}")
            step.finish()
            raise
        record = step.finish_model_call(timer, usage=answer.usage, cost=answer.cost)
        step.finish()
        call = ToolCall(id=f"{ANSWER}-{len(self._profiler.snapshot().steps)}", name=ANSWER, arguments=json.dumps(answer.value))
        self._messages += [user, assistant_message(Reply(content=None, tool_calls=[call]))]
        screen.decided(answer.value)
        return Answers(answer.value, model_calls=(record.to_dict(),))

    def record(self) -> AgentResult | None:
        return None


async def work_agent(
    *, system: str, user: str, output_schema: dict[str, Any], tools: list[ToolSpec], broker: Broker, model: Any, max_steps: int,
    ask: Callable[[], Awaitable[str | None]] | None = None,
) -> Outcome:
    """The agent works the task with the broker's tools and `submit`; no submission is a refusal when it ended with text. With
    ``ask`` (a person at the terminal) each turn is followed by what ``ask`` returns, in the same conversation, until it returns None."""
    submit = SubmitTool(output_schema)
    agent = Agent(model, [*(BrokerTool(spec, broker) for spec in tools), submit], system_prompt=system, max_steps=max_steps)

    def on_tool(event: dict[str, Any]) -> None:
        if event["type"] == "tool_start":
            CURRENT_TOOL_CALL.set(event["id"])

    transcript: list[dict[str, Any]] = [{"role": "system", "content": system}]
    turn: str | None = user
    while turn is not None:
        result = await agent.run(turn, messages=transcript, on_tool=on_tool)
        if result.stop_reason is not StopReason.ANSWER and submit.output is None:
            break
        turn = await ask() if ask is not None else None
    if submit.output is not None:
        return Outcome(submit.output, None)
    if result.stop_reason is StopReason.ANSWER:
        return Outcome(None, result.answer.strip() or f"the agent ended without calling {SUBMIT}")
    raise RuntimeError(result.error or f"the agent stopped ({result.stop_reason}) without calling {SUBMIT}")


async def work_decide(
    *,
    system: str | None,
    arguments: dict[str, Any],
    input_schema: dict[str, Any],
    output_schema: dict[str, Any],
    tools: list[ToolSpec],
    broker: Broker,
    model: DecisionModel,
    max_steps: int,
    spans: SpanSink | None,
    root_span: str | None,
    decider: Decider | None = None,
) -> dict[str, Any]:
    """Decide the task: every value chosen by the decider or copied; each batch of choices is a `decision` span, and the
    tool call it builds is sent as the harness's own call under the last of them."""
    types = SchemaTypes()
    input_type = types.build(input_schema, "Input")
    output_type = types.build(output_schema, "Output")
    tool_types = {spec.name: (types.build(spec.input_schema, f"{spec.name}_input"), types.build(spec.output_schema, f"{spec.name}_output")) for spec in tools}
    check_output = validator(output_schema)
    decider = decider or ModelDecider(model, system, max_steps=max_steps)
    names = tuple(spec.name for spec in tools)
    state: dict[str, Any] = {"input": arguments, "calls": []}
    open_span: str | None = None

    async def close_span(status: str = "ok") -> None:
        nonlocal open_span
        if open_span is not None and spans is not None:
            await spans.end(open_span, status)
        open_span = None
        CURRENT_SPAN.set(root_span)

    async def ask(questions: list[Question], forced: dict[str, str]) -> dict[str, str | list[str]]:
        nonlocal open_span
        await close_span()
        if spans is not None:
            open_span = await spans.start("decision", "decide", parent=root_span)
            CURRENT_SPAN.set(open_span)
        answers = await decider.decide(state, questions) if questions else Answers({})
        check(questions, answers)
        return answers.values

    try:
        while True:
            pool = values(arguments, input_type, "input")
            for index, call in enumerate(state["calls"]):
                pool += values(call["output"], tool_types[call["tool"]][1], f"calls[{index}].output")
            step = Question("next", "one", "What comes next: a tool to call, or submit the task's output?", (*names, SUBMIT), "next")
            [chosen] = (await ask([step], {})).values()
            if chosen == SUBMIT:
                output = await fill(output_type, "output", pool, ask)
                break
            at = f"calls[{len(state['calls'])}]"
            tool_input = await fill(tool_types[chosen][0], f"{at}.arguments", pool, ask)
            tool_output = await broker.call(chosen, tool_input)
            state["calls"].append({"tool": chosen, "arguments": tool_input, "output": tool_output})
        check_output(output)
    except BaseException:
        await close_span("error")
        raise
    await close_span()
    return output
