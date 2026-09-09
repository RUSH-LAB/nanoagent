"""Minimal async agent loop: the model calls structured tools until it answers.

The agent seeds a system + user message, then loops: ask the model (advertising
``tools`` via OpenAI tool-calling), and
  * if the reply has no tool call -> that is the final answer, stop;
  * otherwise dispatch each tool call by name to its :class:`Tool`, append the
    results as ``role="tool"`` messages, and continue.

It stops early on ``max_steps``, ``cost_limit``, ``token_limit`` or ``context_window``. Tool
errors are fed back to the model (not raised) so it can recover. Token/cost usage is
accumulated across turns onto :class:`AgentResult`.

This is the ONLY agent loop in the package. The batch driver (:mod:`nanoagent.runtime.batch`,
a benchmark runner) calls :meth:`Agent.run` directly; the human-in-the-loop REPL
(:mod:`nanoagent.cli.repl.app`) drives the same method through its optional hooks
(``messages`` for a persistent transcript, ``on_delta`` for live streaming) and wraps its
model and tools to narrate and confirm — so there is no second loop to drift.

Two optional seams onto that loop, both ``None`` by default and each guarded at its call site,
so a run that does not use them executes exactly the code it did before they existed:
``hooks`` (:mod:`nanoagent.core.hooks`) can inject a reminder before a model call, short-circuit a
tool call, or observe one; ``events`` (:mod:`nanoagent.runtime.events`) mirrors the run to an NDJSON
stream. Both are split per-run inside :meth:`run` — a :class:`~nanoagent.core.hooks.RunHooks` and a
:class:`~nanoagent.runtime.events.RunEvents` — because the :class:`Agent` itself is shared.

Run many agents concurrently against one model with
``asyncio.gather(*(agent.run(t) for t in tasks))``; :meth:`run` keeps no state on the
instance, so one :class:`Agent` is safe to share across concurrent rollouts.

Clean-room: depends only on :mod:`nanoagent.core.tool` and the ``ChatModel`` duck-type below —
no ``openai`` import (the concrete backend lives in :mod:`nanoagent.runtime.model`, which adapts
inference ``Response`` objects into the :class:`Reply` shape this loop consumes).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol

from nanoagent.core.hooks import Hooks, RunHooks
from nanoagent.core.tool import build_tool_map, Tool

logger: logging.Logger = logging.getLogger(__name__)

# How many times Agent.run re-queries the model within ONE step when every tool call in the
# prior reply came back as an arg-shape error. The malformed assistant message and its tool
# results are discarded before each retry so the model sees the same prior context; if the cap
# is exhausted the bad results are kept and fed back as normal tool messages, so the model can
# still self-correct next step. Token/cost accounting still adds in the retried calls.
_MAX_TOOL_ARG_RETRIES = 2

# Appended as a user turn on the LAST step, where another tool call is a turn the answer never
# gets. Measured on Muse Glimmer (step6, 32 tasks): 31 runs ended max_steps_reached with an
# empty answer, which a scorer cannot score — and an all-empty GRPO group has uniform reward,
# so it yields no gradient at all. Deliberately says nothing about the answer's shape: the
# harness's system prompt owns that, and restating it here would let the two drift apart.
_LAST_STEP_PROMPT = (
    "This is your final turn — you have no steps left. Do not call any tools. "
    "Answer now with your best conclusion from what you have already found, "
    "in the format the instructions require. If you are unsure, give your most "
    "likely answer anyway and say how confident you are."
)

# Compact the history once a reply's prompt_tokens crosses this fraction of context_window —
# 0.8 leaves headroom for the next turn. Only used when the agent is built with compact=True.
_COMPACT_THRESHOLD = 0.8
# Messages kept verbatim at the tail when compacting (the most recent exchange); grown
# backwards over leading tool messages so an assistant tool-call is never split from its
# results (see compact_messages).
_COMPACT_KEEP_RECENT = 2
_COMPACT_PROMPT = (
    "Summarize the conversation so far. Preserve: key findings, decisions made, "
    "tool results that matter, and any outstanding tasks. Be concise."
)


@dataclass
class ToolCall:
    """A model-requested tool invocation, normalized away from any provider's shape."""

    id: str
    name: str
    arguments: str  # raw JSON string as emitted by the model


@dataclass
class Reply:
    """One model turn, normalized: text + tool calls + token usage + cost.

    The model backend (:mod:`nanoagent.runtime.model`) maps an inference ``Response`` into this; the
    loop consumes only this shape, so it never imports ``openai``.
    """

    content: str | None
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)  # prompt/completion/total tokens
    cost: float = 0.0
    # The model's separated reasoning / `<think>` trace when the backend provides it, else
    # None. Re-sent to the model as `reasoning_content` (see `assistant_message`).
    reasoning: str | None = None


class ChatModel(Protocol):
    """What :class:`Agent` needs from a model: one tool-calling chat turn -> a :class:`Reply`.

    ``on_delta(kind, text)`` streams fragments as they arrive (``kind`` is ``"reasoning"`` or
    ``"content"``). It is passed only when :meth:`Agent.run` was given an ``on_delta`` hook, so
    a model that does not stream can omit the parameter entirely — which is why it is not in
    the signature here. A caller that *requires* streaming asks for :class:`StreamingChatModel`.
    """

    async def query(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> Reply: ...


class StreamingChatModel(ChatModel, Protocol):
    """A :class:`ChatModel` that also accepts the ``on_delta`` hook by name.

    The loop only ever splats ``on_delta`` in (see ``stream`` in :meth:`Agent.run`), so plain
    :class:`ChatModel` is right for it: a non-streaming model is usable there. The REPL is not
    like that — :class:`~nanoagent.cli.repl.app._Narrating` exists to print the stream, and calls
    ``query(..., on_delta=...)`` by keyword — so it asks for this instead, and a model that
    cannot stream is rejected where it is handed over rather than at the call.
    """

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Callable[[str, str], None] | None = None,
    ) -> Reply: ...


class StopReason(StrEnum):
    """How an agent run ended. A ``StrEnum`` so members serialize as their plain string value
    (JSON-compatible, comparable to the raw strings in saved trajectories)."""

    ANSWER = "answer"  # model returned no tool call — that reply is the final answer
    MAX_STEPS = "max_steps_reached"  # ran out of model turns
    COST_LIMIT = "cost_limit"  # accumulated cost hit the configured cap
    TOKEN_LIMIT = "token_limit"  # accumulated total tokens hit the configured cap
    # the just-returned reply's prompt_tokens met/exceeded context_window, so the next turn
    # would overflow — stop now. Only reachable when the agent was built with compact=False.
    CONTEXT_WINDOW = "context_window"
    INTERRUPTED = "interrupted"  # user aborted the run (Ctrl-C); set by the REPL, not by run()
    ERROR = "error"  # an exception was raised mid-run
    RUNNING = "running"  # intermediate snapshot, not a terminal state


@dataclass
class AgentResult:
    """Outcome of one :meth:`Agent.run`."""

    answer: str
    messages: list[dict[str, Any]]
    tool_calls: list[dict[str, Any]]
    steps: int
    stop_reason: StopReason
    usage: dict[str, int] = field(default_factory=dict)
    cost: float = 0.0
    # Wall-clock seconds per step, split into ``{"model", "tools"}`` — the model query vs its
    # tool dispatch. One entry per completed step, in order; ``tools`` is 0.0 on the final
    # answer step. Summing either key gives that phase's total time.
    step_durations: list[dict[str, float]] = field(default_factory=list)
    error: str | None = None


class RunEventCallbacks(Protocol):
    """Per-run callback adapter supplied by an outer runtime."""

    def tee(self, on_step: Callable[[AgentResult], None] | None) -> Callable[[AgentResult], None]: ...

    def tee_delta(
        self, on_delta: Callable[[str, str], None]
    ) -> Callable[[str, str], None]: ...


class EventObserver(Protocol):
    """Factory for per-run callbacks; keeps persistence and transport outside the core loop."""

    def begin(self, label: str | None) -> RunEventCallbacks: ...


class Agent:
    def __init__(
        self,
        model: ChatModel,
        tools: Sequence[Tool],
        *,
        system_prompt: str,
        max_steps: int = 20,
        cost_limit: float | None = None,
        token_limit: int | None = None,
        context_window: int | None = None,
        compact: bool = False,
        hooks: Hooks | None = None,
        events: EventObserver | None = None,
    ) -> None:
        """``compact`` picks the ``context_window`` policy: ``False`` (the default, used by every
        batch/benchmark rollout) hard-stops with :attr:`StopReason.CONTEXT_WINDOW` once a reply's
        prompt fills the window; ``True`` (used by the REPL, where a session must survive) instead
        summarizes older turns at 80% of it and keeps going. ``context_window=None`` disables both.

        ``hooks`` (see :mod:`nanoagent.core.hooks`) lets a config steer the loop — inject a reminder,
        refuse a tool call — without editing it. ``events`` (see :mod:`nanoagent.runtime.events`) is the
        opposite: it only watches, mirroring the run to an NDJSON stream. ``None``, the default
        for both, is not a no-op but no call at all.
        """
        self._tools = build_tool_map(tools)
        self._model = model
        self._tool_specs = [t.to_openai_spec() for t in tools]
        self._system_prompt = system_prompt
        self._max_steps = max_steps
        self._cost_limit = cost_limit
        self._token_limit = token_limit
        self._context_window = context_window
        self._compact = compact
        self._hooks = hooks
        self._events = events
        for tool in tools:
            tool.bind(self)

    @property
    def system_prompt(self) -> str:
        """The fully resolved prompt this agent places at the start of a new transcript."""
        return self._system_prompt

    def add_tool(self, tool: Tool) -> None:
        """Register ``tool`` for the rest of this agent's life — callable on the next turn.

        Rebuilds the dispatch map through :func:`~nanoagent.core.tool.build_tool_map` so a name
        collision is rejected here rather than silently shadowing an existing tool.
        """
        self._tools = build_tool_map([*self._tools.values(), tool])
        self._tool_specs.append(tool.to_openai_spec())
        tool.bind(self)

    async def run(
        self,
        task: str | None = None,
        *,
        on_step: Callable[[AgentResult], None] | None = None,
        label: str | None = None,
        messages: list[dict[str, Any]] | None = None,
        on_delta: Callable[[str, str], None] | None = None,
    ) -> AgentResult:
        """Drive the agent until it answers or hits a limit.

        ``messages`` defaults to a fresh ``[system, user(task)]`` — the batch path. Pass a list
        instead and it is used AS the transcript and mutated in place (``task``, when given, is
        appended to it first), which is how the REPL carries one conversation across follow-up
        tasks while :class:`Agent` itself stays stateless and shareable.

        ``on_step`` (if given) is called with the partial :class:`AgentResult` after every turn —
        use it to stream a trajectory to disk so a mid-run crash isn't lost. ``on_delta`` is the
        REPL's rendering hook, forwarded to the model as its streaming callback. On an unexpected
        exception the partial result is recorded (``stop_reason="error"``), passed to ``on_step``,
        and re-raised. ``label`` (e.g. the task id) is prefixed to this run's log
        lines so they're attributable when many rollouts log to one console.
        """
        tag = f"[{label}] " if label is not None else ""
        for tool in self._tools.values():
            tool.reset()
        if messages is None:
            messages = [{"role": "system", "content": self._system_prompt}]
            if task is not None:
                messages.append({"role": "user", "content": task})
        elif task is not None:
            messages.append({"role": "user", "content": task})
        # Bound once: `messages` is not reassigned below (compaction splices in place), so the
        # closure and every `messages.append` share the caller's list.
        transcript = messages
        # This run's own hook state, for the same reason the tools are reset above: `self` is
        # shared across concurrent rollouts, so nothing per-run may live on it.
        hooks = self._hooks.begin(transcript) if self._hooks is not None else None
        if hooks is not None:
            hooks.fire("session_start", step=0)
        # Same per-run split, and done here rather than in each driver because `label` — the only
        # thing telling concurrent rollouts apart in a shared stream — is only in scope here. The
        # caller's callbacks still run; `on_delta` is teed only if there already was one, since
        # passing one where the caller passed none would switch a batch model into streaming.
        if self._events is not None:
            events = self._events.begin(label)
            on_step = events.tee(on_step)
            if on_delta is not None:
                on_delta = events.tee_delta(on_delta)
        call_log: list[dict[str, Any]] = []
        usage: dict[str, int] = {}
        cost = 0.0
        step_durations: list[dict[str, float]] = []
        # Passed to model.query only when the caller wants streaming, so a ChatModel with no
        # `on_delta` parameter (every batch-path fake) is still called exactly as before.
        stream = {"on_delta": on_delta} if on_delta is not None else {}

        def result(
            steps: int, stop_reason: StopReason, answer: str, error: str | None = None
        ) -> AgentResult:
            return AgentResult(
                answer,
                transcript,
                call_log,
                steps,
                stop_reason,
                dict(usage),
                cost,
                list(step_durations),
                error,
            )

        # Timing of the in-flight step, or None between steps. Built incrementally: a
        # malformed-arg retry re-queries and re-dispatches within one step, so both phases are
        # `+=` sums. Cleared once appended, so the `except` handler can record a step that died
        # mid-flight with whatever phases completed, without double-counting.
        pending: dict[str, float] | None = None
        try:
            for step in range(self._max_steps):
                if self._cost_limit is not None and cost >= self._cost_limit:
                    return _emit(
                        on_step,
                        result(step, StopReason.COST_LIMIT, last_assistant_text(transcript)),
                    )
                if (
                    self._token_limit is not None
                    and usage.get("total_tokens", 0) >= self._token_limit
                ):
                    return _emit(
                        on_step,
                        result(step, StopReason.TOKEN_LIMIT, last_assistant_text(transcript)),
                    )
                # Ask for the answer outright instead of letting the loop expire mid-investigation
                # (see _LAST_STEP_PROMPT). This spends NO query beyond max_steps: the final turn
                # answers rather than searching. Tool specs stay attached — the model complies
                # without them being withdrawn, and dropping them would change the prompt prefix
                # and cost the server's cached KV for this turn.
                if step == self._max_steps - 1:
                    transcript.append({"role": "user", "content": _LAST_STEP_PROMPT})
                pending = {"model": 0.0, "tools": 0.0}
                # Once per STEP, not per query: the retry loop below re-queries with the same
                # context, and a reminder appended per attempt would stack up three copies.
                if hooks is not None:
                    reminder = hooks.fire("before_llm", step=step)
                    if reminder is not None:
                        transcript.append({"role": "user", "content": reminder})
                # Inner loop: re-query when EVERY tool call in the reply was an arg-shape
                # malformation (see _is_arg_malformed). The malformed assistant + tool messages
                # are never appended, so the retry sees the same context the bad turn did.
                # Stateless re-query: we re-send the full growing transcript every step (no
                # session API); SGLang's RadixAttention prefix cache reuses the unchanged-prefix
                # KV so only newly appended tokens are prefilled — keep the server's radix cache
                # enabled (never --disable-radix-cache; see SGLangServeConfig.extra_args).
                attempt = 0
                # Bound before the loop because the `break` on a tool-call-free reply skips the
                # dispatch that would set them. That path returns before reaching the extend()s
                # below, so these values are never read — but only the loop's control flow says
                # so, which is more than a reader (or a checker) should have to reconstruct.
                log_rows: list[dict[str, Any]] = []
                tool_msgs: list[dict[str, Any]] = []
                while True:
                    tm = time.monotonic()
                    try:
                        reply = await self._model.query(transcript, self._tool_specs, **stream)
                    except Exception as e:
                        # SGLang / OpenAI-compatible servers reject UPFRONT (HTTP 400) when
                        # prompt_tokens + max_tokens > context_length — the request never reaches
                        # the GPU, so the post-reply check below can't see it. Match on the
                        # canonical error substring rather than importing the openai exception
                        # class: keeps this module provider-agnostic.
                        if "maximum context length" not in str(e):
                            raise
                        pending["model"] += time.monotonic() - tm
                        step_durations.append(pending)
                        pending = None
                        logger.warning(
                            "%sagent step %d: server rejected request as over context length, stopping",
                            tag,
                            step + 1,
                        )
                        return _emit(
                            on_step,
                            result(
                                step + 1,
                                StopReason.CONTEXT_WINDOW,
                                last_assistant_text(transcript),
                            ),
                        )
                    pending["model"] += time.monotonic() - tm
                    _accumulate(usage, reply.usage)
                    cost += reply.cost
                    # Hard stop (compact=False): the prompt we just SENT already filled the
                    # window, so the next turn would overflow. Accept this reply as the final
                    # answer text, append it for the trajectory, and stop — we do NOT dispatch
                    # any tool calls it carried.
                    if (
                        not self._compact
                        and self._context_window is not None
                        and reply.usage.get("prompt_tokens", 0) >= self._context_window
                    ):
                        transcript.append(assistant_message(reply))
                        step_durations.append(pending)
                        pending = None
                        return _emit(
                            on_step,
                            result(
                                step + 1,
                                StopReason.CONTEXT_WINDOW,
                                reply.content or last_assistant_text(transcript),
                            ),
                        )
                    if not reply.tool_calls:
                        break  # final answer — no dispatch to retry on
                    td = time.monotonic()
                    log_rows, tool_msgs = await self._dispatch(reply.tool_calls, step, hooks)
                    pending["tools"] += time.monotonic() - td
                    if attempt < _MAX_TOOL_ARG_RETRIES and all(
                        _is_arg_malformed(r["output"]) for r in log_rows
                    ):
                        attempt += 1
                        # Name each failed call + its malformation reason so the warning says
                        # WHICH tool and why.
                        failed = "; ".join(
                            f"{r['name']}: {r['output'].replace(chr(10), ' ')[:150]}"
                            for r in log_rows
                        )
                        logger.warning(
                            "%sagent step %d: all %d tool call(s) malformed; retrying (%d/%d) — %s",
                            tag,
                            step + 1,
                            len(log_rows),
                            attempt,
                            _MAX_TOOL_ARG_RETRIES,
                            failed,
                        )
                        continue
                    break
                transcript.append(assistant_message(reply))
                if not reply.tool_calls:
                    step_durations.append(pending)
                    pending = None
                    return _emit(
                        on_step, result(step + 1, StopReason.ANSWER, reply.content or "")
                    )
                logger.debug(
                    "%sagent step %d/%d: %d tool call(s)",
                    tag,
                    step + 1,
                    self._max_steps,
                    len(reply.tool_calls),
                )
                call_log.extend(log_rows)
                transcript.extend(tool_msgs)
                # Compaction (compact=True) runs at the END of the step, once the assistant turn
                # and ALL its tool results are in: summarizing mid-step could split a tool call
                # from its results, which the chat API rejects. Its summarization turn is real
                # model latency, so it lands in this step's "model" time.
                if self._compact and needs_compaction(
                    self._context_window, reply.usage.get("prompt_tokens", 0)
                ):
                    tc = time.monotonic()
                    transcript[:] = await compact_messages(self._model, transcript)
                    pending["model"] += time.monotonic() - tc
                step_durations.append(pending)
                pending = None
                if on_step is not None:
                    on_step(result(step + 1, StopReason.RUNNING, reply.content or ""))
            return _emit(
                on_step,
                result(self._max_steps, StopReason.MAX_STEPS, last_assistant_text(transcript)),
            )
        except Exception as e:
            logger.exception("%sagent run failed", tag)
            if pending is not None:
                step_durations.append(pending)
            _emit(
                on_step,
                result(
                    len(call_log),
                    StopReason.ERROR,
                    last_assistant_text(transcript),
                    f"{type(e).__name__}: {e}",
                ),
            )
            raise
        finally:
            # Counterpart of the start-of-run reset(): on EVERY exit path let each tool free its
            # per-task resources. The fan-out path runs each rollout in its OWN asyncio context,
            # so a start-of-run reset() never wipes that context's dir — without this finally a
            # tool like CodeExec leaks the sandbox dir it created. cleanup() does file I/O with
            # ignore_errors, so it can't mask a re-raised exception.
            for tool in self._tools.values():
                tool.cleanup()

    async def _dispatch(
        self, calls: list[ToolCall], step: int = 0, hooks: RunHooks | None = None
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Invoke every tool call concurrently; return (call_log rows, role=tool messages) in INPUT order.

        Returns BOTH lists so the caller can decide whether to commit them (normal step) or
        discard them (the retry-on-malformation path). Building the rows from gather's INPUT-
        ordered result here, rather than appending inside each per-call coroutine, keeps the
        ordering deterministic: a post-await append would land in COMPLETION order, so for
        genuinely suspending async tools the rows would disagree with the role="tool" messages.
        """
        results = await asyncio.gather(*(self._run_one(c, step, hooks) for c in calls))
        return [row for row, _msg in results], [msg for _row, msg in results]

    async def _run_one(
        self, call: ToolCall, step: int = 0, hooks: RunHooks | None = None
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        if hooks is None:
            text, is_error, args = await invoke_tool_call(self._tools, call)
        else:
            text, is_error, args = await self._run_one_hooked(call, step, hooks)
        # `id` links this log row to its `role="tool"` message (by tool_call_id) so the saved
        # trajectory can inline `is_error` onto that message (trajectory._annotate_messages).
        log_row = {
            "id": call.id,
            "name": call.name,
            "arguments": args,
            "output": text,
            "is_error": is_error,
        }
        return log_row, {"role": "tool", "tool_call_id": call.id, "content": text}

    async def _run_one_hooked(
        self, call: ToolCall, step: int, hooks: RunHooks
    ) -> tuple[str, bool, dict[str, Any]]:
        """:func:`invoke_tool_call` wrapped in the ``before_tool`` / ``after_tool`` triggers.

        A ``before_tool`` string short-circuits: the tool never runs and that string becomes the
        result, flagged ``is_error`` so it reads to the model exactly like a tool that refused —
        which is what the loop already knows how to feed back. Arguments are parsed here to show
        the hook what was actually asked for; a malformation is left as ``{}`` for the hook and
        re-diagnosed by :func:`invoke_tool_call`, which owns that error text.
        """
        try:
            parsed = json.loads(call.arguments or "{}")
        except json.JSONDecodeError:
            parsed = None
        args = parsed if isinstance(parsed, dict) else {}
        refusal = hooks.fire("before_tool", step=step, tool_name=call.name, tool_input=args)
        if refusal is not None:
            text, is_error = refusal, True
        else:
            text, is_error, args = await invoke_tool_call(self._tools, call)
        hooks.fire(
            "after_tool",
            step=step,
            tool_name=call.name,
            tool_input=args,
            tool_output=text,
            is_error=is_error,
        )
        return text, is_error, args


# Marker prefixes for tool-result text whose error stems from the model emitting a malformed
# call shape. These are the only errors a fresh re-query can plausibly fix (the model wrote the
# wrong call); a tool whose run() raised some OTHER exception would re-fire identically and is
# intentionally not retried — its error text goes back as a normal tool result instead.
_ARG_MALFORMED_PREFIXES = (
    "Error: invalid JSON arguments",
    "Error: tool arguments must be a JSON object",
    "Error: unknown tool ",
    "Error: TypeError:",  # arg-shape mismatch raised when calling tool.run(**args)
)


def _is_arg_malformed(text: str) -> bool:
    """True when ``text`` is a tool result whose error came from a malformed call shape."""
    return any(text.startswith(p) for p in _ARG_MALFORMED_PREFIXES)


def _unquote_arg_keys(args: dict[str, Any]) -> dict[str, Any]:
    """Strip a surrounding quote pair from each arg key (``'"query"'`` -> ``'query'``).

    Some served tool-call parsers (SGLang's gemma4 on quote-heavy argument values) emit the
    argument NAME wrapped in literal quotes, so ``json.loads`` yields ``{'"query"': ...}`` and
    ``tool.run(**args)`` then rejects an unknown kwarg. A real arg name never starts and ends
    with a quote, so unwrapping a matching pair recovers the call without affecting valid ones.
    """
    return {
        (
            k[1:-1]
            if isinstance(k, str) and len(k) >= 2 and k[0] == k[-1] and k[0] in "\"'"
            else k
        ): v
        for k, v in args.items()
    }


async def invoke_tool_call(
    tools: dict[str, Tool], call: ToolCall
) -> tuple[str, bool, dict[str, Any]]:
    """Parse a tool call's JSON arguments and dispatch it to the named tool.

    Returns ``(output_text, is_error, parsed_args)``. Bad JSON, arguments that aren't a JSON
    object, an unknown tool name, or a tool that reports failure all come back as
    ``is_error=True`` text (never raised) so the caller can feed the message back to the model;
    ``parsed_args`` is ``{}`` in the first three cases.
    """
    try:
        args = json.loads(call.arguments or "{}")
    except json.JSONDecodeError as e:
        return f"Error: invalid JSON arguments: {e}", True, {}
    if not isinstance(args, dict):
        return f"Error: tool arguments must be a JSON object, got {type(args).__name__}", True, {}
    args = _unquote_arg_keys(args)  # recover keys a tool-call parser wrapped in quotes
    tool = tools.get(call.name)
    if tool is None:
        return f"Error: unknown tool {call.name!r}; available: {', '.join(sorted(tools))}", True, {}
    text, is_error = await tool.invoke(**args)
    return text, is_error, args


def _emit(
    on_step: Callable[[AgentResult], None] | None, result: AgentResult
) -> AgentResult:
    if on_step is not None:
        on_step(result)
    return result


def _accumulate(total: dict[str, int], delta: dict[str, int]) -> None:
    for key, value in delta.items():
        total[key] = total.get(key, 0) + value


def assistant_message(reply: Reply) -> dict[str, Any]:
    """Convert a :class:`Reply` into a re-sendable assistant message dict.

    Preserves ``tool_calls`` so the next request shows the assistant's call right before its
    matching ``role="tool"`` results — the API requires that pairing.

    Also replays the turn's reasoning as ``reasoning_content``. A reasoning-parser server strips
    the trace out of ``content``, so dropping it here would hand the model back a turn in which
    it called a tool for no stated reason: it then re-derives the same plan from scratch every
    step instead of building on it. Both served chat templates expect the field (gemma-4 renders
    it as a `thought` channel; Muse Glimmer re-emits it as its `to=self` channel) and ignore it
    when absent, so the template — not this function — decides when a trace is in scope.
    """
    out: dict[str, Any] = {"role": "assistant", "content": reply.content}
    if reply.reasoning:
        out["reasoning_content"] = reply.reasoning
    if reply.tool_calls:
        out["tool_calls"] = [
            {
                "id": c.id,
                "type": "function",
                "function": {"name": c.name, "arguments": c.arguments},
            }
            for c in reply.tool_calls
        ]
    return out


def last_assistant_text(messages: list[dict[str, Any]]) -> str:
    """Best-effort answer when the loop stops without a clean final reply."""
    for msg in reversed(messages):
        if msg.get("role") == "assistant" and msg.get("content"):
            return str(msg["content"])
    return ""


def needs_compaction(context_window: int | None, prompt_tokens: int) -> bool:
    """True when ``prompt_tokens`` has crossed the compaction threshold for ``context_window``.

    ``context_window`` of ``None`` disables compaction entirely.
    """
    return context_window is not None and prompt_tokens > context_window * _COMPACT_THRESHOLD


async def compact_messages(
    model: ChatModel, messages: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Summarize the middle of ``messages`` to reclaim context, preserving both ends.

    Keeps the system prompt (``messages[0]``) and the most recent exchange verbatim, asks
    ``model`` to summarize everything in between, and splices that summary back in as one
    ``user`` message. The model is queried with no tools so it can only write prose, never try
    to act mid-summary. The kept tail is extended backwards over any leading ``role="tool"``
    messages so an assistant's tool call is never separated from its results (the chat API
    rejects that pairing). Returns ``messages`` unchanged unless at least two messages sit
    between the system prompt and the kept tail: folding fewer cannot shrink the list and would
    only burn a model call and lossily rewrite the original task. The summarization turn's own
    tokens are intentionally not added to the run's usage/cost — it is bookkeeping, not task
    work. NOTE: size ``context_window`` above the system prompt plus one full exchange; a
    tighter budget keeps the kept tail itself over the threshold, so compaction then runs every
    turn (still bounded and valid, just costlier).
    """
    keep_from = len(messages) - _COMPACT_KEEP_RECENT
    while keep_from > 1 and messages[keep_from].get("role") == "tool":
        keep_from -= 1
    if keep_from <= 2:
        return messages
    middle = messages[1:keep_from]
    reply = await model.query([*middle, {"role": "user", "content": _COMPACT_PROMPT}], [])
    summary = {
        "role": "user",
        "content": f"Summary of earlier conversation:\n{reply.content or ''}",
    }
    return [messages[0], summary, *messages[keep_from:]]
