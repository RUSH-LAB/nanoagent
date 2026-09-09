"""Interactive terminal session for the nanoagent agent — mini-swe-agent's `mini` UX.

Type a task, then watch the agent work step by step. Three modes (mini-faithful):

* **confirm** (default) — each proposed tool call waits for you: Enter runs it, a typed
  comment rejects it (the comment is fed back to the model so it re-plans).
* **yolo** — tool calls run immediately.
* **human** — *you* drive: type a shell command and it runs via the bash tool right away;
  switch back to ``/c`` / ``/y`` to hand control to the model.

Slash commands at any prompt: ``/y`` yolo · ``/c`` confirm · ``/u`` human · ``/m`` multiline
comment, all four answered by the reader because they change what the read means; everything
else comes from the table in :mod:`nanoagent.cli.repl.commands` — ``/h`` help · ``/tree`` repo overview ·
``/model <name>`` swap model · ``/img <path>`` show an image · ``/fork`` ``/branches``
``/switch <n>`` for the transcript tree — plus one ``/<stem>`` per ``.md`` in ``commands:``.
Ctrl-C interrupts the current step (aborts the in-flight generation) and drops to the follow-up
prompt; the session stays alive. When the agent finishes, type a follow-up to continue the same
conversation, or Enter to quit.

This module holds NO agent loop of its own: :class:`InteractiveSession` drives
:meth:`nanoagent.core.agent.Agent.run` — the same loop the batch/benchmark path runs — over a
persistent message list, and layers the REPL on top through two wrappers. :class:`_Narrating`
wraps the model (step banner, live streaming, usage footer, Ctrl-C) and :class:`_Gated` wraps
each tool (print the call, ask before running it in confirm mode, print the result). Human mode
is a pre-loop that runs before the agent is handed control. So chat and batch can never drift.

Run (yaml-driven, no flags — a chat YAML is a harness YAML plus the REPL-only leaves `task`,
`yolo`, `output`, `resume`, `commands`, `models`, `theme`, `images`). The toolset comes from the
config's `tools` list; human mode needs a tool named ``bash`` in it to run shell commands directly:
  nanoagent chat chat_cfg=mychat.yaml output=expdir/chat

The session trajectory is always saved on exit, named by the time the chat started:
``<output>/<yymmdd-hhmmss>.traj.json``, where ``output`` is the folder to save into (null = the
default ``expdir/chat/``). If you forked, the whole tree is saved beside it as
``<same>.session.json``, which ``resume:`` reads back — as does a plain ``.traj.json``, which
resumes as a single branch.
"""

from __future__ import annotations

import asyncio
import json
import logging
import select
import signal
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from nanoagent.runtime import log_capture
from nanoagent.runtime import trajectory
from nanoagent.core.agent import (
    _accumulate,
    Agent,
    AgentResult,
    StreamingChatModel,
    last_assistant_text,
    Reply,
    StopReason,
)
from nanoagent.runtime.build import build_prompt_and_tools
from nanoagent.cli.repl.commands import BUILTINS, Command, DEFAULT_THEME, image_in, inline_image, prompt_commands
from nanoagent.runtime.config import InteractiveConfig, load_config_args, ModelConfig, RunConfig
from nanoagent.runtime.events import EventWriter
from nanoagent.core.hooks import Hooks
from nanoagent.extensions import get_hooks
from nanoagent.runtime.model import Model
from nanoagent.cli.repl.tree import load as load_session, SESSION_SUFFIX, SessionTree
from nanoagent.core.tool import build_tool_map, JsonSchema, Tool
from rich.console import Console
from rich.rule import Rule
from rich.theme import Theme

# Default trajectory location when `output` is unset (relative to the CWD).
DEFAULT_TRAJ_DIR = "./expdir/"

Mode = Literal["confirm", "yolo", "human"]
_MODE_COMMANDS: dict[str, Mode] = {"/y": "yolo", "/c": "confirm", "/u": "human"}
# Name of the tool :class:`~nanoagent.tools.bash.Bash` registers; used to look it up in human mode.
_BASH_TOOL = "bash"


@dataclass(frozen=True)
class ReplOptions:
    """The REPL-only leaves — what a chat session has that a batch rollout does not.

    One object rather than four parameters because they travel together the whole way, from
    ``InteractiveConfig`` through :func:`run_and_save` into :class:`InteractiveSession`.
    """

    commands: list[str] = field(default_factory=list)  # .md prompt templates -> /<stem>
    models: dict[str, ModelConfig] = field(default_factory=dict)  # what /model can switch to
    theme: dict[str, str] = field(default_factory=dict)  # rich style overrides
    images: bool = False  # draw images inline in the terminal


def _input_reader(prompt: str) -> str:
    """Default reader: show ``prompt`` and read one line — coalescing a multi-line paste.

    A paste lands in the terminal buffer as several complete lines at once, but stdlib
    ``input()`` returns only the first; the rest would be read by the *next* prompt and
    mis-interpreted as separate follow-up tasks (paste the previous transcript and you'd
    fire a task per line). So after the first line, drain any lines already waiting —
    ``select`` sees a paste's buffered lines but not human typing, which has keystroke-level
    gaps between newlines — and join them so the whole paste is one task. Falls back to just
    the first line if stdin can't be polled (e.g. no ``fileno``).
    """
    try:
        first = input(prompt)
    except EOFError:
        return ""
    lines = [first]
    try:
        while select.select([sys.stdin], [], [], 0.05)[0]:
            extra = sys.stdin.readline()
            if not extra:  # EOF
                break
            lines.append(extra.rstrip("\n"))
    except (OSError, ValueError):
        pass  # stdin not pollable (no fileno) — use just the first line
    return "\n".join(lines)


class _Narrating:
    """Wraps the session's model: banner + live stream + usage footer, interruptible by Ctrl-C.

    Sits between :class:`~nanoagent.core.agent.Agent` and the real model so everything the REPL
    prints about a model turn happens where that turn happens — no per-step hook on the loop.
    Only turns carrying an ``on_delta`` are narrated, which is exactly the loop's own turns;
    ``compact_messages``' summarization query passes none and stays silent.
    """

    def __init__(self, inner: StreamingChatModel, console: Console) -> None:
        self._inner = inner
        self._console = console
        self._step = 0
        self._cost = 0.0
        # Which stream section ("reasoning" / "content") is currently open, or None.
        self._section: str | None = None

    def on_delta(self, kind: str, text: str) -> None:
        """Print one streamed fragment — reasoning dimmed, the answer in normal weight.

        Handed to :meth:`Agent.run` as its ``on_delta``, so a long or runaway generation is
        visible in real time instead of behind a frozen prompt. Model text is printed with
        ``markup=False`` (a stray ``[...]`` isn't eaten as Rich markup) and ``soft_wrap=True``
        (Rich doesn't crop or hard-wrap mid-stream).
        """
        if kind != self._section:
            if self._section is not None:
                self._console.print()  # end the previous section's line
            if kind == "reasoning":
                self._console.print("[dim italic]thinking…[/]")
            self._section = kind
        self._console.print(
            text,
            end="",
            style="dim" if kind == "reasoning" else None,
            markup=False,
            highlight=False,
            soft_wrap=True,
        )

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Callable[[str, str], None] | None = None,
    ) -> Reply:
        if on_delta is None:  # a compaction turn — run it silently
            return await self._inner.query(messages, tools)
        self._step += 1
        self._console.print(Rule())
        self._console.print(f"[agent]agent[/] (step {self._step}):")
        self._section = None
        try:
            reply = await self._interruptible(messages, tools, on_delta)
        finally:
            if self._section is not None:
                self._console.print()  # trailing newline, even if interrupted mid-stream
        self._cost += reply.cost
        self._print_usage(reply)
        return reply

    async def _interruptible(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        on_delta: Callable[[str, str], None],
    ) -> Reply:
        """One streamed model turn, made interruptible by Ctrl-C.

        Streaming a long generation happens inside one ``await``; the default ``asyncio.run``
        SIGINT behavior tears down the whole REPL (and the OpenAI/httpx stream can swallow or
        delay the interrupt, so Ctrl-C looks dead). Instead, install a temporary SIGINT handler
        that cancels just this query task, then surface it as ``KeyboardInterrupt`` so
        :meth:`InteractiveSession.chat` aborts the current task and returns to the follow-up
        prompt — the session stays alive. The handler is removed before returning so input /
        confirm prompts keep their normal Ctrl-C.
        """
        loop = asyncio.get_running_loop()
        task = asyncio.ensure_future(self._inner.query(messages, tools, on_delta=on_delta))
        try:
            loop.add_signal_handler(signal.SIGINT, task.cancel)
        except RuntimeError:
            return await task  # no loop signal handlers (non-main thread / Windows)
        try:
            return await task
        except asyncio.CancelledError:
            raise KeyboardInterrupt from None
        finally:
            loop.remove_signal_handler(signal.SIGINT)

    def _print_usage(self, reply: Reply) -> None:
        """Print a dim one-line token/cost footer for the step just streamed.

        ``output`` is the non-reasoning slice of ``completion_tokens`` (answer text plus any
        tool-call tokens); ``reasoning`` is shown only when the server reported it.
        """
        usage = reply.usage
        if not usage:
            return
        reasoning = usage.get("reasoning_tokens", 0)
        output = max(usage.get("completion_tokens", 0) - reasoning, 0)
        bits = [f"prompt {usage.get('prompt_tokens', 0)}"]
        if reasoning:
            bits.append(f"reasoning {reasoning}")
        bits.append(f"output {output}")
        self._console.print(f"[dim]({' · '.join(bits)} · ${self._cost:.4f})[/]")


class _Gated(Tool):
    """Wraps one tool so the REPL narrates it — and, in confirm mode, asks before running it.

    A wrapper rather than a branch inside the agent loop: the loop dispatches tools by name
    through :meth:`Tool.invoke`, so gating one is just substituting the tool. A rejection is
    returned as a normal error result, which the loop feeds back to the model verbatim.

    The whole print -> prompt -> run -> print sequence is held under the session's single
    ``_gate`` lock so a turn's concurrently-dispatched calls are confirmed one at a time in
    dispatch order, instead of interleaving their prompts and output.
    """

    def __init__(self, inner: Tool, session: InteractiveSession) -> None:
        self._inner = inner
        self._session = session

    @property
    def name(self) -> str:
        return self._inner.name

    @property
    def description(self) -> str:
        return self._inner.description

    @property
    def parameters(self) -> JsonSchema:
        return self._inner.parameters

    def reset(self) -> None:
        self._inner.reset()

    def cleanup(self) -> None:
        self._inner.cleanup()

    async def invoke(self, **arguments: Any) -> tuple[str, bool]:
        session = self._session
        async with session._gate:
            session._console.print(
                f"[tool]tool[/] [bold]{self.name}[/]({json.dumps(arguments)})"
            )
            if session.mode == "confirm":
                decision = session._read(
                    "[notice]Enter[/] to run, or type a comment to reject\n> "
                ).strip()
                if decision:
                    session._console.print("[error]rejected[/]")
                    return f"Rejected by user: {decision}", True
            text, is_error = await self._inner.invoke(**arguments)
            session._console.print(text)
            if session._images and (path := image_in(text)) is not None:
                session._console.file.write(inline_image(path))
            return text, is_error


class InteractiveSession:
    """A multi-turn, human-in-the-loop driver over a model + tools.

    Holds the conversation (``messages``) and the session-wide tallies; each task is run by a
    fresh :class:`Agent` over that same list, so history carries across follow-ups while the
    per-task budgets (``max_steps`` / ``cost_limit`` / ``token_limit``) restart every task, as
    :class:`~nanoagent.runtime.config.AgentConfig` documents.

    ``reader``/``console`` are injectable so the loop can be driven in tests without a real
    terminal or model.
    """

    def __init__(
        self,
        model: StreamingChatModel,
        tools: Sequence[Tool],
        *,
        system_prompt: str,
        mode: Mode = "confirm",
        max_steps: int = 50,
        cost_limit: float | None = None,
        token_limit: int | None = None,
        confirm_exit: bool = True,
        reader: Callable[[str], str] = _input_reader,
        console: Console | None = None,
        context_window: int | None = None,
        hooks: Hooks | None = None,
        events: EventWriter | None = None,
        tree: SessionTree | None = None,
        options: ReplOptions | None = None,
    ) -> None:
        opts = options or ReplOptions()
        self._console = console or Console(
            highlight=False, theme=Theme({**DEFAULT_THEME, **opts.theme})
        )
        self._commands: dict[str, Command] = {**BUILTINS, **prompt_commands(opts.commands)}
        self._models = opts.models
        self._images = opts.images
        self._reader = reader
        self._mode: Mode = mode
        self._confirm_exit = confirm_exit
        self._max_steps = max_steps
        self._cost_limit = cost_limit
        self._token_limit = token_limit
        self._context_window = context_window
        self._hooks = hooks
        self._events = events
        self._system_prompt = system_prompt
        self._narrator = _Narrating(model, self._console)
        # Unwrapped, for human mode: a command YOU typed is not gated on your own confirmation.
        self._tools = build_tool_map(tools)
        self._gated = [_Gated(t, self) for t in tools]
        self._gate = asyncio.Lock()
        # The conversation is a TREE, not a list: `messages` is whichever branch is live, and
        # /fork copies it so a dead end can be abandoned without losing the session.
        self._tree = tree or SessionTree.start([{"role": "system", "content": system_prompt}])
        # Session-wide tallies: each task's AgentResult is folded in by _absorb, plus the
        # human-mode rows this class appends itself.
        self._call_log: list[dict[str, Any]] = []
        self._n_calls = 0
        self._cost = 0.0
        self._usage: dict[str, int] = {}
        self._step_durations: list[dict[str, float]] = []
        # How the last run_task ended — surfaced in to_result/the trajectory so a session
        # truncated by max_steps (or Ctrl-C / an error) is distinguishable from a clean answer.
        self._stop_reason: StopReason = StopReason.ANSWER
        self._error: str | None = None

    @property
    def messages(self) -> list[dict[str, Any]]:
        return self._tree.messages

    @property
    def mode(self) -> Mode:
        return self._mode

    # What a slash-command handler is allowed to reach for — see :mod:`nanoagent.cli.repl.commands`.
    @property
    def console(self) -> Console:
        return self._console

    @property
    def commands(self) -> dict[str, Command]:
        return self._commands

    @property
    def models(self) -> dict[str, ModelConfig]:
        return self._models

    @property
    def tree(self) -> SessionTree:
        return self._tree

    def set_model(self, name: str) -> None:
        """Swap to a configured model. ``_Narrating._inner`` is the only reference to the real
        one, so this is the whole switch — the transcript is untouched."""
        self._narrator._inner = Model.from_config(self._models[name])

    def to_result(self) -> AgentResult:
        """Snapshot the whole session as one :class:`AgentResult` (for trajectory saving)."""
        return AgentResult(
            answer=last_assistant_text(self._tree.messages),
            messages=self._tree.messages,
            tool_calls=self._call_log,
            steps=self._n_calls,
            stop_reason=self._stop_reason,
            usage=self._usage,
            step_durations=self._step_durations,
            cost=self._cost,
            error=self._error,
        )

    async def run_task(self, task: str) -> str:
        """Append ``task`` and drive the agent (with confirmation) until it answers."""
        self._error = None  # per-task: clear a prior turn's error so a recovered turn isn't stale
        self._tree.messages.append({"role": "user", "content": task})
        # Human mode runs BEFORE the agent gets control: you drive until you hand it over with
        # /c or /y, and every command you run spends one of the task's steps (as it did when
        # human turns were a branch inside the loop). Exiting this loop still in human mode
        # therefore means the budget ran out.
        budget = self._max_steps
        while self._mode == "human" and budget > 0:
            if not await self._human_turn():
                break
            budget -= 1
        if self._mode == "human":
            self._stop_reason = StopReason.MAX_STEPS
            self._console.print(f"[warn]max steps reached[/] [dim](max_steps={self._max_steps})[/]")
            return ""

        agent = Agent(
            self._narrator,
            self._gated,
            system_prompt=self._system_prompt,  # already in self._tree.messages; kept for parity
            max_steps=budget,
            cost_limit=self._cost_limit,
            token_limit=self._token_limit,
            context_window=self._context_window,
            # Unlike a batch rollout, a session must survive a full context: summarize and
            # continue instead of hard-stopping.
            compact=True,
            hooks=self._hooks,
            events=self._events,
        )
        # Agent.run re-raises after emitting an ERROR snapshot, and a Ctrl-C (a BaseException)
        # skips even that — so keep the latest snapshot and fold whatever ran into the session
        # tallies on every exit path, or an interrupted turn would vanish from the trajectory.
        last: AgentResult | None = None

        def snapshot(result: AgentResult) -> None:
            nonlocal last
            last = result

        try:
            result = await agent.run(
                messages=self._tree.messages, on_step=snapshot, on_delta=self._narrator.on_delta
            )
        finally:
            if last is not None:
                self._absorb(last)
        if result.stop_reason is not StopReason.ANSWER:
            self._console.print(
                f"[warn]{result.stop_reason.value.replace('_', ' ')}[/] "
                "[dim](recorded as stop_reason in the trajectory)[/]"
            )
            return ""
        return result.answer

    def _absorb(self, result: AgentResult) -> None:
        """Fold one task's (possibly partial) result into the session-wide tallies."""
        self._call_log.extend(result.tool_calls)
        self._n_calls += result.steps
        self._cost += result.cost
        _accumulate(self._usage, result.usage)
        self._step_durations.extend(result.step_durations)
        self._stop_reason = result.stop_reason
        self._error = result.error

    async def _human_turn(self) -> bool:
        """In human mode, let the user run one bash command directly. Returns True if a
        command was run (stay in the loop); False if the user switched to a model mode."""
        command = self._read(
            "[bold cyan]human[/] (shell command, or /c /y to hand to the model)\n> ",
            return_on_switch=True,
        )
        if (
            not command or self._mode != "human"
        ):  # a slash command may have switched the mode
            return self._mode == "human"
        tool = self._tools.get(_BASH_TOOL)
        if tool is None:
            self._console.print(f"[error]no '{_BASH_TOOL}' tool available[/]")
            return True
        text, is_error = await tool.invoke(command=command)
        self._console.print(text)
        self._call_log.append(
            {
                "name": _BASH_TOOL,
                "arguments": {"command": command},
                "output": text,
                "is_error": is_error,
            }
        )
        self._tree.messages.append(
            {
                "role": "user",
                "content": f"I ran this command myself:\n```\n{command}\n```\nOutput:\n{text}",
            }
        )
        return True

    def _read(self, prompt: str, *, return_on_switch: bool = False) -> str:
        """Read user input, handling ``/y`` ``/c`` ``/u`` ``/m`` ``/h`` slash commands.

        A mode switch re-prompts by default (so confirm/finish prompts keep asking); pass
        ``return_on_switch=True`` (human mode) to hand control back after a switch.
        """
        while True:
            self._console.print(
                prompt, end=""
            )  # render rich markup; read the line separately
            text = self._reader("").strip()
            if text == "/m":
                return self._read_multiline()
            name, _, argument = text.partition(" ")
            if name in self._commands:
                # A handler returning text means "this IS the task" (a prompt template);
                # returning None means it did its own thing, so ask again.
                submitted = self._commands[name](self, argument.strip())
                if submitted:
                    return submitted
                continue
            if text in _MODE_COMMANDS:
                target = _MODE_COMMANDS[text]
                if self._mode == target:
                    self._console.print(f"[error]already in {self._mode} mode[/]")
                    continue
                self._mode = target
                self._console.print(f"[notice]switched to {self._mode} mode[/]")
                if return_on_switch:
                    return ""
                continue
            return text

    def _read_multiline(self) -> str:
        """Read lines until a lone '.', a blank line, or EOF (a stdlib stand-in for prompt_toolkit multiline)."""
        self._console.print("[dim]multiline: end with a single '.' on its own line[/]")
        lines: list[str] = []
        while True:
            line = self._reader("")
            if line.strip() == "." or line == "":
                break
            lines.append(line)
        return "\n".join(lines)

    async def chat(self, initial_task: str | None = None) -> None:
        """Run the multi-turn REPL: task -> work -> follow-up -> ... until empty input.

        Model/connection errors and Ctrl-C are caught so a transient failure (e.g. the
        SGLang server not being up yet) doesn't kill the session — fix it and type again.
        """
        task = initial_task or self._read("[bold]What do you want to do?[/]\n> ")
        while task:
            try:
                await self.run_task(task)
            except KeyboardInterrupt:
                self._stop_reason = StopReason.INTERRUPTED
                self._console.print("\n[warn]interrupted[/]")
            except Exception as e:
                self._stop_reason = StopReason.ERROR
                self._error = f"{type(e).__name__}: {e}"
                self._console.print(
                    f"[error]error:[/] {e}\n[dim](is the model server up? check base_url)[/]"
                )
            if not self._confirm_exit:
                break
            task = self._read("\n[bold yellow]done.[/] Follow-up, or Enter to quit\n> ")
        self._console.print("[dim]bye[/]")


_USAGE = (
    "usage: nanoagent chat chat_cfg=<chat.yaml> "
    "[task='...'] [yolo=true] [output=<folder>] [resume=<file>]"
)


def run_and_save(
    cfg: RunConfig,
    resume: str | None = None,
    options: ReplOptions | None = None,
    *,
    mode: Mode,
    confirm_exit: bool,
    subdir: str,
) -> None:
    """Build a session from ``cfg``, drive it on ``cfg.task``, and always save the trajectory.

    Shared by the interactive ``chat`` command and the single-task ``run`` command: both run
    one :class:`InteractiveSession` and persist it on ANY exit (clean / Ctrl-C / error), so the
    session is always browsable. When ``cfg.output`` is unset, the trajectory defaults to a
    timestamped file under ``<DEFAULT_TRAJ_DIR>/<subdir>/``. ``confirm_exit=False`` (run) stops
    after the one task; ``True`` (chat) prompts for follow-ups until empty input.
    """
    prompt, tools = build_prompt_and_tools(cfg.agent, cfg.tools, cfg.tools_dir, cfg.allowed_tools)
    session = InteractiveSession(
        Model.from_config(cfg.model),
        tools,
        system_prompt=prompt,
        mode=mode,
        max_steps=cfg.agent.max_steps,
        cost_limit=cfg.agent.cost_limit,
        token_limit=cfg.agent.token_limit,
        confirm_exit=confirm_exit,
        context_window=cfg.agent.context_window,
        hooks=get_hooks(cfg.agent.hooks),
        events=EventWriter(cfg.agent.events) if cfg.agent.events else None,
        tree=load_session(resume) if resume else None,
        options=options,
    )
    logs = log_capture.start_capture()
    try:
        asyncio.run(session.chat(cfg.task))
    except KeyboardInterrupt:
        pass
    finally:
        out = (
            Path(cfg.output)
            if cfg.output
            else Path(DEFAULT_TRAJ_DIR)
            / subdir
            / f"{datetime.now():%Y%m%d_%H%M%S}{trajectory.TRAJECTORY_SUFFIX}"
        )
        path = trajectory.save(
            session.to_result(),
            out,
            meta={"task": cfg.task, "model": cfg.model.model},
            logs=logs,
        )
        print(f"saved trajectory to {path}")
        # Only when there ARE branches: one branch is fully described by the trajectory just
        # written, which `session.load` reads too, so a second file would say nothing new.
        if len(session.tree.nodes) > 1:
            saved = session.tree.save(str(path).removesuffix(trajectory.TRAJECTORY_SUFFIX) + SESSION_SUFFIX)
            print(f"saved {len(session.tree.nodes)} branches to {saved}")


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.WARNING)
    argv = sys.argv[1:] if argv is None else list(argv)
    if not argv:
        print(_USAGE)
        return 2
    cfg = load_config_args(InteractiveConfig, argv)
    # In chat mode `output` is the FOLDER to save into (like batch mode); the session file is
    # named by the time the chat started — <output>/<yymmdd-hhmmss>.traj.json. A null output
    # falls back to the default chat dir. Resolving it here (to a concrete file) means
    # run_and_save just writes that path.
    out_dir = Path(cfg.output) if cfg.output else Path(DEFAULT_TRAJ_DIR) / "chat"
    cfg.output = str(out_dir / f"{datetime.now():%y%m%d-%H%M%S}{trajectory.TRAJECTORY_SUFFIX}")
    run_and_save(
        cfg,
        resume=cfg.resume,
        options=ReplOptions(
            commands=list(cfg.commands),
            models=dict(cfg.models),
            theme=dict(cfg.theme),
            images=cfg.images,
        ),
        mode="yolo" if cfg.yolo else "confirm",
        confirm_exit=True,
        subdir="chat",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
