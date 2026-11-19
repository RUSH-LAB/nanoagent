"""Terminal sessions kept on the member's computer and put back to resume (nanoagent.uploaded.resume)."""

from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from nanoagent.uploaded import chats
from nanoagent.uploaded.resume import keep, reopen_in, restore, resume_command, start_cli
from nanoagent.uploaded.rush_worker import ChatOf, ResumeOf

AT = "2026-11-18T22:31:00Z"
CLAUDE_STATE = Path(__file__).parent / "fixtures" / "claude_state"
START = datetime(2026, 11, 18, tzinfo=timezone.utc)


def workspace(root: Path, files: dict[str, bytes]) -> Path:
    for name, data in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes(data)
    return root


def test_a_kept_session_comes_back_whole_with_its_links_and_modes(tmp_path: Path) -> None:
    made = workspace(tmp_path / "made", {"run.sh": b"echo hi", "deep/a.txt": b"a"})
    (made / "run.sh").chmod(0o755)
    os.symlink("deep/a.txt", made / "link")
    os.mkfifo(made / "pipe")  # a pipe is left out, never read
    assert keep(tmp_path / "scratch", "s1", made, START, 1 << 20) == (True, [])
    back = tmp_path / "back"
    said = restore(tmp_path / "scratch", ResumeOf("s1", AT), back)
    assert (back / "deep/a.txt").read_bytes() == b"a" and os.readlink(back / "link") == "deep/a.txt" and not (back / "pipe").exists()
    assert (back / "run.sh").stat().st_mode & 0o777 == 0o755
    assert said == {"line": f"Resumed your session from {said['line'].split('from ')[1]}"} and "run" not in said  # no agent ran in it
    assert json.loads((back / ".rush/resume-0.json").read_text()) == said


def test_sessions_are_bounded_in_all_and_each_one_not_kept_says_why(tmp_path: Path) -> None:
    scratch = tmp_path / "scratch"
    assert keep(scratch, "huge", workspace(tmp_path / "huge", {"big": b"x" * 200}), START, 100) == (False, [])
    assert keep(scratch, "old", workspace(tmp_path / "old", {"f": b"x" * 60}), START, 100) == (True, [])
    assert keep(scratch, "new", workspace(tmp_path / "new", {"f": b"x" * 60}), START + timedelta(hours=1), 100) == (True, ["old"])  # the old one goes
    lines = {name: restore(scratch, ResumeOf(name, AT), tmp_path / f"back-{name}")["line"] for name in ("huge", "old", "new", "never")}
    assert "larger than the 0.0 GB this computer keeps" in lines["huge"] and "This is a fresh terminal" in lines["huge"]
    assert "removed to keep this computer's Terminal sessions within 0.0 GB" in lines["old"]
    assert lines["new"].startswith("Resumed your session from") and (tmp_path / "back-new/f").is_file()
    assert "it is not on this computer (it ran on another, or its files were deleted)" in lines["never"]
    assert not (tmp_path / "back-old/f").exists()


def test_one_agent_runs_its_resume_and_several_print_theirs(tmp_path: Path) -> None:
    rollout = [
        {"timestamp": "2026-11-18T00:00:00Z", "type": "session_meta", "payload": {"id": "c-9", "cwd": "/rush/workspace/app"}},
        {"timestamp": "2026-11-18T00:00:01Z", "type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "UserMessage", "content": [{"type": "text", "text": "hi"}]}}},
    ]
    files = {".rush/clis/codex": b"k", ".rush/codex/sessions/2026/11/18/rollout-1.jsonl": b"".join(json.dumps(line).encode() + b"\n" for line in rollout)}
    assert keep(tmp_path / "scratch", "one", workspace(tmp_path / "one", files), START, 1 << 20)[0]
    said = restore(tmp_path / "scratch", ResumeOf("one", AT), tmp_path / "back-one")
    assert said["line"].endswith(" · codex") and said["run"] == "cd /rush/workspace/app && codex resume c-9"
    pi = [
        {"type": "session", "id": "p-1", "timestamp": "2026-11-18T00:00:00Z", "cwd": "/rush/workspace"},
        {"type": "message", "timestamp": "2026-11-18T00:00:01Z", "message": {"role": "user", "content": "hi"}},
    ]
    several = workspace(tmp_path / "several", {".rush/clis/pi": b"k", ".rush/clis/dsh": b"k", ".rush/pi/sessions/--rush-workspace--/1.jsonl": b"".join(json.dumps(line).encode() + b"\n" for line in pi)})
    assert keep(tmp_path / "scratch", "several", several, START, 1 << 20)[0]
    said = restore(tmp_path / "scratch", ResumeOf("several", AT), tmp_path / "back-several")
    assert said["line"].endswith(" · dsh · pi") and "run" not in said
    assert said["type"] == "To continue: dsh has nothing to continue · pi --session p-1"


def test_an_agent_that_kept_no_conversation_has_nothing_to_run(tmp_path: Path) -> None:
    assert resume_command(workspace(tmp_path, {".rush/claude/.claude.json": b"{}"}), "claude") is None
    assert resume_command(tmp_path, "hermes") is None
    assert resume_command(tmp_path, "nanoagent") is None
    workspace(tmp_path, {".rush/nanoagent/261118-181932.traj.json": b"{}"})
    assert resume_command(tmp_path, "nanoagent") == "mgen -c"  # NanoAgent's last session, chat or mgen, with the plugin's tools again


def test_a_session_started_under_an_agent_runs_its_cli_saying_nothing(tmp_path: Path) -> None:
    start_cli(tmp_path, "claude")
    assert json.loads((tmp_path / ".rush/resume-0.json").read_text()) == {"run": "claude"}


def test_a_chat_reopens_its_own_conversation_or_says_why_it_cannot(tmp_path: Path) -> None:
    made = tmp_path / "made"
    shutil.copytree(CLAUDE_STATE, made)
    assert keep(tmp_path / "scratch", "s1", made, START, 1 << 20)[0]
    second = "bbbb2222-0000-4000-8000-000000000002"
    said = restore(tmp_path / "scratch", ResumeOf("s1", AT, ChatOf("claude", second)), tmp_path / "back")
    assert said["run"] == f"cd /rush/workspace/app && claude --resume {second}"  # that one, not the newest
    assert said["line"].startswith("Reopened your claude session from ") and said["line"].endswith(": List the files in this folder")
    nope = restore(tmp_path / "scratch", ResumeOf("s1", AT, ChatOf("claude", "nope")), tmp_path / "b2")
    assert "kept no claude conversation nope, so it can't be reopened" in nope["line"] and nope["run"] == "claude"  # the agent, anew
    newest = restore(tmp_path / "scratch", ResumeOf("s1", AT, ChatOf("claude", None)), tmp_path / "b3")  # a run of it: its last conversation
    assert newest["run"] == f"cd /rush/workspace/app && claude --resume {second}"
    dsh = restore(tmp_path / "scratch", ResumeOf("s1", AT, ChatOf("dsh", None)), tmp_path / "b4")
    assert dsh == {"line": "dsh has no command to reopen a session, so it can't be reopened; started a new dsh session", "run": "dsh"}
    gone = restore(tmp_path / "scratch", ResumeOf("never", AT, ChatOf("claude", second)), tmp_path / "b5")
    assert gone["line"].startswith("That session's files are no longer on this computer (it is not on this computer") and gone["run"] == "claude"



def test_a_chat_reopened_in_a_live_session_comes_back_in_a_folder_of_its_own_and_runs_there(tmp_path: Path) -> None:
    made = tmp_path / "made"
    shutil.copytree(CLAUDE_STATE, made)
    (made / "notes.txt").write_text("old")
    assert keep(tmp_path / "scratch", "s1", made, START, 1 << 20)[0]
    live = workspace(tmp_path / "live", {"notes.txt": b"live"})
    second = "bbbb2222-0000-4000-8000-000000000002"
    said = reopen_in(tmp_path / "scratch", ResumeOf("s1", "", ChatOf("claude", second)), live, 4)
    folder = f"/rush/workspace/.rush/chats/{second}"
    assert said["run"] == f"cd {folder}/app && RUSH_WORKSPACE={folder} claude --resume {second}"
    assert (live / "notes.txt").read_text() == "live" and (live / f".rush/chats/{second}/notes.txt").read_text() == "old"
    projects = live / f".rush/chats/{second}/.rush/claude/.claude/projects"
    assert any(path.is_symlink() for path in projects.iterdir())  # Claude Code finds it from the folder it is reopened in
    assert json.loads((live / ".rush/resume-4.json").read_text()) == said
    assert chats.read(live)[("claude", second)].root == folder  # the live session holds it, from that folder
    gone = reopen_in(tmp_path / "scratch", ResumeOf("never", "", ChatOf("pi", "p-1")), live, 5)
    assert gone["run"] == "pi" and gone["line"].endswith("so it can't be reopened; started a new pi session")
