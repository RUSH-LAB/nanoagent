"""The chats a Terminal session held: each conversation of an agent CLI, read from the CLI's own state in the workspace's .rush/.

A chat is one conversation of one CLI, named by the CLI's own conversation id: Claude Code's session (``.rush/claude/.claude/projects/
<dir>/<id>.jsonl``), Codex's thread (``.rush/codex/sessions/…/rollout-*.jsonl``), PI's session (``.rush/pi/sessions/<dir>/*.jsonl``) and
Hermes Agent's session (``.rush/hermes/state.db``). Each is titled by the CLI's own title for it, else by the first prompt the member
typed (past what the CLI injects into the conversation: notes, commands' output, instructions, context), and spans its first to its last message, by
the CLI's own timestamps. A session holds the chats it talked in: read as its shell starts (after a resumed session's files are back) and
as it ends, those that are new or grew. dsh keeps its runs as compressed event logs and NanoAgent's chats are the Dashboard's own; RUSH
takes theirs from the recording.
"""

from __future__ import annotations

import json
import re
import shlex
import sqlite3
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path

from nanoagent.uploaded.sandbox import WORKSPACE

TITLE_CHARS = 120
# What a CLI writes into a user message besides what the member typed: Claude Code's notes, slash commands and their output, Codex's
# AGENTS.md instructions and context, PI's and Codex's skills
INJECTED = re.compile(
    r"(?:# AGENTS\.md instructions for [^\n]*\s*)?<(system-reminder|command-name|command-message|command-args|local-command-stdout|"
    r"local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|task-notification|"
    r"environment_context|user_instructions|INSTRUCTIONS|user_shell_command|turn_aborted|subagent_notification|skill)\b[^>]*>.*?</\1>",
    re.S,
)
NOTES = ("Caveat: The messages below were generated", "[Request interrupted by user")  # Claude Code's, as plain text


@dataclass(frozen=True)
class Chat:
    agent: str  # the CLI's command: claude, codex, pi, hermes
    id: str  # the CLI's own conversation id
    title: str  # its first user prompt, truncated
    started_at: datetime
    ended_at: datetime
    messages: int  # how many it holds, so a session tells the chats it talked in from those it only restored
    cwd: str | None  # the folder it ran in, where its CLI finds it again
    root: str = WORKSPACE  # the workspace its CLI's home is in: the session's, or a chat's folder in it (CHATS)

    def resume(self) -> str:
        """The command that reopens this conversation, in the folder it ran in, under its ``root``, with its CLI's home there."""
        cwd = in_root(self.cwd or WORKSPACE, self.root)
        command = {
            "claude": f"claude --resume {shlex.quote(self.id)}",
            "codex": f"codex resume {shlex.quote(self.id)}",
            "pi": f"pi --session {shlex.quote(self.id)}",
            "hermes": f"hermes --resume {shlex.quote(self.id)}",
        }[self.agent]
        if self.root != WORKSPACE:
            command = f"RUSH_WORKSPACE={shlex.quote(self.root)} {command}"
        return command if cwd == WORKSPACE else f"cd {shlex.quote(cwd)} && {command}"


def in_root(path: str, root: str) -> str:
    """The folder ``path`` of the session's workspace is at once its files are restored to ``root`` (a folder outside it stays)."""
    return root + path.removeprefix(WORKSPACE) if path == WORKSPACE or path.startswith(f"{WORKSPACE}/") else path


def _title(text: str) -> str:
    line = " ".join(text.split())
    return line if len(line) <= TITLE_CHARS else line[: TITLE_CHARS - 1] + "…"


def _typed(text: str) -> str:
    """What the member typed of a user message's text: '' when it is all the CLI's own."""
    typed = INJECTED.sub("", text).strip()
    return "" if typed.startswith(NOTES) else typed


def _titled(own: str | None, prompts: list[str]) -> str | None:
    """A chat's title: the CLI's own title for it, else the first prompt the member typed; None when it has neither."""
    typed = [text for text in map(_typed, prompts) if text]
    title = own.strip() if own and own.strip() else typed[0] if typed else None
    return _title(title) if title else None


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


def prompt_of(dialect: str, body: dict) -> str | None:
    """The title of a model request's last user message (``body`` in ``dialect``: Anthropic Messages, Chat Completions or Responses),
    or None when it has no user text: the first request of a run of an agent titles that run's chat."""
    said = body.get("input") if dialect == "responses" else body.get("messages")
    if isinstance(said, str):
        return _title(said) or None
    users = [item for item in said if isinstance(item, dict) and item.get("role") == "user"] if isinstance(said, list) else []
    return _title(_text(users[-1].get("content"))) or None if users else None


def _claude(home: Path) -> list[Chat]:
    """Claude Code's sessions: one JSON-lines file each under projects/<dir>/ (a session's subagents live in a folder beside it). The
    title is the member's (``custom-title``), else Claude Code's (``ai-title``, or a ``summary`` line), else the first prompt the member
    typed, not a note Claude Code adds (``isMeta``)."""
    keys = {"custom-title": "customTitle", "ai-title": "aiTitle", "summary": "summary"}
    chats = []
    for path in sorted((home / ".claude" / "projects").glob("*/*.jsonl")):
        lines = _lines(path)
        own = {line["type"]: line.get(keys[line["type"]]) for line in lines if line.get("type") in keys}  # the last of each
        said = [line for line in lines if line.get("type") in ("user", "assistant") and not line.get("isSidechain") and "timestamp" in line]
        prompts = [
            _text(line["message"].get("content")) for line in said
            if line["type"] == "user" and not line.get("isMeta") and isinstance(line.get("message"), dict)
        ]  # fmt: skip
        title = _titled(own.get("custom-title") or own.get("ai-title") or own.get("summary"), prompts)
        if title is None or not said:
            continue
        chats.append(Chat("claude", path.stem, title, _at(said[0]["timestamp"]), _at(said[-1]["timestamp"]), len(said), said[0].get("cwd")))
    return chats


def _codex(home: Path) -> list[Chat]:
    """Codex's threads: one rollout file each under sessions/<year>/<month>/<day>/, its first line the thread's id and folder, and each
    prompt the member typed an item of its own (Codex 0.167: ``event_msg`` ``item_completed``, its item a ``UserMessage``). A thread the
    member named is titled by its name: the last line for it in session_index.jsonl."""
    index = home / "session_index.jsonl"
    names = {line["id"]: line.get("thread_name") for line in (_lines(index) if index.is_file() else []) if "id" in line}
    chats = []
    for path in sorted((home / "sessions").rglob("rollout-*.jsonl")):
        lines = _lines(path)
        meta = next((line["payload"] for line in lines if line.get("type") == "session_meta"), None)
        prompts = [
            _text(item.get("content")) for line in lines if line.get("type") == "event_msg" and line["payload"].get("type") == "item_completed"
            for item in [line["payload"].get("item")] if isinstance(item, dict) and item.get("type") == "UserMessage"
        ]  # fmt: skip
        title = _titled(names.get(meta["id"]), prompts) if meta else None
        if title is None:
            continue
        timed = [line for line in lines if "timestamp" in line]
        chats.append(Chat("codex", meta["id"], title, _at(timed[0]["timestamp"]), _at(timed[-1]["timestamp"]), len(timed), meta.get("cwd")))
    return chats


def _pi(home: Path) -> list[Chat]:
    """PI's sessions: one JSON-lines file each under sessions/<dir>/, its first line (``session``) its id and folder. A session the
    member named is titled by its name, its last ``session_info`` line's."""
    chats = []
    for path in sorted((home / "sessions").glob("*/*.jsonl")):
        lines = _lines(path)
        header = next((line for line in lines if line.get("type") == "session"), None)
        said = [line for line in lines if line.get("type") == "message" and isinstance(line.get("message"), dict)]
        prompts = [_text(line["message"].get("content")) for line in said if line["message"].get("role") == "user"]
        named = [line.get("name") for line in lines if line.get("type") == "session_info"]
        title = _titled(named[-1] if named else None, prompts) if header else None
        if title is None or not said:
            continue
        chats.append(Chat("pi", header["id"], title, _at(said[0]["timestamp"]), _at(said[-1]["timestamp"]), len(said), header.get("cwd")))
    return chats


def _hermes(home: Path) -> list[Chat]:
    """Hermes Agent's sessions, in its state.db: each session's messages, by time. Hermes keeps no folder per session: it reopens one in
    the folder it is run from. A session with a title (``sessions.title``, from Hermes's schema 3) is titled by it."""
    database = home / "state.db"
    if not database.is_file():
        return []
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        rows = connection.execute("select session_id, min(timestamp), max(timestamp), count(*) from messages group by session_id").fetchall()
        prompts: dict[str, list[str]] = {}
        typed = "select session_id, content from messages where role = 'user' and content is not null order by timestamp, id"
        for session, content in connection.execute(typed):
            prompts.setdefault(session, []).append(content)
        has_titles = any(column[1] == "title" for column in connection.execute("pragma table_info(sessions)"))
        titles = dict(connection.execute("select id, title from sessions where title is not null")) if has_titles else {}
    return [
        Chat("hermes", session, title, _at(started), _at(ended), count, None) for session, started, ended, count in rows
        for title in [_titled(titles.get(session), prompts.get(session, []))] if title
    ]  # fmt: skip


READERS = {"claude": _claude, "codex": _codex, "pi": _pi, "hermes": _hermes}
CHATS = ".rush/chats"  # in a workspace: each chat a reopen restored into a live session, a workspace of its own (resume.reopen_in)


def read(workspace: Path, root: str = WORKSPACE) -> dict[tuple[str, str], Chat]:
    """Every conversation the agent CLIs keep in ``workspace``'s .rush/ (``root`` in the VM) and in each chat's folder in it (CHATS),
    by agent and id: one kept in both is the one talked in last."""
    found = {(chat.agent, chat.id): replace(chat, root=root) for agent, reader in READERS.items() for chat in reader(workspace / ".rush" / agent)}
    for folder in sorted((workspace / CHATS).iterdir()) if (workspace / CHATS).is_dir() else []:
        for key, chat in read(folder, f"{root}/{CHATS}/{folder.name}").items():
            if key not in found or chat.ended_at > found[key].ended_at:
                found[key] = chat
    return found


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
