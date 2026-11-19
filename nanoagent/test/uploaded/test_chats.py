"""The chats a Terminal session held, read from the agent CLIs' own state in its workspace (nanoagent.uploaded.chats)."""

from __future__ import annotations

import json
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from nanoagent.uploaded import chats

CLAUDE_STATE = Path(__file__).parent / "fixtures" / "claude_state"
FIRST, SECOND = "aaaa1111-0000-4000-8000-000000000001", "bbbb2222-0000-4000-8000-000000000002"


def test_two_claude_runs_are_two_chats_titled_by_their_prompts(tmp_path: Path) -> None:
    shutil.copytree(CLAUDE_STATE, tmp_path, dirs_exist_ok=True)
    found = chats.read(tmp_path)
    assert sorted(found) == [("claude", FIRST), ("claude", SECOND)]  # the subagent's file beside the first is not a chat
    first, second = found[("claude", FIRST)], found[("claude", SECOND)]
    assert (first.title, first.messages, first.cwd) == ("say ok", 2, "/rush/workspace")
    assert (first.started_at, first.ended_at) == (datetime(2026, 11, 19, 0, 25, 38, 608000, timezone.utc), datetime(2026, 11, 19, 0, 25, 41, 120000, timezone.utc))
    assert second.title == "List the files in this folder"  # past the command it ran and Claude Code's note, its lines joined
    assert first.resume() == f"claude --resume {FIRST}"  # in the workspace, where the terminal starts
    assert second.resume() == f"cd /rush/workspace/app && claude --resume {SECOND}"


def test_a_session_holds_the_chats_it_talked_in_not_those_it_restored(tmp_path: Path) -> None:
    shutil.copytree(CLAUDE_STATE, tmp_path, dirs_exist_ok=True)
    before = chats.read(tmp_path)
    path = tmp_path / ".rush/claude/.claude/projects/-rush-workspace" / f"{FIRST}.jsonl"
    line = {"type": "user", "isSidechain": False, "message": {"role": "user", "content": "again"}, "timestamp": "2026-11-19T01:00:00Z", "cwd": "/rush/workspace"}
    with path.open("a") as out:
        out.write(json.dumps(line) + "\n")
    held = chats.talked(before, chats.read(tmp_path))
    assert [(chat.id, chat.title, chat.ended_at.hour) for chat in held] == [(FIRST, "say ok", 1)]
    [sent] = chats.report(held, 1_000)
    assert sent["started_ns"] == str(int(datetime(2026, 11, 19, 0, 25, 38, 608000, timezone.utc).timestamp() * 1e9) - 1_000)
    assert sent | {"started_ns": None, "ended_ns": None} == {
        "agent": "claude", "id": FIRST, "title": "say ok", "started_at": "2026-11-19T00:25:38.608000+00:00", "ended_at": "2026-11-19T01:00:00+00:00",
        "started_ns": None, "ended_ns": None,
    }


def test_codex_pi_and_hermes_chats_reopen_by_their_own_ids(tmp_path: Path) -> None:
    rollout = tmp_path / ".rush/codex/sessions/2026/11/19/rollout-1.jsonl"
    rollout.parent.mkdir(parents=True)
    rollout.write_text("\n".join(json.dumps(line) for line in [
        {"timestamp": "2026-11-19T00:00:00Z", "type": "session_meta", "payload": {"id": "c-9", "cwd": "/rush/workspace"}},
        {"timestamp": "2026-11-19T00:00:01Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>"}]}},
        {"timestamp": "2026-11-19T00:00:01Z", "type": "event_msg", "payload": {"type": "user_message", "message": "fix the test"}},
    ]) + "\n")  # fmt: skip
    session = tmp_path / ".rush/pi/sessions/--rush-workspace--/1_p-1.jsonl"
    session.parent.mkdir(parents=True)
    session.write_text("\n".join(json.dumps(line) for line in [
        {"type": "session", "version": 3, "id": "p-1", "timestamp": "2026-11-19T00:00:00Z", "cwd": "/rush/workspace/app"},
        {"type": "message", "id": "m1", "parentId": None, "timestamp": "2026-11-19T00:00:02Z", "message": {"role": "user", "content": [{"type": "text", "text": "hello pi"}]}},
    ]) + "\n")  # fmt: skip
    (tmp_path / ".rush/hermes").mkdir(parents=True)
    with sqlite3.connect(tmp_path / ".rush/hermes/state.db") as db:
        db.execute("create table messages (id integer primary key autoincrement, session_id text, role text, content text, timestamp real)")
        db.executemany("insert into messages (session_id, role, content, timestamp) values (?, ?, ?, ?)",
                       [("h-1", "system", "you are hermes", 1.0), ("h-1", "user", "hi hermes", 2.0), ("h-1", "assistant", "hello", 3.0)])  # fmt: skip
    found = chats.read(tmp_path)
    assert [(key, chat.title, chat.resume()) for key, chat in sorted(found.items())] == [
        (("codex", "c-9"), "fix the test", "codex resume c-9"),
        (("hermes", "h-1"), "hi hermes", "hermes --resume h-1"),
        (("pi", "p-1"), "hello pi", "cd /rush/workspace/app && pi --session p-1"),
    ]
