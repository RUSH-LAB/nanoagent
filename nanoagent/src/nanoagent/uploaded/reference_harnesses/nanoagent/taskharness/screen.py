"""What the harness shows on its terminal as it works, as a coding CLI does: the model's words, each tool call with its
result, the decider's choices and the answer, in ANSI colour."""

from __future__ import annotations

import asyncio
import json
from typing import Any

BOLD, DIM, RED, GREEN, CYAN, MAGENTA, RESET = "\x1b[1m", "\x1b[2m", "\x1b[31m", "\x1b[32m", "\x1b[36m", "\x1b[35m", "\x1b[0m"
SHOWN_LINES = 6  # a tool result shows its first lines


def _show(text: str) -> None:
    print(text, flush=True)


def _clip(text: str) -> str:
    lines = text.splitlines() or [""]
    more = len(lines) - SHOWN_LINES
    return "\n".join(lines[:SHOWN_LINES]) + (f"\n… {more} more lines" if more > 0 else "")


def _indent(text: str, first: str, rest: str = "    ") -> str:
    return "\n".join((first if index == 0 else rest) + line for index, line in enumerate(text.splitlines() or [""]))


def started(task: dict[str, Any], model: str, prompt: str, interactive: bool) -> None:
    _show(f"{BOLD}RUSH{RESET} {DIM}· NanoAgent works {task['id']} ({task['kind']}) with {model}{RESET}")
    if interactive:
        _show(f"{DIM}Type to go on after each reply; /exit or Ctrl-D ends the session.{RESET}")
    _show(f"\n{BOLD}›{RESET} {prompt}\n")


def said(text: str) -> None:
    if text.strip():
        _show(_indent(text.strip(), f"{BOLD}⏺{RESET} ", "  ") + "\n")


def calling(name: str, arguments: dict[str, Any]) -> None:
    _show(f"{CYAN}{BOLD}⏺ {name}{RESET}{CYAN}({json.dumps(arguments, ensure_ascii=False)}){RESET}")


def answered(output: dict[str, Any]) -> None:
    _show(_indent(_clip(json.dumps(output, ensure_ascii=False, indent=2)), f"  {DIM}⎿ ", f"    {DIM}") + f"{RESET}\n")


def failed(message: str) -> None:
    _show(f"  {RED}⎿ {message}{RESET}\n")


def decided(answers: dict[str, Any]) -> None:
    for question, answer in answers.items():
        _show(f"{MAGENTA}◆ {question}{RESET} {DIM}→{RESET} {json.dumps(answer, ensure_ascii=False)}")


async def ask() -> str | None:
    """What the person at the terminal types next, or None once they end the session (/exit, or Ctrl-D or Ctrl-C at the prompt)."""
    while True:
        try:
            line = await asyncio.to_thread(input, f"{BOLD}›{RESET} ")
        except (EOFError, KeyboardInterrupt):
            return None
        if line.strip() in ("/exit", "/quit"):
            return None
        if line.strip():
            print(flush=True)
            return line


def result(result: dict[str, Any] | None) -> None:
    if result is None:
        _show(f"{DIM}Session ended with no answer submitted.{RESET}")
    elif result["status"] == "answered":
        _show(f"{GREEN}{BOLD}✓ Answer{RESET}\n{json.dumps(result['answer'], ensure_ascii=False, indent=2)}")
    else:
        _show(f"{RED}{BOLD}✗ Refused{RESET} {result['reason']}")


def crashed(error: BaseException) -> None:
    _show(f"{RED}{BOLD}✗ {type(error).__name__}{RESET}{RED}: {error}{RESET}")
