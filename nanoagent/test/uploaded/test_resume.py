"""Terminal sessions kept on the member's computer and put back to resume (nanoagent.uploaded.resume)."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from nanoagent.uploaded.resume import keep, restore, resume_command
from nanoagent.uploaded.rush_worker import ResumeOf

AT = "2026-11-18T22:31:00Z"
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
    assert keep(tmp_path / "scratch", "s1", made, START, 1 << 20)
    back = tmp_path / "back"
    said = restore(tmp_path / "scratch", ResumeOf("s1", AT), back)
    assert (back / "deep/a.txt").read_bytes() == b"a" and os.readlink(back / "link") == "deep/a.txt" and not (back / "pipe").exists()
    assert (back / "run.sh").stat().st_mode & 0o777 == 0o755
    assert said == {"line": f"Resumed your session from {said['line'].split('from ')[1]}"} and "run" not in said  # no agent ran in it
    assert json.loads((back / ".rush/resume.json").read_text()) == said


def test_sessions_are_bounded_in_all_and_each_one_not_kept_says_why(tmp_path: Path) -> None:
    scratch = tmp_path / "scratch"
    assert not keep(scratch, "huge", workspace(tmp_path / "huge", {"big": b"x" * 200}), START, 100)
    assert keep(scratch, "old", workspace(tmp_path / "old", {"f": b"x" * 60}), START, 100)
    assert keep(scratch, "new", workspace(tmp_path / "new", {"f": b"x" * 60}), START + timedelta(hours=1), 100)  # the old one goes
    lines = {name: restore(scratch, ResumeOf(name, AT), tmp_path / f"back-{name}")["line"] for name in ("huge", "old", "new", "never")}
    assert "larger than the 0.0 GB this computer keeps" in lines["huge"] and "This is a fresh terminal" in lines["huge"]
    assert "removed to keep this computer's Terminal sessions within 0.0 GB" in lines["old"]
    assert lines["new"].startswith("Resumed your session from") and (tmp_path / "back-new/f").is_file()
    assert "it is not on this computer (it ran on another, or its files were deleted)" in lines["never"]
    assert not (tmp_path / "back-old/f").exists()


def test_one_agent_runs_its_resume_and_several_print_theirs(tmp_path: Path) -> None:
    rollout = {"type": "session_meta", "payload": {"id": "c-9", "cwd": "/rush/workspace/app"}}
    files = {".rush/clis/codex": b"k", ".rush/codex/sessions/2026/11/18/rollout-1.jsonl": json.dumps(rollout).encode() + b"\n"}
    assert keep(tmp_path / "scratch", "one", workspace(tmp_path / "one", files), START, 1 << 20)
    said = restore(tmp_path / "scratch", ResumeOf("one", AT), tmp_path / "back-one")
    assert said["line"].endswith(" · Codex") and said["run"] == "cd /rush/workspace/app && codex resume c-9"
    several = workspace(tmp_path / "several", {".rush/clis/pi": b"k", ".rush/clis/dsh": b"k", ".rush/pi/sessions/--rush-workspace--/1.jsonl": b"{}\n"})
    assert keep(tmp_path / "scratch", "several", several, START, 1 << 20)
    said = restore(tmp_path / "scratch", ResumeOf("several", AT), tmp_path / "back-several")
    assert said["line"].endswith(" · DeepSeek Harness · PI") and "run" not in said
    assert said["type"] == "To continue: DeepSeek Harness has nothing to continue · pi --continue"


def test_an_agent_that_kept_no_conversation_has_nothing_to_run(tmp_path: Path) -> None:
    assert resume_command(workspace(tmp_path, {".rush/claude/.claude.json": b"{}"}), "claude") is None
    assert resume_command(tmp_path, "hermes") is None
    workspace(tmp_path, {".rush/hermes/state.db": b""})
    assert resume_command(tmp_path, "hermes") == "hermes --continue"
