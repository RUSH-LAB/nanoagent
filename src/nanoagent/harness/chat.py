"""Persistent conversations over a registry-selected harness."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from nanoagent.core.agent import AgentResult, StopReason, _accumulate, last_assistant_text
from slimconfig import Folder, Layout

from nanoagent import __version__
from nanoagent.cli.repl.tree import SessionTree
from nanoagent.harness.base import HarnessRequest
from nanoagent.harness.registry import HarnessProfile
from nanoagent.trajectory.atif import AtifTrajectory, to_atif
from rich.console import Console
from rich.rule import Rule


@dataclass(frozen=True)
class Turn:
    answer: str
    events: list[dict[str, Any]]


@dataclass
class Conversation:
    """Persistent history and totals around a harness whose process owns the agent loop."""

    profile: HarnessProfile
    instructions: str
    workspace: Path
    tree: SessionTree
    console: Console
    render: bool = True
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    steps: int = 0
    usage: dict[str, int] = field(default_factory=dict)
    cost: float = 0.0
    stop_reason: StopReason = StopReason.ANSWER
    error: str | None = None
    session_id: str = field(default_factory=lambda: uuid4().hex)
    last_events: list[dict[str, Any]] = field(default_factory=list)
    request_history: list[dict[str, Any]] = field(default_factory=list)
    _sync: asyncio.Runner | None = field(default=None, init=False, repr=False)

    @classmethod
    def start(
        cls,
        profile: HarnessProfile,
        *,
        instructions: str,
        system_prompt: str | None = None,
        workspace: Path,
        tree: SessionTree | None = None,
        console: Console | None = None,
        render: bool = True,
    ) -> Conversation:
        selected_tree = tree or SessionTree.start(
            [
                {
                    "role": "system",
                    "content": instructions if system_prompt is None else system_prompt,
                }
            ]
        )
        return cls(
            profile=profile,
            instructions=instructions,
            workspace=workspace,
            tree=selected_tree,
            console=console or Console(highlight=False),
            render=render,
            request_history=[
                dict(message)
                for message in selected_tree.messages
                if message.get("role") in {"user", "assistant"}
                and not message.get("tool_calls")
            ],
        )

    async def run_task(self, task: str) -> str:
        self.error = None
        self.last_events = []
        history = [dict(message) for message in self.request_history]
        if history and not self.profile.runner.capabilities.history:
            raise RuntimeError(
                f"{self.profile.harness} harness does not support conversation history"
            )
        self.tree.messages.append({"role": "user", "content": task})
        streamed_content = False

        def progress(event: dict[str, Any]) -> None:
            nonlocal streamed_content
            self.last_events.append(dict(event))
            event_type = event.get("type")
            if event_type == "delta":
                kind = event.get("kind")
                text = str(event.get("text", ""))
                if kind == "reasoning":
                    if self.render:
                        self.console.print(text, end="", style="dim", markup=False)
                else:
                    streamed_content = True
                    if self.render:
                        self.console.print(text, end="", markup=False)
            elif event_type == "tool":
                self.tool_calls.append(dict(event))
                call_id = str(event.get("id", ""))
                self.tree.messages.extend(
                    [
                        {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": call_id,
                                    "type": "function",
                                    "function": {
                                        "name": str(event.get("name", "")),
                                        "arguments": event.get("arguments", {}),
                                    },
                                }
                            ],
                        },
                        {
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": str(event.get("output", "")),
                        },
                    ]
                )
                if self.render:
                    self.console.print(
                        f"\n[tool]tool[/] [bold]{event.get('name', 'unknown')}[/]"
                        f"({event.get('arguments', {})})"
                    )

        if self.render:
            self.console.print(Rule())
            self.console.print(
                f"[agent]{self.profile.harness}[/] · [dim]{self.profile.model}[/]"
            )
        result = await self.profile.runner.run(
            HarnessRequest(
                input=task,
                messages=history,
                instructions=self.instructions,
                workspace=str(self.workspace),
            ),
            progress,
        )
        if self.render:
            if streamed_content:
                self.console.print()
            elif result.answer:
                self.console.print(result.answer, markup=False)
        self.tree.messages.append({"role": "assistant", "content": result.answer})
        self.request_history.extend(
            [
                {"role": "user", "content": task},
                {"role": "assistant", "content": result.answer},
            ]
        )
        self.steps += result.steps
        _accumulate(self.usage, result.usage)
        self.cost += result.cost
        self.error = result.error
        self.stop_reason = StopReason.ERROR if result.error else StopReason.ANSWER
        return result.answer

    def __enter__(self) -> Conversation:
        self._sync = asyncio.Runner()
        return self

    def __exit__(self, *_error: object) -> None:
        assert self._sync is not None
        try:
            self._sync.run(self.profile.runner.aclose())
        finally:
            self._sync.close()
            self._sync = None

    def send(self, task: str) -> Turn:
        """Run one turn from synchronous scripts using the conversation's persistent loop."""
        if self._sync is None:
            raise RuntimeError("Conversation.send() must be used inside `with Conversation(...)`")
        answer = self._sync.run(self.run_task(task))
        return Turn(answer, list(self.last_events))

    def to_result(self) -> AgentResult:
        return AgentResult(
            answer=last_assistant_text(self.tree.messages),
            messages=self.tree.messages,
            tool_calls=self.tool_calls,
            steps=self.steps,
            stop_reason=self.stop_reason,
            usage=self.usage,
            cost=self.cost,
            error=self.error,
        )

    def trajectory(self) -> AtifTrajectory:
        """The conversation in portable ATIF form, ready for a SlimConfig layout output."""
        value = to_atif(
            self.to_result(),
            session_id=self.session_id,
            harness=self.profile.harness,
            harness_version=__version__,
            model=self.profile.model,
        )
        return AtifTrajectory.from_dict(value)


@dataclass
class ChatLayout(Layout):
    messages: AtifTrajectory
    workspace: Folder


async def run_conversation(
    conversation: Conversation,
    *,
    initial_task: str | None,
    confirm_exit: bool,
    reader: Callable[[str], str],
) -> None:
    task = initial_task or reader("What do you want to do?\n> ").strip()
    while task:
        try:
            await conversation.run_task(task)
        except KeyboardInterrupt:
            conversation.stop_reason = StopReason.INTERRUPTED
            conversation.console.print("\n[warn]interrupted[/]")
        except Exception as error:
            conversation.stop_reason = StopReason.ERROR
            conversation.error = f"{type(error).__name__}: {error}"
            conversation.console.print(f"[error]error:[/] {error}")
        if not confirm_exit:
            break
        task = reader("\ndone. Follow-up, or Enter to quit\n> ").strip()


HarnessConversation = Conversation

__all__ = [
    "ChatLayout",
    "Conversation",
    "HarnessConversation",
    "Turn",
    "run_conversation",
]
