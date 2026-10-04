"""Interactive and print-mode sessions over a registry-selected external harness."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from nanoagent.core.agent import AgentResult, StopReason, _accumulate, last_assistant_text
from nanoagent.harness import HarnessProfile, HarnessRequest
from nanoagent.cli.repl.tree import SessionTree
from rich.console import Console
from rich.rule import Rule


@dataclass
class HarnessConversation:
    """Persistent history and totals around a harness whose process owns the agent loop."""

    profile: HarnessProfile
    instructions: str
    workspace: Path
    tree: SessionTree
    console: Console
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    steps: int = 0
    usage: dict[str, int] = field(default_factory=dict)
    cost: float = 0.0
    stop_reason: StopReason = StopReason.ANSWER
    error: str | None = None

    @classmethod
    def start(
        cls,
        profile: HarnessProfile,
        *,
        instructions: str,
        workspace: Path,
        tree: SessionTree | None = None,
        console: Console | None = None,
    ) -> HarnessConversation:
        return cls(
            profile=profile,
            instructions=instructions,
            workspace=workspace,
            tree=tree
            or SessionTree.start([{"role": "system", "content": instructions}]),
            console=console or Console(highlight=False),
        )

    async def run_task(self, task: str) -> str:
        self.error = None
        history = [
            dict(message)
            for message in self.tree.messages
            if message.get("role") in {"user", "assistant"}
        ]
        if history and not self.profile.runner.capabilities.history:
            raise RuntimeError(
                f"{self.profile.harness} harness does not support conversation history"
            )
        self.tree.messages.append({"role": "user", "content": task})
        streamed_content = False

        def progress(event: dict[str, Any]) -> None:
            nonlocal streamed_content
            event_type = event.get("type")
            if event_type == "delta":
                kind = event.get("kind")
                text = str(event.get("text", ""))
                if kind == "reasoning":
                    self.console.print(text, end="", style="dim", markup=False)
                else:
                    streamed_content = True
                    self.console.print(text, end="", markup=False)
            elif event_type == "tool":
                self.tool_calls.append(dict(event))
                self.console.print(
                    f"\n[tool]tool[/] [bold]{event.get('name', 'unknown')}[/]"
                    f"({event.get('arguments', {})})"
                )

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
        if streamed_content:
            self.console.print()
        elif result.answer:
            self.console.print(result.answer, markup=False)
        self.tree.messages.append({"role": "assistant", "content": result.answer})
        self.steps += result.steps
        _accumulate(self.usage, result.usage)
        self.cost += result.cost
        self.error = result.error
        self.stop_reason = StopReason.ERROR if result.error else StopReason.ANSWER
        return result.answer

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


async def run_conversation(
    conversation: HarnessConversation,
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


__all__ = ["HarnessConversation", "run_conversation"]
