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
        {"timestamp": "2026-11-19T00:00:01Z", "type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "UserMessage", "content": [{"type": "text", "text": "fix the test"}]}}},
        {"timestamp": "2026-11-19T00:00:02Z", "type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "AgentMessage", "content": [{"type": "Text", "text": "done"}]}}},
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


def test_a_request_is_titled_by_its_last_user_message_in_each_dialect() -> None:
    said = {"messages": [{"role": "user", "content": "first"}, {"role": "assistant", "content": "ok"}, {"role": "user", "content": [{"type": "text", "text": "fix  the\nbug"}]}]}
    assert chats.prompt_of("anthropic_messages", said) == "fix the bug"
    assert chats.prompt_of("chat_completions", {"messages": [{"role": "system", "content": "be brief"}, {"role": "user", "content": "x" * 200}]}) == "x" * 119 + "…"
    assert chats.prompt_of("responses", {"input": "hi there"}) == "hi there"
    assert chats.prompt_of("responses", {"input": [{"role": "user", "content": [{"type": "input_text", "text": "add tests"}]}]}) == "add tests"
    assert chats.prompt_of("chat_completions", {"messages": [{"role": "system", "content": "be brief"}]}) is None


def _write(path: Path, lines: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(line) + "\n" for line in lines))


def _claude_session(session: str, *extra: dict) -> list[dict]:
    """A Claude Code session as it writes one when a note is injected first: the note, a slash command, its caveat and output, the prompt."""

    def user(uuid: str, content: object, at: str, **more: object) -> dict:
        return {"parentUuid": None, "isSidechain": False, "type": "user", "message": {"role": "user", "content": content}, "uuid": uuid,
                "timestamp": f"2026-11-19T00:00:{at}.000Z", "cwd": "/rush/workspace", "sessionId": session, "userType": "external", **more}  # fmt: skip

    return [
        {"type": "permission-mode", "permissionMode": "bypassPermissions", "sessionId": session},
        user("u0", "<system-reminder>\nAttribution for git commits and pull requests you create from here on (this replaces …)\n</system-reminder>", "00"),
        user("u1", "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>", "01"),
        user("u2", "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>", "01", isMeta=True),
        user("u3", "<local-command-stdout>Set model to opus</local-command-stdout>", "02"),
        user("u4", [{"type": "text", "text": "<system-reminder>\nThe user opened app.py\n</system-reminder>"}, {"type": "text", "text": "Fix the login   bug\nin app.py"}], "03"),
        {"parentUuid": "u4", "isSidechain": False, "type": "assistant", "message": {"role": "assistant", "type": "message", "content": [{"type": "text", "text": "Fixed."}]},
         "uuid": "a1", "timestamp": "2026-11-19T00:00:09.000Z", "cwd": "/rush/workspace", "sessionId": session},
        user("u5", [{"type": "text", "text": "[Request interrupted by user]"}], "10"),
        *extra,
    ]  # fmt: skip


def test_a_claude_chat_is_titled_by_claude_codes_title_else_the_prompt_typed_never_injected_text(tmp_path: Path) -> None:
    projects = tmp_path / ".rush/claude/.claude/projects/-rush-workspace"
    _write(projects / "c1.jsonl", _claude_session("c1", {"type": "summary", "summary": "Login bug fix", "leafUuid": "a1"}))
    _write(projects / "c2.jsonl", _claude_session("c2"))
    _write(projects / "c3.jsonl", _claude_session("c3", {"type": "ai-title", "aiTitle": "Fixing app.py login", "sessionId": "c3"},
                                                  {"type": "custom-title", "customTitle": "login", "sessionId": "c3"}))  # fmt: skip
    _write(projects / "c4.jsonl", _claude_session("c4")[:5])  # only what Claude Code wrote: not a chat
    found = chats.read(tmp_path)
    assert {chat.id: chat.title for chat in found.values()} == {"c1": "Login bug fix", "c2": "Fix the login bug in app.py", "c3": "login"}
    assert found[("claude", "c2")].started_at == datetime(2026, 11, 19, tzinfo=timezone.utc)  # the chat still spans every line


def test_codex_pi_and_hermes_chats_are_titled_by_their_own_names_else_the_prompt_typed(tmp_path: Path) -> None:
    def rollout(thread: str, typed: str) -> list[dict]:
        return [
            {"timestamp": "2026-11-19T00:00:00Z", "type": "session_meta", "payload": {"id": thread, "cwd": "/rush/workspace"}},
            {"timestamp": "2026-11-19T00:00:00Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": "# AGENTS.md instructions for /rush/workspace\n\n<INSTRUCTIONS>\nUse uv.\n</INSTRUCTIONS>"},
                {"type": "input_text", "text": "<environment_context>\n  <cwd>/rush/workspace</cwd>\n</environment_context>"}]}},
            {"timestamp": "2026-11-19T00:00:01Z", "type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "UserMessage", "content": [
                {"type": "text", "text": "# AGENTS.md instructions for /rush/workspace\n\n<INSTRUCTIONS>\nUse uv.\n</INSTRUCTIONS>"},
                {"type": "text", "text": "<environment_context>\n  <shell>bash</shell>\n</environment_context>"}]}}},
            {"timestamp": "2026-11-19T00:00:02Z", "type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "UserMessage", "content": [
                {"type": "text", "text": typed}]}}},
        ]  # fmt: skip

    _write(tmp_path / ".rush/codex/sessions/2026/11/19/rollout-a.jsonl", rollout("c-named", "fix the test"))
    _write(tmp_path / ".rush/codex/sessions/2026/11/19/rollout-b.jsonl", rollout("c-plain", "<skill>\n<name>tdd</name>\n</skill>\nadd a test"))
    _write(tmp_path / ".rush/codex/session_index.jsonl", [
        {"id": "c-named", "thread_name": "first name", "updated_at": "2026-11-19T00:00:03Z"},
        {"id": "c-named", "thread_name": "Test fix", "updated_at": "2026-11-19T00:00:04Z"},
    ])  # fmt: skip

    def pi(session: str, *extra: dict) -> list[dict]:
        skill = '<skill name="review" location="/root/.pi/skills/review/SKILL.md">\nReferences are relative to /root/.pi/skills/review.\n\nReview.\n</skill>'
        return [
            {"type": "session", "version": 3, "id": session, "timestamp": "2026-11-19T00:00:00Z", "cwd": "/rush/workspace"},
            {"type": "message", "id": "m1", "parentId": None, "timestamp": "2026-11-19T00:00:02Z",
             "message": {"role": "user", "content": [{"type": "text", "text": f"{skill}\n\nreview main.py"}]}},
            *extra,
        ]  # fmt: skip

    _write(tmp_path / ".rush/pi/sessions/--rush-workspace--/1_p-plain.jsonl", pi("p-plain"))
    _write(tmp_path / ".rush/pi/sessions/--rush-workspace--/2_p-named.jsonl",
           pi("p-named", {"type": "session_info", "id": "i1", "parentId": "m1", "timestamp": "2026-11-19T00:00:03Z", "name": "Main review"}))  # fmt: skip
    (tmp_path / ".rush/hermes").mkdir(parents=True)
    with sqlite3.connect(tmp_path / ".rush/hermes/state.db") as db:
        db.execute("create table sessions (id text primary key, source text not null, started_at real not null, title text)")
        db.execute("create table messages (id integer primary key autoincrement, session_id text, role text, content text, timestamp real)")
        db.executemany("insert into sessions (id, source, started_at, title) values (?, 'cli', 1.0, ?)", [("h-named", "Docker build"), ("h-plain", None)])  # fmt: skip
        db.executemany("insert into messages (session_id, role, content, timestamp) values (?, ?, ?, ?)", [
            ("h-named", "user", "fix the docker build", 2.0), ("h-plain", "user", "", 2.0), ("h-plain", "user", "what changed?", 3.0),
        ])  # fmt: skip
    assert {key: chat.title for key, chat in chats.read(tmp_path).items()} == {
        ("codex", "c-named"): "Test fix", ("codex", "c-plain"): "add a test",
        ("pi", "p-named"): "Main review", ("pi", "p-plain"): "review main.py",
        ("hermes", "h-named"): "Docker build", ("hermes", "h-plain"): "what changed?",
    }  # fmt: skip
