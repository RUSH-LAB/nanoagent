"""Protected process evidence for every case sandbox, read from the `strace` the supervisor runs each command under.

Inside a case's microVM the harness, and every managed command, starts beneath the worker's static `strace`
(`nanoagent.uploaded.guest_tools`), which runs as root while the member's processes run as the case user. `strace -ff`
writes one file per process into a root-owned trace directory the member cannot write, so a session's evidence is the
set of files `t.<pid>` it left. Every string is printed hex-escaped (`-xx`), so parsing is exact whatever the argv holds.

What is recorded: each successful `execve`/`execveat` (binary and argv), each process `clone`/`fork`/`vfork` (parent and
child), each `chdir`/`fchdir` (so every event carries the process's working directory), and each process's exit or fatal
signal. Environments are never recorded (they carry the attempt token).

Evidence is `complete` only when nothing was lost: every line parsed, no session's journal overflowed, and every
session's tracer exited normally (the supervisor reports a tracer that was killed).
"""

from __future__ import annotations

import posixpath
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum

MAX_ARGV = 512
MAX_ARG_CHARS = 4096
MAX_FIELD_CHARS = 4096
MAX_EVENTS_PER_CONTAINER = 200_000
LAUNCH_ENV = "/usr/bin/env"
LAUNCH_MARKER = "RUSH_LAUNCH_"
# The flags every session's strace runs with: one file per process, microsecond epoch times, every string hex-escaped,
# descriptors with their paths (for fchdir), and only the system calls the evidence is made of. Signals stay traced: with
# `-e signal=none` strace also drops the `killed by` line of a process a signal ends.
STRACE_FLAGS = (
    "-ff", "-ttt", "-xx", "-y", "-q", "-s", str(MAX_ARG_CHARS), "-e", "trace=execve,execveat,clone,clone3,fork,vfork,chdir,fchdir",
)
# Linux signal numbers, which the host (macOS, say) does not share.
LINUX_SIGNALS = {
    "SIGHUP": 1, "SIGINT": 2, "SIGQUIT": 3, "SIGILL": 4, "SIGTRAP": 5, "SIGABRT": 6, "SIGBUS": 7, "SIGFPE": 8, "SIGKILL": 9,
    "SIGUSR1": 10, "SIGSEGV": 11, "SIGUSR2": 12, "SIGPIPE": 13, "SIGALRM": 14, "SIGTERM": 15, "SIGSTKFLT": 16, "SIGCHLD": 17,
    "SIGCONT": 18, "SIGSTOP": 19, "SIGTSTP": 20, "SIGTTIN": 21, "SIGTTOU": 22, "SIGURG": 23, "SIGXCPU": 24, "SIGXFSZ": 25,
    "SIGVTALRM": 26, "SIGPROF": 27, "SIGWINCH": 28, "SIGIO": 29, "SIGPWR": 30, "SIGSYS": 31,
}


class CollectorError(Exception):
    """The evidence cannot be read; `code` is stable and machine readable."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class ProcessEventKind(StrEnum):
    CONTAINER_START = "container_start"  # the harness session's first process image: the case's init process
    CLONE = "clone"
    EXEC = "exec"  # a successful image replacement: resolved binary and argv
    TASK_EXIT = "task_exit"


Identity = tuple[str, int, int]  # (container id, thread group id, thread group start time ns)


@dataclass(frozen=True, slots=True)
class ProcessEvent:
    seq: int
    kind: ProcessEventKind
    time_ns: int
    container_id: str
    thread_group_id: int
    thread_group_start_time_ns: int
    thread_id: int
    thread_start_time_ns: int
    parent_thread_group_id: int
    process_name: str
    cwd: str
    is_exec_session: bool
    argv: tuple[str, ...] = ()
    argv_truncated: bool = False
    binary_path: str = ""
    exit_status: int | None = None  # as wait(2) reports it
    exit_code: int | None = None
    exit_signal: int | None = None
    created_thread_group_id: int | None = None  # clone only
    created_thread_group_start_time_ns: int | None = None

    @property
    def identity(self) -> Identity:
        return (self.container_id, self.thread_group_id, self.thread_group_start_time_ns)

    @property
    def created_identity(self) -> Identity | None:
        """The new process of a clone; None for a thread, which joins its own thread group and is not a process."""
        if self.created_thread_group_id is None or self.created_thread_group_start_time_ns is None:
            return None
        if self.created_thread_group_id == self.thread_group_id:
            return None
        return (self.container_id, self.created_thread_group_id, self.created_thread_group_start_time_ns)


@dataclass(frozen=True, slots=True)
class ProcessLifetime:
    """One process (thread group + start time) as the events describe it."""

    identity: Identity
    parent: Identity | None  # known when the parent's clone event was seen
    is_exec_session: bool
    execs: tuple[ProcessEvent, ...]  # exec events (container start for init), in order
    exit: ProcessEvent | None  # the thread group leader's exit, when seen
    cwd: str  # the last working directory any event of this process reported

    @property
    def start_ns(self) -> int:
        return self.identity[2]

    @property
    def argv(self) -> tuple[str, ...]:
        return self.execs[-1].argv if self.execs else ()


@dataclass(frozen=True, slots=True)
class ProcessEvidence:
    container_id: str
    events: tuple[ProcessEvent, ...]
    complete: bool
    loss_reasons: tuple[str, ...]
    frames: int  # trace lines read
    malformed: int
    unknown: int  # lines of a system call this parser does not record
    dropped: int  # events past the journal's bound
    connections: int  # trace sessions read
    connections_lost: int  # sessions whose tracer did not end normally

    def lifetimes(self) -> tuple[ProcessLifetime, ...]:
        parents: dict[Identity, Identity] = {}
        execs: dict[Identity, list[ProcessEvent]] = {}
        exits: dict[Identity, ProcessEvent] = {}
        sessions: dict[Identity, bool] = {}
        cwds: dict[Identity, str] = {}
        order: list[Identity] = []

        def see(identity: Identity, exec_session: bool) -> None:
            if identity not in sessions:
                sessions[identity] = exec_session
                order.append(identity)

        for event in self.events:
            see(event.identity, event.is_exec_session)
            if event.cwd:
                cwds[event.identity] = event.cwd
            if event.kind is ProcessEventKind.CLONE and (child := event.created_identity) is not None:
                parents.setdefault(child, event.identity)
                see(child, event.is_exec_session)
            elif event.kind in (ProcessEventKind.EXEC, ProcessEventKind.CONTAINER_START):
                execs.setdefault(event.identity, []).append(event)
            elif event.kind is ProcessEventKind.TASK_EXIT and event.thread_id == event.thread_group_id:
                # Only the leader's exit ends the process; other threads exit earlier.
                exits[event.identity] = event
        return tuple(
            ProcessLifetime(i, parents.get(i), sessions[i], tuple(execs.get(i, ())), exits.get(i), cwds.get(i, "")) for i in order
        )

    def root(self) -> ProcessLifetime | None:
        """The case's init process: the one the container start describes."""
        return next((p for p in self.lifetimes() if any(e.kind is ProcessEventKind.CONTAINER_START for e in p.execs)), None)

    def find_exec(self, argv: tuple[str, ...], *, exec_session: bool | None = None) -> tuple[ProcessLifetime, ...]:
        return tuple(
            p
            for p in self.lifetimes()
            if p.argv == argv and (exec_session is None or p.is_exec_session == exec_session)
        )


@dataclass(frozen=True, slots=True)
class TraceSession:
    """What one strace left: its files by pid, the directory its root started in, and whether the tracer ended normally."""

    files: Mapping[int, bytes]
    cwd: str
    exec_session: bool
    tracer_ok: bool = True


# One trace line: `<epoch seconds>.<micros> <rest>`.
_LINE = re.compile(rb"^(\d+)\.(\d{6}) (.*)$")
_STRING = re.compile(rb'"((?:\\x[0-9a-f]{2})*)"(\.\.\.)?')
_RESULT = re.compile(rb"\) = (-?\d+)(?: <[^>]*>)?(?: [A-Z]+ \(.*\))?$")
_EXITED = re.compile(rb"^\+\+\+ exited with (\d+) \+\+\+$")
_KILLED = re.compile(rb"^\+\+\+ killed by (SIG[A-Z0-9]+)(?: \(core dumped\))? \+\+\+$")
_FDPATH = re.compile(rb"^fchdir\(\d+<((?:\\x[0-9a-f]{2})*)>\)")
_SYSCALL = re.compile(rb"^([a-z0-9_]+)\(")


def _unhex(escaped: bytes) -> str:
    return bytes.fromhex(escaped.replace(b"\\x", b"").decode("ascii")).decode("utf-8", "replace")


def _strings(text: bytes) -> list[tuple[str, bool]]:
    return [(_unhex(m.group(1)), m.group(2) is not None) for m in _STRING.finditer(text)]


def _argv_of(text: bytes) -> tuple[tuple[str, ...], bool, str]:
    """(argv, truncated, binary) of an execve/execveat line: the binary string, then the bracketed argv list."""
    start = text.index(b"[") if b"[" in text else -1
    head, tail = (text[:start], text[start:]) if start >= 0 else (text, b"")
    binary = _strings(head)
    end = tail.find(b"]")
    items = _strings(tail[: end + 1] if end >= 0 else tail)
    truncated = any(cut for _, cut in items) or (end >= 0 and tail[:end].rstrip().endswith(b"..."))
    argv = tuple(a[:MAX_ARG_CHARS] for a, _ in items[:MAX_ARGV])
    return argv, truncated or len(items) > MAX_ARGV, binary[-1][0] if binary else ""


@dataclass
class _Line:
    time_ns: int
    pid: int
    body: bytes


def _join_resumed(pid: int, data: bytes) -> tuple[list[_Line], int]:
    """A file's lines with `<unfinished ...>` / `<... resumed>` pairs joined; and how many lines were malformed."""
    lines: list[_Line] = []
    pending: _Line | None = None
    malformed = 0
    for raw in data.splitlines():
        match = _LINE.match(raw)
        if match is None:
            malformed += 1
            continue
        line = _Line(int(match.group(1)) * 1_000_000_000 + int(match.group(2)) * 1000, pid, match.group(3))
        if line.body.endswith(b" <unfinished ...>"):
            pending = _Line(line.time_ns, pid, line.body.removesuffix(b" <unfinished ...>"))
            continue
        if line.body.startswith(b"<... "):
            if pending is None:
                malformed += 1
                continue
            _, _, rest = line.body.partition(b" resumed>")
            line = _Line(pending.time_ns, pid, pending.body + rest)
            pending = None
        lines.append(line)
    if pending is not None:  # the tracer stopped mid-call: the call never returned
        lines.append(pending)
    return lines, malformed


def parse_trace(container_id: str, sessions: Sequence[TraceSession]) -> ProcessEvidence:
    """The evidence of one case: every session's files merged into one event stream in time order."""
    malformed = unknown = lines_read = lost = 0
    per_pid: dict[int, list[_Line]] = {}
    session_of: dict[int, TraceSession] = {}
    for session in sessions:
        lost += 0 if session.tracer_ok else 1
        for pid, data in session.files.items():
            lines, bad = _join_resumed(pid, data)
            malformed += bad
            lines_read += len(lines) + bad
            per_pid[pid] = lines
            session_of[pid] = session

    # Who created whom, in time order: a thread joins its creator's thread group; a process starts when it is cloned.
    creations: list[tuple[int, int, int, bool]] = []  # (time, parent pid, child pid, is thread)
    for pid, lines in per_pid.items():
        for line in lines:
            name = _SYSCALL.match(line.body)
            if name and name.group(1) in (b"clone", b"clone3", b"fork", b"vfork") and (result := _RESULT.search(line.body)):
                child = int(result.group(1))
                if child > 0:
                    creations.append((line.time_ns, pid, child, b"CLONE_THREAD" in line.body))
    creations.sort()
    tgid: dict[int, int] = {}
    start: dict[int, int] = {}  # per pid: when it was created (or first seen)
    parent_of: dict[int, int] = {}
    for when, parent, child, thread in creations:
        tgid[child] = tgid.get(parent, parent) if thread else child
        start[child] = when
        if not thread:
            parent_of[child] = tgid.get(parent, parent)
    for pid, lines in per_pid.items():
        tgid.setdefault(pid, pid)
        start.setdefault(pid, lines[0].time_ns if lines else 0)

    def group_start(pid: int) -> int:
        return start[tgid[pid]] if tgid[pid] in start else start[pid]

    roots = {pid for pid in per_pid if pid not in parent_of and tgid[pid] == pid}
    cwd: dict[int, str] = {}
    name_of: dict[int, str] = {}
    first_exec_seen: set[int] = set()
    merged = sorted((line for lines in per_pid.values() for line in lines), key=lambda line: (line.time_ns, line.pid))
    events: list[ProcessEvent] = []
    dropped = 0

    def emit(line: _Line, kind: ProcessEventKind, **fields: object) -> None:
        nonlocal dropped
        if len(events) >= MAX_EVENTS_PER_CONTAINER:
            dropped += 1
            return
        leader = tgid[line.pid]
        session = session_of[line.pid]
        events.append(ProcessEvent(
            seq=len(events), kind=kind, time_ns=line.time_ns, container_id=container_id, thread_group_id=leader,
            thread_group_start_time_ns=group_start(line.pid), thread_id=line.pid, thread_start_time_ns=start[line.pid],
            parent_thread_group_id=parent_of.get(leader, 0), process_name=name_of.get(leader, "")[:MAX_FIELD_CHARS],
            cwd=cwd.get(leader, session.cwd)[:MAX_FIELD_CHARS], is_exec_session=session.exec_session, **fields,  # type: ignore[arg-type]
        ))

    for line in merged:
        leader = tgid[line.pid]
        body = line.body
        if (exited := _EXITED.match(body)) is not None:
            code = int(exited.group(1))
            emit(line, ProcessEventKind.TASK_EXIT, exit_status=code << 8, exit_code=code)
            continue
        if (killed := _KILLED.match(body)) is not None:
            signal = LINUX_SIGNALS.get(killed.group(1).decode())
            if signal is None:
                unknown += 1
                continue
            emit(line, ProcessEventKind.TASK_EXIT, exit_status=signal, exit_signal=signal)
            continue
        if body.startswith(b"--- SIG"):  # a signal delivered: its effect is the exit line that follows, if any
            continue
        name = _SYSCALL.match(body)
        result = _RESULT.search(body)
        if name is None:
            unknown += 1
            continue
        call = name.group(1)
        if result is None:  # a call the tracer never saw return: it left no outcome to record
            continue
        value = int(result.group(1))
        if call in (b"execve", b"execveat"):
            if value != 0:
                continue  # a failed exec replaces nothing
            argv, truncated, binary = _argv_of(body)
            name_of[leader] = posixpath.basename(binary)
            first = leader in roots and leader not in first_exec_seen and not session_of[line.pid].exec_session
            first_exec_seen.add(leader)
            kind = ProcessEventKind.CONTAINER_START if first else ProcessEventKind.EXEC
            emit(line, kind, argv=argv, argv_truncated=truncated, binary_path=binary[:MAX_FIELD_CHARS])
        elif call in (b"clone", b"clone3", b"fork", b"vfork"):
            if value <= 0:
                continue
            child = value
            if tgid.get(child) == child:  # a new process, not a thread
                cwd[child] = cwd.get(leader, session_of[line.pid].cwd)
                name_of.setdefault(child, name_of.get(leader, ""))
            emit(line, ProcessEventKind.CLONE, created_thread_group_id=tgid.get(child, child), created_thread_group_start_time_ns=group_start(child) if child in tgid else None)
        elif call == b"chdir":
            if value == 0 and (strings := _strings(body)):
                cwd[leader] = posixpath.normpath(posixpath.join(cwd.get(leader, session_of[line.pid].cwd), strings[0][0]))
        elif call == b"fchdir":
            if value == 0 and (path := _FDPATH.match(body)) is not None:
                cwd[leader] = _unhex(path.group(1))
        else:
            unknown += 1
    reasons = []
    if malformed:
        reasons.append("trace_malformed")
    if dropped:
        reasons.append("journal_overflow")
    if lost:
        reasons.append("tracer_lost")
    return ProcessEvidence(
        container_id, tuple(events), not reasons, tuple(reasons), lines_read, malformed, unknown, dropped, len(sessions), lost,
    )


def _with_seq(event: ProcessEvent, seq: int) -> ProcessEvent:
    return ProcessEvent(**{**{f: getattr(event, f) for f in ProcessEvent.__slots__}, "seq": seq})


def launch_argv(launch_id: str, argv: Sequence[str]) -> list[str]:
    """``argv`` behind a supervisor-owned marker: `env -u RUSH_LAUNCH_<id>` unsets a variable that does not exist, so it
    changes nothing for the member, and it execs the member in the same process, leaving the marker in an observed `execve`."""
    return [LAUNCH_ENV, "-u", f"{LAUNCH_MARKER}{launch_id}", *argv]


def launched_processes(evidence: ProcessEvidence) -> dict[Identity, str]:
    """The process of each managed command, by the launch ID in its marker `execve`.

    A managed command's session is traced from its root (`timeout`), which no traced process created. Its child execs the
    marker and then, in the same process, the member's argv: that process is the command. A marker is honored only as
    the child's first exec directly beneath such a root, so a member that replays a launch ID in its own descendants (or
    a later command) links nothing; a launch ID seen twice links nothing.
    """
    lifetimes = {p.identity: p for p in evidence.lifetimes()}
    found: dict[str, list[Identity]] = {}
    for process in lifetimes.values():
        marker = process.execs[0].argv[:3] if process.execs else ()
        root = lifetimes.get(process.parent) if process.parent is not None else None
        if len(marker) == 3 and marker[:2] == (LAUNCH_ENV, "-u") and marker[2].startswith(LAUNCH_MARKER):
            if root is not None and root.is_exec_session and root.parent is None:
                found.setdefault(marker[2].removeprefix(LAUNCH_MARKER), []).append(process.identity)
    return {identities[0]: launch_id for launch_id, identities in found.items() if len(identities) == 1}
