"""The worker's fail-closed gVisor trace sink: protected process evidence for every case sandbox.

`runsc-rush` (deploy/gvisor/setup.py) streams trace points to a `remote` sink whose setup error is
fatal, so a container cannot start unless this collector is listening. The wire protocol is
gVisor's (pkg/sentry/seccheck/sinks/remote): a `SOCK_SEQPACKET` unix socket, one connection per
sandbox, a `Handshake` exchange, then one message per datagram made of an 8-byte little-endian
header (header size u16, message type u16, cumulative dropped count u32) and a protobuf payload.
Payloads are decoded with modules generated from gVisor's own .proto files (see seccheck/).

The Sentry is not trusted, so every frame is size-checked and a malformed one is counted, never
fatal. Evidence is `complete` only when nothing was lost: no malformed frame, no reported drop, no
lost connection, no journal overflow, and the sandbox's connection closed after its frames were
read. Environments are never recorded (they carry the attempt token).
"""

from __future__ import annotations

import errno
import os
import socket
import stat
import struct
import threading
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from google.protobuf.message import DecodeError

from nanoagent.uploaded.seccheck import common_pb2, container_pb2, sentry_pb2, syscall_pb2

WIRE_VERSION = 1
HEADER_STRUCT = struct.Struct("<HHI")
MAX_FRAME_BYTES = 1 << 20
MAX_ARGV = 512
MAX_ARG_CHARS = 4096
MAX_FIELD_CHARS = 4096
_U32 = 1 << 32
_HANDSHAKE_TIMEOUT_S = 5.0
LAUNCH_ENV = "/usr/bin/env"
LAUNCH_MARKER = "RUSH_LAUNCH_"

_EXEC_SYSNOS = {
    # arm64 and amd64 numbers of execve(2) and execveat(2); the syscall points carry the raw number.
    59: "execve",
    221: "execve",
    322: "execveat",
    281: "execveat",
}


class CollectorError(Exception):
    """The collector cannot do what was asked; `code` is stable and machine readable."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class FrameError(Exception):
    """A frame that cannot be decoded; `reason` is a stable short name."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(f"{reason}: {message}")
        self.reason = reason


class ProcessEventKind(StrEnum):
    CONTAINER_START = "container_start"
    CLONE = "clone"
    EXEC = "exec"  # the image replacement (sentry/execve): resolved binary and argv
    EXEC_ENTER = "exec_enter"  # syscall/execve|execveat/enter
    EXEC_EXIT = "exec_exit"  # syscall/execve|execveat/exit
    EXIT_NOTIFY = "exit_notify"
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
    sysno: int | None = None
    syscall: str = ""  # "execve" or "execveat" on the syscall points
    syscall_errno: int | None = None  # exit points only
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
    execs: tuple[ProcessEvent, ...]  # sentry/execve events (container/start for init), in order
    exit: ProcessEvent | None  # the thread group leader's task exit, when seen
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
    frames: int
    malformed: int
    unknown: int  # frames of a type this build does not decode; ignored by gVisor's compatibility rule
    dropped: int  # sum over connections of the drops the Sentry reported
    connections: int
    connections_lost: int

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
                # The container's init process has no execve event of its own: container/start carries its argv.
                execs.setdefault(event.identity, []).append(event)
            elif event.kind is ProcessEventKind.TASK_EXIT and event.thread_id == event.thread_group_id:
                # Only the leader's exit ends the process; other threads exit earlier.
                exits[event.identity] = event
        return tuple(
            ProcessLifetime(i, parents.get(i), sessions[i], tuple(execs.get(i, ())), exits.get(i), cwds.get(i, "")) for i in order
        )

    def root(self) -> ProcessLifetime | None:
        """The container's init process: the one container/start describes."""
        return next((p for p in self.lifetimes() if any(e.kind is ProcessEventKind.CONTAINER_START for e in p.execs)), None)

    def find_exec(self, argv: tuple[str, ...], *, exec_session: bool | None = None) -> tuple[ProcessLifetime, ...]:
        return tuple(
            p
            for p in self.lifetimes()
            if p.argv == argv and (exec_session is None or p.is_exec_session == exec_session)
        )


@dataclass(frozen=True, slots=True)
class CollectorHealth:
    listening: bool
    connections_open: int
    connections_total: int
    handshake_failures: int
    unregistered_frames: int  # frames for a container no session was opened for


@dataclass(frozen=True, slots=True)
class DecodedFrame:
    dropped_count: int  # cumulative, per connection, wrapping at 2**32
    events: tuple[ProcessEvent, ...]  # empty for an unknown message type, or one the collector ignores
    container_id: str | None
    unknown: bool


def _text(value: str) -> str:
    return value[:MAX_FIELD_CHARS]


def _argv(values: object) -> tuple[tuple[str, ...], bool]:
    items = list(values)  # type: ignore[call-overload]
    truncated = len(items) > MAX_ARGV or any(len(a) > MAX_ARG_CHARS for a in items[:MAX_ARGV])
    return tuple(a[:MAX_ARG_CHARS] for a in items[:MAX_ARGV]), truncated


def _wait_status(status: int) -> tuple[int | None, int | None]:
    signal = status & 0x7F
    if signal == 0:
        return (status >> 8) & 0xFF, None
    return None, signal


def _base(kind: ProcessEventKind, ctx: common_pb2.ContextData, **fields: object) -> ProcessEvent:
    return ProcessEvent(
        seq=0,
        kind=kind,
        time_ns=ctx.time_ns,
        container_id=_text(ctx.container_id),
        thread_group_id=ctx.thread_group_id,
        thread_group_start_time_ns=ctx.thread_group_start_time_ns,
        thread_id=ctx.thread_id,
        thread_start_time_ns=ctx.thread_start_time_ns,
        parent_thread_group_id=ctx.parent_thread_group_id,
        process_name=_text(ctx.process_name),
        cwd=_text(ctx.cwd),
        is_exec_session=ctx.is_exec_session,
        **fields,  # type: ignore[arg-type]
    )


def _decode_payload(message_type: int, payload: bytes) -> ProcessEvent | None:
    """One protobuf payload to an event; None for a type that is known but not evidence."""
    if message_type == common_pb2.MESSAGE_CONTAINER_START:
        start = container_pb2.Start.FromString(payload)
        argv, truncated = _argv(start.args)
        # `env` is never read: it carries the attempt token.
        return _base(ProcessEventKind.CONTAINER_START, start.context_data, argv=argv, argv_truncated=truncated)
    if message_type == common_pb2.MESSAGE_SENTRY_CLONE:
        clone = sentry_pb2.CloneInfo.FromString(payload)
        return _base(
            ProcessEventKind.CLONE,
            clone.context_data,
            created_thread_group_id=clone.created_thread_group_id,
            created_thread_group_start_time_ns=clone.created_thread_start_time_ns,
        )
    if message_type == common_pb2.MESSAGE_SENTRY_EXEC:
        exec_ = sentry_pb2.ExecveInfo.FromString(payload)
        argv, truncated = _argv(exec_.argv)
        return _base(
            ProcessEventKind.EXEC, exec_.context_data, argv=argv, argv_truncated=truncated, binary_path=_text(exec_.binary_path)
        )
    if message_type == common_pb2.MESSAGE_SENTRY_EXIT_NOTIFY_PARENT:
        notify = sentry_pb2.ExitNotifyParentInfo.FromString(payload)
        code, signal = _wait_status(notify.exit_status)
        return _base(
            ProcessEventKind.EXIT_NOTIFY, notify.context_data, exit_status=notify.exit_status, exit_code=code, exit_signal=signal
        )
    if message_type == common_pb2.MESSAGE_SENTRY_TASK_EXIT:
        task_exit = sentry_pb2.TaskExit.FromString(payload)
        code, signal = _wait_status(task_exit.exit_status)
        return _base(
            ProcessEventKind.TASK_EXIT, task_exit.context_data, exit_status=task_exit.exit_status, exit_code=code, exit_signal=signal
        )
    if message_type == common_pb2.MESSAGE_SYSCALL_EXECVE:
        sys_exec = syscall_pb2.Execve.FromString(payload)
        syscall = _EXEC_SYSNOS.get(sys_exec.sysno, "")
        argv, truncated = _argv(sys_exec.argv)
        exited = sys_exec.HasField("exit")
        return _base(
            ProcessEventKind.EXEC_EXIT if exited else ProcessEventKind.EXEC_ENTER,
            sys_exec.context_data,
            argv=argv,
            argv_truncated=truncated,
            binary_path=_text(sys_exec.pathname),
            sysno=sys_exec.sysno,
            syscall=syscall,
            syscall_errno=sys_exec.exit.errorno if exited else None,
        )
    return None


def decode_frame(frame: bytes, *, max_bytes: int = MAX_FRAME_BYTES) -> DecodedFrame:
    """Decodes one datagram. Raises [FrameError] when it is malformed."""
    if len(frame) > max_bytes:
        raise FrameError("oversized", f"{len(frame)} bytes exceeds {max_bytes}")
    if len(frame) < HEADER_STRUCT.size:
        raise FrameError("short", f"{len(frame)} bytes is smaller than the header")
    header_size, message_type, dropped = HEADER_STRUCT.unpack_from(frame)
    if header_size < HEADER_STRUCT.size or header_size > len(frame):
        raise FrameError("bad_header_size", f"header size {header_size} in a {len(frame)} byte frame")
    known = message_type in (
        common_pb2.MESSAGE_CONTAINER_START,
        common_pb2.MESSAGE_SENTRY_CLONE,
        common_pb2.MESSAGE_SENTRY_EXEC,
        common_pb2.MESSAGE_SENTRY_EXIT_NOTIFY_PARENT,
        common_pb2.MESSAGE_SENTRY_TASK_EXIT,
        common_pb2.MESSAGE_SYSCALL_EXECVE,
    )
    if not known:
        return DecodedFrame(dropped, (), None, unknown=True)
    try:
        event = _decode_payload(message_type, frame[header_size:])
    except DecodeError as error:
        raise FrameError("bad_payload", str(error)) from error
    if event is None:
        return DecodedFrame(dropped, (), None, unknown=True)
    if not event.container_id:
        raise FrameError("no_container_id", "context carries no container id")
    return DecodedFrame(dropped, (event,), event.container_id, unknown=False)


@dataclass
class _Connection:
    id: int
    container_id: str | None = None
    last_dropped: int = 0
    open: bool = True


@dataclass
class _Session:
    container_id: str
    events: list[ProcessEvent] = field(default_factory=list)
    reasons: dict[str, None] = field(default_factory=dict)  # ordered set
    frames: int = 0
    malformed: int = 0
    unknown: int = 0
    dropped: int = 0
    connections: int = 0
    connections_open: int = 0
    connections_lost: int = 0
    overflowed: bool = False

    def lose(self, reason: str) -> None:
        self.reasons.setdefault(reason, None)


class SeccheckCollector:
    """Listens for gVisor sandboxes' trace connections and journals their events per container."""

    def __init__(self, socket_path: str | Path, *, max_events_per_container: int = 200_000) -> None:
        self._path = str(socket_path)
        self._max_events = max_events_per_container
        self._cond = threading.Condition()
        self._sessions: dict[str, _Session] = {}
        self._connections: dict[int, tuple[_Connection, socket.socket]] = {}
        self._listener: socket.socket | None = None
        self._accept_thread: threading.Thread | None = None
        self._stopped = False
        self._next_connection = 0
        self._connections_total = 0
        self._handshake_failures = 0
        self._unregistered = 0

    def start(self) -> None:
        """Binds the socket. Fails with a [CollectorError] when it cannot listen."""
        if self._listener is not None:
            raise CollectorError("already_started", f"collector already listening on {self._path}")
        seqpacket = getattr(socket, "SOCK_SEQPACKET", None)
        try:
            if seqpacket is None:
                raise OSError("SOCK_SEQPACKET is not defined")
            listener = socket.socket(socket.AF_UNIX, seqpacket)
        except OSError as error:
            raise CollectorError("unsupported_platform", f"SOCK_SEQPACKET unix sockets are required (Linux execution workers only): {error}") from error
        try:
            self._remove_stale_socket()
        except CollectorError:
            listener.close()
            raise
        try:
            listener.bind(self._path)
            listener.listen(64)
        except OSError as error:
            listener.close()
            raise CollectorError("socket_unavailable", f"cannot listen on {self._path}: {error}") from error
        self._listener = listener
        self._stopped = False
        self._accept_thread = threading.Thread(target=self._accept_loop, name="seccheck-accept", daemon=True)
        self._accept_thread.start()

    def _remove_stale_socket(self) -> None:
        try:
            mode = os.lstat(self._path).st_mode
        except FileNotFoundError:
            return
        except OSError as error:
            raise CollectorError("socket_unavailable", f"cannot stat {self._path}: {error}") from error
        if not stat.S_ISSOCK(mode):
            raise CollectorError("socket_unavailable", f"{self._path} exists and is not a socket")
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        try:
            probe.connect(self._path)
        except OSError as error:
            if error.errno not in (errno.ECONNREFUSED, errno.ENOENT):
                raise CollectorError("socket_unavailable", f"cannot probe {self._path}: {error}") from error
            os.unlink(self._path)  # nobody is listening: a leftover of a crashed collector
        else:
            raise CollectorError("socket_unavailable", f"another collector is already listening on {self._path}")
        finally:
            probe.close()

    def stop(self) -> None:
        """Stops listening and drops every connection; open sessions become incomplete."""
        with self._cond:
            self._stopped = True
            listener, self._listener = self._listener, None
            open_connections = list(self._connections.values())
        if listener is not None:
            listener.close()
            try:
                os.unlink(self._path)
            except FileNotFoundError:
                pass
        for _, sock in open_connections:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()
        with self._cond:
            for session in self._sessions.values():
                session.lose("collector_stopped")
            self._cond.notify_all()

    def health(self) -> CollectorHealth:
        with self._cond:
            return CollectorHealth(
                listening=self._listener is not None and not self._stopped,
                connections_open=len(self._connections),
                connections_total=self._connections_total,
                handshake_failures=self._handshake_failures,
                unregistered_frames=self._unregistered,
            )

    def session(self, container_id: str) -> None:
        """Opens the journal for a container. Call it after `docker create` and before `docker start`."""
        with self._cond:
            if self._stopped or self._listener is None:
                raise CollectorError("not_listening", "the collector is not listening")
            if container_id in self._sessions:
                raise CollectorError("duplicate_session", f"a session for container {container_id} is already open")
            self._sessions[container_id] = _Session(container_id)

    def finish(self, container_id: str, *, timeout_s: float = 10.0) -> ProcessEvidence:
        """Waits for the sandbox's connection to close (so every frame is read), then returns evidence.

        Call it once the container has stopped. A connection still open at the deadline, or none seen at
        all, is a loss reason, never a silent pass.
        """
        with self._cond:
            session = self._sessions.get(container_id)
            if session is None:
                raise CollectorError("unknown_session", f"no session for container {container_id}")
            self._cond.wait_for(
                lambda: (session.connections > 0 and session.connections_open == 0) or self._stopped, timeout=timeout_s
            )
            return self._evidence(session)

    def snapshot(self, container_id: str) -> ProcessEvidence:
        """The evidence journaled so far, without waiting for the sandbox to end; it is `complete` only once `finish` confirms it."""
        with self._cond:
            session = self._sessions.get(container_id)
            if session is None:
                raise CollectorError("unknown_session", f"no session for container {container_id}")
            return self._evidence(session)

    def discard(self, container_id: str) -> None:
        with self._cond:
            self._sessions.pop(container_id, None)

    def _evidence(self, session: _Session) -> ProcessEvidence:
        reasons = dict(session.reasons)
        if session.connections == 0:
            reasons.setdefault("no_connection", None)
        if session.connections_open > 0:
            reasons.setdefault("connection_open_at_finish", None)
        if session.malformed:
            reasons.setdefault(f"malformed_frames:{session.malformed}", None)
        if session.dropped:
            reasons.setdefault(f"reported_drops:{session.dropped}", None)
        if session.connections_lost:
            reasons.setdefault("connection_lost", None)
        if session.overflowed:
            reasons.setdefault("journal_overflow", None)
        return ProcessEvidence(
            container_id=session.container_id,
            events=tuple(session.events),
            complete=not reasons,
            loss_reasons=tuple(reasons),
            frames=session.frames,
            malformed=session.malformed,
            unknown=session.unknown,
            dropped=session.dropped,
            connections=session.connections,
            connections_lost=session.connections_lost,
        )

    def _accept_loop(self) -> None:
        while True:
            listener = self._listener
            if listener is None:
                return
            try:
                sock, _ = listener.accept()
            except OSError:
                return
            with self._cond:
                if self._stopped:
                    sock.close()
                    return
                self._next_connection += 1
                connection = _Connection(self._next_connection)
                self._connections[connection.id] = (connection, sock)
                self._connections_total += 1
            threading.Thread(target=self._serve, args=(connection, sock), name=f"seccheck-{connection.id}", daemon=True).start()

    def _handshake(self, sock: socket.socket) -> None:
        sock.settimeout(_HANDSHAKE_TIMEOUT_S)
        data = sock.recv(1024)
        hello = common_pb2.Handshake.FromString(data)
        if hello.version != WIRE_VERSION:
            raise FrameError("handshake_version", f"remote speaks wire version {hello.version}, collector speaks {WIRE_VERSION}")
        sock.send(common_pb2.Handshake(version=WIRE_VERSION).SerializeToString())
        sock.settimeout(None)

    def _serve(self, connection: _Connection, sock: socket.socket) -> None:
        loss: str | None = None
        try:
            try:
                self._handshake(sock)
            except (FrameError, DecodeError, OSError):
                with self._cond:
                    self._handshake_failures += 1
                return
            while True:
                frame = sock.recv(MAX_FRAME_BYTES + 1)
                if not frame:
                    return  # the sandbox closed its end: a clean end of stream
                self._ingest(connection, frame)
        except OSError:
            loss = "connection_lost"
        finally:
            sock.close()
            with self._cond:
                self._connections.pop(connection.id, None)
                connection.open = False
                session = self._sessions.get(connection.container_id) if connection.container_id else None
                if session is not None:
                    session.connections_open -= 1
                    if loss is not None and not self._stopped:
                        session.connections_lost += 1
                self._cond.notify_all()

    def _ingest(self, connection: _Connection, frame: bytes) -> None:
        try:
            decoded = decode_frame(frame)
        except FrameError:
            with self._cond:
                session = self._sessions.get(connection.container_id) if connection.container_id else None
                if session is not None:
                    session.frames += 1
                    session.malformed += 1
                else:
                    self._unregistered += 1
            return
        with self._cond:
            if connection.container_id is None and decoded.container_id is not None:
                connection.container_id = decoded.container_id
                session = self._sessions.get(decoded.container_id)
                if session is not None:
                    session.connections += 1
                    session.connections_open += 1
            session = self._sessions.get(connection.container_id) if connection.container_id else None
            if session is None:
                self._unregistered += 1
                return
            session.frames += 1
            session.dropped += (decoded.dropped_count - connection.last_dropped) % _U32
            connection.last_dropped = decoded.dropped_count
            if decoded.unknown:
                session.unknown += 1
            for event in decoded.events:
                if event.container_id != connection.container_id:
                    # A sandbox reports only its own container: anything else is hostile or corrupt.
                    session.malformed += 1
                    continue
                if len(session.events) >= self._max_events:
                    session.overflowed = True
                    continue
                session.events.append(_with_seq(event, len(session.events)))


def _with_seq(event: ProcessEvent, seq: int) -> ProcessEvent:
    return ProcessEvent(**{**{f: getattr(event, f) for f in ProcessEvent.__slots__}, "seq": seq})


def launch_argv(launch_id: str, argv: Sequence[str]) -> list[str]:
    """``argv`` behind a supervisor-owned marker: `env -u RUSH_LAUNCH_<id>` unsets a variable that does not exist, so it
    changes nothing for the member, and it execs the member in the same process, leaving the marker in an observed `execve`."""
    return [LAUNCH_ENV, "-u", f"{LAUNCH_MARKER}{launch_id}", *argv]


def launched_processes(evidence: ProcessEvidence) -> dict[Identity, str]:
    """The process of each managed command, by the launch ID in its marker `execve`.

    gVisor starts a `docker exec` process without an execve, so the root of an exec session (`timeout`) is only a start, an
    exit and descendants. Its child execs the marker and then, in the same thread group, the member's argv: that process is
    the command. A marker is honored only as the child's first exec directly beneath such a root, so a member that
    replays a launch ID in its own descendants (or a later command) links nothing; a launch ID seen twice links nothing.
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
