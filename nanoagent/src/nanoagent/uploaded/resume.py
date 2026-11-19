"""Terminal sessions kept on the member's computer, so the Dashboard can resume one where it left off.

When a free-form Terminal session ends, the worker copies its workspace under its scratch (``sessions/<attempt id>/workspace``),
before the case's folder goes. The workspace holds everything a session made: the member's files, and in ``.rush/`` the agent CLIs'
own state (each wrapper in the shell reference harness's bin/ keeps its CLI's home there: ``.rush/claude``, ``.rush/codex``,
``.rush/pi``, ``.rush/hermes``, ``.rush/dsh``) and which CLIs it ran (``.rush/clis``). Nothing of it leaves this computer: RUSH only
learns whether it was kept (finalize's ``resumable``). The copies are bounded in all by ``resume_bytes``; the oldest go first, and
each copy that is not kept leaves a note why (``session.json``), so a resume can say so.

A session that resumes one gets the copy back in its workspace before its shell starts, with ``.rush/resume-0.json``: the line its
first terminal prints after the banner, and the agent's resume command to run there (one agent) or the commands to type (several), which
shell.py and bashrc act on. A new session started under an agent (the Dashboard's New session with its chip chosen) gets the same
file with that agent's CLI command to run, and no line (start_cli). A chat clicked on the Dashboard while a session is live opens in a
new terminal of it (``.rush/resume-<terminal>.json``): its kept files in a folder of their own there (reopen_in), or, when it cannot be
reopened, its agent started anew with why.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
from datetime import datetime
from pathlib import Path

from nanoagent.uploaded.clis import CLIS
from nanoagent.uploaded import chats
from nanoagent.uploaded.rush_worker import ChatOf, ResumeOf
from nanoagent.uploaded.sandbox import WORKSPACE

SESSIONS = "sessions"  # under the scratch folder: each kept Terminal session, by attempt id
NOTE = "session.json"  # beside a kept session's workspace/: when it ended, and why it is not kept when it is not
KEPT_WORKSPACE = "workspace"
RESUME_FILE = ".rush/resume-{terminal}.json"  # in the workspace: what a terminal says and runs, read (and removed) by shell.py as its shell starts
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


def fresh(agent: str, why: str) -> dict:
    """What a terminal opened for a chat that cannot be reopened says and runs: why, then its agent, started anew."""
    return {"line": f"{why}, so it can't be reopened; started a new {agent} session", "run": agent}


def _gone(folder: Path) -> str | None:
    """Why the session kept in ``folder`` is no longer on this computer, or None while it is."""
    if (folder / KEPT_WORKSPACE).is_dir():
        return None
    return _note(folder)["gone"] if (folder / NOTE).is_file() else "it is not on this computer (it ran on another, or its files were deleted)"


def _relocate(workspace: Path, root: str, chat: chats.Chat) -> None:
    """Lets ``chat``'s CLI find it from the folder it is reopened in, under its ``chat.root`` (``workspace``, ``root`` in the VM, holds
    it): Claude Code and PI keep a conversation under its folder's name, so that name links to the folder it ran in, which Claude Code
    is told it trusts."""
    ran = chat.cwd or WORKSPACE
    now = chats.in_root(ran, chat.root)
    home = workspace / chat.root.removeprefix(root).lstrip("/") / ".rush" / chat.agent
    named = {
        "claude": (home / ".claude" / "projects", lambda path: re.sub(r"[^A-Za-z0-9]", "-", path)),
        "pi": (home / "sessions", lambda path: f"--{re.sub(r'[/:]', '-', path.lstrip('/'))}--"),
    }
    if now == ran or chat.agent not in named:
        return
    store, name = named[chat.agent]
    if not (store / name(now)).exists():
        os.symlink(name(ran), store / name(now))
    if chat.agent == "claude":
        config = json.loads((home / ".claude.json").read_text(encoding="utf-8")) if (home / ".claude.json").is_file() else {}
        config.setdefault("projects", {})[now] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}
        (home / ".claude.json").write_text(json.dumps(config), encoding="utf-8")


def _reopen(workspace: Path, chat: ChatOf, since: str, root: str = WORKSPACE) -> dict:
    """What a terminal reopening one of the chats of the session put back in ``workspace`` (``root`` in the VM) says and runs: that
    chat's own resume command, or why it cannot be reopened and its agent started anew. A chat with no id is a run of its agent (one
    recorded before its conversations were read): its agent's last conversation."""
    if chat.agent not in chats.READERS:
        return fresh(chat.agent, f"{chat.agent} has no command to reopen a session")
    kept = [found for found in chats.read(workspace, root).values() if found.agent == chat.agent and chat.id in (None, found.id)]
    if not kept:
        return fresh(chat.agent, f"Your session from {since} kept no {chat.agent} conversation {chat.id or ''}".rstrip())
    found = max(kept, key=lambda one: one.ended_at)
    if root != WORKSPACE:
        _relocate(workspace, root, found)
    return {"line": f"Reopened your {chat.agent} session from {since}: {found.title}", "run": found.resume()}


def _say(workspace: Path, said: dict, terminal: int = 0) -> dict:
    """Has terminal ``terminal`` say and run ``said`` as its shell starts (RESUME_FILE)."""
    path = workspace / RESUME_FILE.format(terminal=terminal)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(said), encoding="utf-8")
    return said


def restore(scratch: Path, of: ResumeOf, workspace: Path) -> dict:
    """Puts the kept session ``of`` back in ``workspace`` and returns what its first terminal says and runs (RESUME_FILE, which it is
    also written to): ``line``, and ``run``, the one agent's resume command, or ``type``, the commands of several; resumed for one of
    its chats (``of.chat``), that chat's resume command. A session that is not kept says why, and the terminal is a fresh one, running
    the chat's agent anew when it was for one."""
    folder = scratch / SESSIONS / of.attempt_id
    since = when(of.at)
    said: dict
    gone = _gone(folder)
    if gone and of.chat:
        said = fresh(of.chat.agent, f"That session's files are no longer on this computer ({gone})")
    elif gone:
        said = {"line": f"Couldn't resume your session from {since}: {gone}. This is a fresh terminal."}
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
    return _say(workspace, said)


def reopen_in(scratch: Path, of: ResumeOf, workspace: Path, terminal: int) -> dict:
    """Has terminal ``terminal`` of a live session reopen ``of.chat``, a chat of the kept session ``of``, and returns what it says and
    runs: the kept session's files go to a folder of their own in ``workspace`` (CHATS/<its conversation id>, or the session's id for a
    run of an agent), not over the live session's, where its agent reopens it. A folder already there (the chat reopened before in this
    session) is used as it is. A chat whose files are gone starts its agent anew in the workspace, saying why."""
    folder = scratch / SESSIONS / of.attempt_id
    gone = _gone(folder)
    if gone:
        return _say(workspace, fresh(of.chat.agent, f"That session's files are no longer on this computer ({gone})"), terminal)
    name = of.chat.id or of.attempt_id
    into = workspace / chats.CHATS / name
    if not into.is_dir():
        copy_workspace(folder / KEPT_WORKSPACE, into)
    return _say(workspace, _reopen(into, of.chat, when(_note(folder)["ended_at"]), f"{WORKSPACE}/{chats.CHATS}/{name}"), terminal)


def start_cli(workspace: Path, command: str, terminal: int = 0, line: str | None = None) -> None:
    """Has terminal ``terminal`` (a new session's first) run the agent CLI ``command`` (``claude``) at its first prompt (RESUME_FILE's
    ``run``), after ``line`` when given, so the member lands in it and is back at the shell when it exits."""
    _say(workspace, {"run": command} | ({"line": line} if line else {}), terminal)
