"""Terminal sessions kept on the member's computer, so the Dashboard can resume one where it left off.

When a free-form Terminal session ends, the worker copies its workspace under its scratch (``sessions/<attempt id>/workspace``),
before the case's folder goes. The workspace holds everything a session made: the member's files, and in ``.rush/`` the agent CLIs'
own state (each wrapper in the shell reference harness's bin/ keeps its CLI's home there: ``.rush/claude``, ``.rush/codex``,
``.rush/pi``, ``.rush/hermes``, ``.rush/dsh``) and which CLIs it ran (``.rush/clis``). Nothing of it leaves this computer: RUSH only
learns whether it was kept (finalize's ``resumable``). The copies are bounded in all by ``resume_bytes``; the oldest go first, and
each copy that is not kept leaves a note why (``session.json``), so a resume can say so.

A session that resumes one gets the copy back in its workspace before its shell starts, with ``.rush/resume.json``: the line its first
terminal prints after the banner, and the agent's resume command to run there (one agent) or the commands to type (several), which
shell.py and bashrc act on. A new session started under an agent (the Dashboard's New session with its chip chosen) gets the same
file with that agent's CLI command to run, and no line (start_cli).
"""

from __future__ import annotations

import json
import os
import shutil
import stat
from datetime import datetime
from pathlib import Path

from nanoagent.uploaded.clis import CLIS
from nanoagent.uploaded import chats
from nanoagent.uploaded.rush_worker import ChatOf, ResumeOf

SESSIONS = "sessions"  # under the scratch folder: each kept Terminal session, by attempt id
NOTE = "session.json"  # beside a kept session's workspace/: when it ended, and why it is not kept when it is not
KEPT_WORKSPACE = "workspace"
RESUME_FILE = ".rush/resume.json"  # in a resuming or starting session's workspace, read (and removed) by shell.py as its shell starts
CLIS_RAN = ".rush/clis"  # in the workspace: each CLI the session ran, by name (shell rush.py)


class TooLarge(Exception):
    pass


def gib(size: int) -> str:
    return f"{size / (1 << 30):.1f} GB"


def copy_workspace(source: Path, destination: Path, max_bytes: int | None = None) -> int:
    """Copies the folder ``source`` to ``destination``: its folders, regular files (with their modes) and links as links, never
    followed; sockets and pipes are left out. Raises [TooLarge] once its files pass ``max_bytes``. Returns their bytes."""
    total = 0
    destination.mkdir(parents=True, exist_ok=True)
    for root, folders, files in os.walk(source):
        here = Path(root)
        there = destination / here.relative_to(source)
        for name in [*folders, *files]:
            path, target = here / name, there / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                os.symlink(os.readlink(path), target)
            elif stat.S_ISDIR(mode):
                target.mkdir(exist_ok=True)
            elif stat.S_ISREG(mode):
                total += path.lstat().st_size
                if max_bytes is not None and total > max_bytes:
                    raise TooLarge
                shutil.copy2(path, target, follow_symlinks=False)
    return total


def _note(folder: Path) -> dict:
    return json.loads((folder / NOTE).read_text(encoding="utf-8"))


def keep(scratch: Path, attempt_id: str, workspace: Path, ended_at: datetime, max_bytes: int) -> tuple[bool, list[str]]:
    """Keeps the ended session ``attempt_id``'s ``workspace`` under ``scratch``, then the newest kept sessions that fit in
    ``max_bytes`` in all, the older ones each left with a note of why they went. Whether this one was kept, and the attempt ids of
    the older ones that went (RUSH learns both, so the Dashboard says their chats' files are gone)."""
    folder = scratch / SESSIONS / attempt_id
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    note = {"ended_at": ended_at.isoformat()}
    copying = folder / f"{KEPT_WORKSPACE}.copying"  # named workspace/ once its note is written
    try:
        note["bytes"] = copy_workspace(workspace, copying, max_bytes)
    except TooLarge:
        shutil.rmtree(copying)
        note["gone"] = f"it was larger than the {gib(max_bytes)} this computer keeps of Terminal sessions"
    (folder / NOTE).write_text(json.dumps(note), encoding="utf-8")
    if copying.is_dir():
        copying.rename(folder / KEPT_WORKSPACE)
    kept = sorted(
        (entry for entry in (scratch / SESSIONS).iterdir() if (entry / KEPT_WORKSPACE).is_dir()),
        key=lambda entry: _note(entry)["ended_at"], reverse=True,
    )
    total = 0
    evicted = []
    for entry in kept:
        total += _note(entry)["bytes"]
        if total > max_bytes:
            evicted.append(entry.name)
            shutil.rmtree(entry / KEPT_WORKSPACE)
            older = _note(entry) | {"gone": f"it was removed to keep this computer's Terminal sessions within {gib(max_bytes)}"}
            (entry / NOTE).write_text(json.dumps(older), encoding="utf-8")
    return (folder / KEPT_WORKSPACE).is_dir(), evicted


def when(at: str) -> str:
    """"Nov 18, 4:31 PM": the time ``at`` (ISO 8601) on this computer's clock, with its year when it is not this one."""
    local = datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone()
    year = f", {local.year}" if local.year != datetime.now().year else ""
    return f"{local:%b} {local.day}{year}, {local.hour % 12 or 12}:{local:%M} {'AM' if local.hour < 12 else 'PM'}"


def resume_command(workspace: Path, name: str) -> str | None:
    """The command that continues agent ``name``'s last conversation in the restored ``workspace`` (from its own state), or None when
    it kept none or has no way to continue one."""
    if name in chats.READERS:
        kept = [chat for chat in chats.read(workspace).values() if chat.agent == name]
        return max(kept, key=lambda chat: chat.ended_at).resume() if kept else None
    if name == "nanoagent":
        return "mgen -c" if any((workspace / ".rush" / "nanoagent").rglob("*.traj.json")) else None
    return None  # dsh runs one task at a time, headless: it has nothing to continue


def _reopen(workspace: Path, chat: ChatOf, since: str) -> dict:
    """What a session resumed for one of its chats says and runs: that chat's own resume command, or why it cannot be reopened. A chat
    with no id is a run of its agent (one recorded before its conversations were read): its agent's last conversation."""
    if chat.agent not in chats.READERS:
        return {"line": f"Your session from {since} is back, files and all, but {chat.agent} has no command to reopen one of its chats."}
    kept = [found for found in chats.read(workspace).values() if found.agent == chat.agent and chat.id in (None, found.id)]
    found = max(kept, key=lambda one: one.ended_at) if kept else None
    if found is None:
        return {"line": f"Your session from {since} is back, files and all, but {chat.agent} kept no conversation {chat.id or ''} in it to reopen."}
    return {"line": f"Reopened your {chat.agent} chat from {since}: {found.title}", "run": found.resume()}


def restore(scratch: Path, of: ResumeOf, workspace: Path) -> dict:
    """Puts the kept session ``of`` back in ``workspace`` and returns what its first terminal says and runs (RESUME_FILE, which it is
    also written to): ``line``, and ``run``, the one agent's resume command, or ``type``, the commands of several; resumed for one of
    its chats (``of.chat``), that chat's resume command. A session that is not kept says why, and the terminal is a fresh one."""
    folder = scratch / SESSIONS / of.attempt_id
    since = when(of.at)
    said: dict
    if not (folder / KEPT_WORKSPACE).is_dir():
        why = _note(folder)["gone"] if (folder / NOTE).is_file() else "it is not on this computer (it ran on another, or its files were deleted)"
        gone = "This chat's files are no longer on this computer" if of.chat else f"Couldn't resume your session from {since}"
        said = {"line": f"{gone}: {why}. This is a fresh terminal."}
    elif of.chat is not None:
        copy_workspace(folder / KEPT_WORKSPACE, workspace)
        said = _reopen(workspace, of.chat, since)
    else:
        copy_workspace(folder / KEPT_WORKSPACE, workspace)
        ran = sorted(entry.name for entry in (workspace / CLIS_RAN).iterdir() if entry.name in CLIS) if (workspace / CLIS_RAN).is_dir() else []
        said = {"line": f"Resumed your session from {since}" + "".join(f" · {name}" for name in ran)}
        commands = {name: resume_command(workspace, name) for name in ran}
        if len(ran) == 1 and commands[ran[0]]:
            said["run"] = commands[ran[0]]
        elif len(ran) == 1:
            said["type"] = f"{ran[0]} kept no conversation it can continue."
        elif ran:
            said["type"] = "To continue: " + " · ".join(commands[name] or f"{name} has nothing to continue" for name in ran)
    (workspace / RESUME_FILE).parent.mkdir(parents=True, exist_ok=True)
    (workspace / RESUME_FILE).write_text(json.dumps(said), encoding="utf-8")
    return said


def start_cli(workspace: Path, command: str) -> None:
    """Has a new session's first terminal run the agent CLI ``command`` (``claude``) at its first prompt (RESUME_FILE's ``run``), so
    the member lands in it and is back at the shell when it exits."""
    (workspace / RESUME_FILE).parent.mkdir(parents=True, exist_ok=True)
    (workspace / RESUME_FILE).write_text(json.dumps({"run": command}), encoding="utf-8")
