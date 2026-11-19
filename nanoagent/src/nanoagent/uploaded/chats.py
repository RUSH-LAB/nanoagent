"""The chats a Terminal session held: each conversation of an agent CLI, read from the CLI's own state in the workspace's .rush/.

A chat is one conversation of one CLI, named by the CLI's own conversation id: Claude Code's session (``.rush/claude/.claude/projects/
<dir>/<id>.jsonl``), Codex's thread (``.rush/codex/sessions/…/rollout-*.jsonl``), PI's session (``.rush/pi/sessions/<dir>/*.jsonl``) and
Hermes Agent's session (``.rush/hermes/state.db``). Each is titled by its first user prompt and spans its first to its last message, by
the CLI's own timestamps. A session holds the chats it talked in: read as its shell starts (after a resumed session's files are back) and
as it ends, those that are new or grew. dsh keeps its runs as compressed event logs and NanoAgent's chats are the Dashboard's own; RUSH
takes theirs from the recording.
"""

from __future__ import annotations

import json
import shlex
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from nanoagent.uploaded.sandbox import WORKSPACE

TITLE_CHARS = 120


@dataclass(frozen=True)
class Chat:
    agent: str  # the CLI's command: claude, codex, pi, hermes
    id: str  # the CLI's own conversation id
    title: str  # its first user prompt, truncated
    started_at: datetime
    ended_at: datetime
    messages: int  # how many it holds, so a session tells the chats it talked in from those it only restored
    cwd: str | None  # the folder it ran in, where its CLI finds it again

    def resume(self) -> str:
        """The command that reopens this conversation, in the folder it ran in."""
        command = {
            "claude": f"claude --resume {shlex.quote(self.id)}",
            "codex": f"codex resume {shlex.quote(self.id)}",
            "pi": f"pi --session {shlex.quote(self.id)}",
            "hermes": f"hermes --resume {shlex.quote(self.id)}",
        }[self.agent]
        return command if self.cwd in (None, WORKSPACE) else f"cd {shlex.quote(self.cwd)} && {command}"


def _title(text: str) -> str:
    line = " ".join(text.split())
    return line if len(line) <= TITLE_CHARS else line[: TITLE_CHARS - 1] + "…"


def _at(value: str | float) -> datetime:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _lines(path: Path) -> list[dict]:
    found = []
    with path.open(encoding="utf-8", errors="replace") as lines:
        for raw in lines:
            try:
                line = json.loads(raw)
            except ValueError:
                continue  # a line its CLI was writing as the session ended
            if isinstance(line, dict):
                found.append(line)
    return found


def _text(content: object) -> str:
    """The text of a message's content: a string, or its text blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(block["text"] for block in content if isinstance(block, dict) and block.get("type") in ("text", "input_text") and isinstance(block.get("text"), str))
    return ""


def _claude(home: Path) -> list[Chat]:
    """Claude Code's sessions: one JSON-lines file each under projects/<dir>/ (a session's subagents live in a folder beside it). The
    title is its first prompt the member typed, not a command's output or a note Claude Code adds (``isMeta``)."""
    chats = []
    for path in sorted((home / ".claude" / "projects").glob("*/*.jsonl")):
        said = [line for line in _lines(path) if line.get("type") in ("user", "assistant") and not line.get("isSidechain") and "timestamp" in line]
        prompts = [
            _text(line["message"].get("content")) for line in said
            if line["type"] == "user" and not line.get("isMeta") and isinstance(line.get("message"), dict)
        ]  # fmt: skip
        typed = [text for text in prompts if text.strip() and not text.lstrip().startswith(("<command-", "<local-command", "<bash-", "Caveat:"))]
        if not typed:
            continue
        chats.append(Chat("claude", path.stem, _title(typed[0]), _at(said[0]["timestamp"]), _at(said[-1]["timestamp"]), len(said), said[0].get("cwd")))
    return chats


def _codex(home: Path) -> list[Chat]:
    """Codex's threads: one rollout file each under sessions/<year>/<month>/<day>/, its first line the thread's id and folder, and each
    prompt the member typed an event of its own (``user_message``)."""
    chats = []
    for path in sorted((home / "sessions").rglob("rollout-*.jsonl")):
        lines = _lines(path)
        meta = next((line["payload"] for line in lines if line.get("type") == "session_meta"), None)
        prompts = [line for line in lines if line.get("type") == "event_msg" and line["payload"].get("type") == "user_message"]
        if meta is None or not prompts:
            continue
        timed = [line for line in lines if "timestamp" in line]
        chats.append(Chat("codex", meta["id"], _title(prompts[0]["payload"]["message"]), _at(timed[0]["timestamp"]), _at(timed[-1]["timestamp"]), len(timed), meta.get("cwd")))
    return chats


def _pi(home: Path) -> list[Chat]:
    """PI's sessions: one JSON-lines file each under sessions/<dir>/, its first line (``session``) its id and folder."""
    chats = []
    for path in sorted((home / "sessions").glob("*/*.jsonl")):
        lines = _lines(path)
        header = next((line for line in lines if line.get("type") == "session"), None)
        said = [line for line in lines if line.get("type") == "message" and isinstance(line.get("message"), dict)]
        prompts = [_text(line["message"].get("content")) for line in said if line["message"].get("role") == "user"]
        typed = [text for text in prompts if text.strip()]
        if header is None or not typed:
            continue
        chats.append(Chat("pi", header["id"], _title(typed[0]), _at(said[0]["timestamp"]), _at(said[-1]["timestamp"]), len(said), header.get("cwd")))
    return chats


def _hermes(home: Path) -> list[Chat]:
    """Hermes Agent's sessions, in its state.db: each session's messages, by time. Hermes keeps no folder per session: it reopens one in
    the folder it is run from."""
    database = home / "state.db"
    if not database.is_file():
        return []
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        rows = connection.execute(
            """select session_id, min(timestamp), max(timestamp), count(*),
                 (select content from messages f where f.session_id = m.session_id and f.role = 'user'
                    and trim(coalesce(f.content, '')) != '' order by f.timestamp, f.id limit 1)
               from messages m group by session_id"""
        ).fetchall()
    return [Chat("hermes", session, _title(prompt), _at(started), _at(ended), count, None) for session, started, ended, count, prompt in rows if prompt]


READERS = {"claude": _claude, "codex": _codex, "pi": _pi, "hermes": _hermes}


def read(workspace: Path) -> dict[tuple[str, str], Chat]:
    """Every conversation the agent CLIs keep in ``workspace``'s .rush/, by agent and id."""
    rush = workspace / ".rush"
    return {(chat.agent, chat.id): chat for agent, reader in READERS.items() for chat in reader(rush / agent)}


def talked(before: dict[tuple[str, str], Chat], after: dict[tuple[str, str], Chat]) -> list[Chat]:
    """The chats of ``after`` that a session talked in: new since ``before``, or grown."""
    return sorted(
        (chat for key, chat in after.items() if key not in before or chat.messages != before[key].messages),
        key=lambda chat: chat.started_at,
    )


def report(chats: list[Chat], offset_ns: int) -> list[dict]:
    """``chats`` as RUSH keeps them (finalize's ``chats``): their times also on the clock of the attempt's records (``started_ns``,
    ``ended_ns``: wall time less ``offset_ns``, as the process records are), so RUSH can tell which model calls were each one's."""

    def ns(at: datetime) -> str:
        return str(int(at.timestamp() * 1e9) - offset_ns)

    return [
        {"agent": chat.agent, "id": chat.id, "title": chat.title, "started_at": chat.started_at.isoformat(), "ended_at": chat.ended_at.isoformat(),
         "started_ns": ns(chat.started_at), "ended_ns": ns(chat.ended_at)}
        for chat in chats
    ]  # fmt: skip
