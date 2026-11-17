"""The seccheck collector: frame decoding on any host, the socket protocol on Linux."""

from __future__ import annotations

import socket
import struct
import time
from pathlib import Path

import pytest

from nanoagent.uploaded.collector import (
    CollectorError,
    FrameError,
    ProcessEventKind,
    SeccheckCollector,
    decode_frame,
    launch_argv,
    launched_processes,
)
from nanoagent.uploaded.seccheck import common_pb2, container_pb2, sentry_pb2, syscall_pb2

CONTAINER = "c" * 64
START_NS = 1_700_000_000_000_000_000


def ctx(tgid: int = 1, *, tid: int | None = None, container: str = CONTAINER, start: int = START_NS, exec_session: bool = False, time_ns: int = 5):
    return common_pb2.ContextData(
        time_ns=time_ns,
        thread_id=tgid if tid is None else tid,
        thread_group_id=tgid,
        thread_group_start_time_ns=start,
        container_id=container,
        cwd="/rush/workspace",
        process_name="proc",
        parent_thread_group_id=0,
        is_exec_session=exec_session,
    )


def frame(message_type: int, message, dropped: int = 0, header_size: int = 8) -> bytes:
    return struct.pack("<HHI", header_size, message_type, dropped) + b"\0" * (header_size - 8) + message.SerializeToString()


def container_start(argv=("python", "/harness/main.py")) -> bytes:
    return frame(common_pb2.MESSAGE_CONTAINER_START, container_pb2.Start(context_data=ctx(), id=CONTAINER, args=argv, env=["RUSH_ATTEMPT_TOKEN=secret"]))


def clone(parent: int, child: int, child_start: int) -> bytes:
    info = sentry_pb2.CloneInfo(context_data=ctx(parent), created_thread_id=child, created_thread_group_id=child, created_thread_start_time_ns=child_start)
    return frame(common_pb2.MESSAGE_SENTRY_CLONE, info)


def exec_(tgid: int, start: int, argv: tuple[str, ...]) -> bytes:
    info = sentry_pb2.ExecveInfo(context_data=ctx(tgid, start=start), binary_path=argv[0], argv=argv, env=["RUSH_ATTEMPT_TOKEN=secret"])
    return frame(common_pb2.MESSAGE_SENTRY_EXEC, info)


def task_exit(tgid: int, start: int, status: int, tid: int | None = None) -> bytes:
    return frame(common_pb2.MESSAGE_SENTRY_TASK_EXIT, sentry_pb2.TaskExit(context_data=ctx(tgid, tid=tid, start=start), exit_status=status))


def test_container_start_keeps_argv_and_never_the_environment():
    decoded = decode_frame(container_start())
    (event,) = decoded.events
    assert event.kind is ProcessEventKind.CONTAINER_START
    assert event.argv == ("python", "/harness/main.py")
    assert decoded.container_id == CONTAINER
    assert "secret" not in repr(event)


def test_exec_event_carries_group_id_start_time_argv_and_cwd_but_not_env():
    (event,) = decode_frame(exec_(7, START_NS + 9, ("/bin/true", "-x"))).events
    assert (event.thread_group_id, event.thread_group_start_time_ns) == (7, START_NS + 9)
    assert event.argv == ("/bin/true", "-x") and event.cwd == "/rush/workspace"
    assert "secret" not in repr(event)


@pytest.mark.parametrize(
    ("status", "code", "signal"),
    [(0, 0, None), (23 << 8, 23, None), (9, None, 9), (11 | 0x80, None, 11)],
)
def test_task_exit_decodes_wait_status_into_exit_code_or_signal(status, code, signal):
    (event,) = decode_frame(task_exit(2, START_NS, status)).events
    assert (event.exit_code, event.exit_signal, event.exit_status) == (code, signal, status)


def test_execve_syscall_points_split_into_enter_and_exit_with_errno():
    enter = syscall_pb2.Execve(context_data=ctx(3), sysno=221, pathname="/bin/true", argv=["/bin/true"])
    leave = syscall_pb2.Execve(context_data=ctx(3), exit=syscall_pb2.Exit(errorno=2), sysno=281, pathname="x", argv=["x"])
    (a,) = decode_frame(frame(common_pb2.MESSAGE_SYSCALL_EXECVE, enter)).events
    (b,) = decode_frame(frame(common_pb2.MESSAGE_SYSCALL_EXECVE, leave)).events
    assert (a.kind, a.syscall, a.syscall_errno) == (ProcessEventKind.EXEC_ENTER, "execve", None)
    assert (b.kind, b.syscall, b.syscall_errno) == (ProcessEventKind.EXEC_EXIT, "execveat", 2)


@pytest.mark.parametrize(
    ("data", "reason"),
    [
        (b"\x08\x00", "short"),
        (struct.pack("<HHI", 4, 3, 0) + b"abcd", "bad_header_size"),
        (struct.pack("<HHI", 64, 3, 0) + b"abcd", "bad_header_size"),
        (struct.pack("<HHI", 8, common_pb2.MESSAGE_SENTRY_EXEC, 0) + b"\xff\xff\xff", "bad_payload"),
        (frame(common_pb2.MESSAGE_SENTRY_TASK_EXIT, sentry_pb2.TaskExit(context_data=ctx(container=""))), "no_container_id"),
    ],
)
def test_malformed_frames_are_rejected_with_a_reason(data, reason):
    with pytest.raises(FrameError) as caught:
        decode_frame(data)
    assert caught.value.reason == reason


def test_oversized_frame_is_rejected():
    with pytest.raises(FrameError) as caught:
        decode_frame(b"\0" * 100, max_bytes=50)
    assert caught.value.reason == "oversized"


def test_unknown_message_types_are_ignored_not_fatal():
    decoded = decode_frame(struct.pack("<HHI", 8, 9999, 3) + b"anything")
    assert decoded.unknown and not decoded.events and decoded.dropped_count == 3


def test_a_larger_header_is_honoured_so_the_payload_starts_after_it():
    (event,) = decode_frame(frame(common_pb2.MESSAGE_SENTRY_TASK_EXIT, sentry_pb2.TaskExit(context_data=ctx(2)), header_size=16)).events
    assert event.thread_group_id == 2


def test_oversized_argv_is_truncated_and_flagged():
    (event,) = decode_frame(exec_(2, START_NS, tuple("a" * 5000 if i == 0 else "b" for i in range(3)))).events
    assert event.argv_truncated and len(event.argv[0]) == 4096


def evidence_from(*frames: bytes):
    from nanoagent.uploaded.collector import ProcessEvidence, _with_seq

    events = tuple(_with_seq(decode_frame(f).events[0], i) for i, f in enumerate(frames))
    return ProcessEvidence(CONTAINER, events, True, (), len(frames), 0, 0, 0, 1, 0)


def test_lifetimes_join_clone_exec_and_exit_by_group_id_and_start_time():
    child_start = START_NS + 100
    evidence = evidence_from(
        container_start(),
        clone(1, 2, child_start),
        exec_(2, child_start, ("/bin/true",)),
        task_exit(2, child_start, 23 << 8),
        task_exit(1, START_NS, 0),
    )
    by_argv = {p.argv: p for p in evidence.lifetimes()}
    child = by_argv[("/bin/true",)]
    assert child.identity == (CONTAINER, 2, child_start)
    assert child.parent == (CONTAINER, 1, START_NS)
    assert child.exit is not None and child.exit.exit_code == 23
    assert by_argv[("python", "/harness/main.py")].exit.exit_code == 0


def test_a_thread_clone_joins_its_thread_group_and_is_not_a_process():
    thread = sentry_pb2.CloneInfo(context_data=ctx(1), created_thread_id=7, created_thread_group_id=1, created_thread_start_time_ns=START_NS + 50)
    evidence = evidence_from(container_start(), frame(common_pb2.MESSAGE_SENTRY_CLONE, thread), task_exit(1, START_NS, 0))
    assert evidence.events[1].created_identity is None
    (process,) = evidence.lifetimes()
    assert process.identity == (CONTAINER, 1, START_NS) and process.parent is None


def test_a_reused_pid_with_a_different_start_time_is_a_different_process():
    evidence = evidence_from(
        exec_(9, START_NS + 1, ("first",)), task_exit(9, START_NS + 1, 0), exec_(9, START_NS + 2, ("second",)), task_exit(9, START_NS + 2, 1 << 8)
    )
    first, second = evidence.lifetimes()
    assert first.identity != second.identity
    assert (first.exit.exit_code, second.exit.exit_code) == (0, 1)


def test_non_leader_thread_exit_does_not_end_the_process():
    evidence = evidence_from(exec_(4, START_NS, ("srv",)), task_exit(4, START_NS, 0, tid=5))
    (process,) = evidence.lifetimes()
    assert process.exit is None


def test_launch_markers_join_a_command_to_its_process_by_evidence():
    # gVisor reports a `docker exec` root (`timeout`) only by its exit; its child execs the marker, then the member.
    def session_exit(tgid: int, start: int) -> bytes:
        return frame(common_pb2.MESSAGE_SENTRY_TASK_EXIT, sentry_pb2.TaskExit(context_data=ctx(tgid, start=start, exec_session=True), exit_status=0))

    def session_clone(parent: int, parent_start: int, child: int, child_start: int) -> bytes:
        info = sentry_pb2.CloneInfo(context_data=ctx(parent, start=parent_start, exec_session=True), created_thread_id=child, created_thread_group_id=child, created_thread_start_time_ns=child_start)
        return frame(common_pb2.MESSAGE_SENTRY_CLONE, info)

    evidence = evidence_from(
        session_exit(20, 2000),
        session_clone(20, 2000, 21, 2100),
        exec_(21, 2100, launch_argv("a" * 32, ("true",))),
        exec_(21, 2100, ("true",)),
        session_clone(20, 2000, 22, 2200),
        exec_(22, 2200, launch_argv("b" * 32, ("false",))),
        session_clone(22, 2200, 23, 2300),
        exec_(23, 2300, launch_argv("a" * 32, ("replayed",))),
    )
    joined = launched_processes(evidence)
    assert joined == {(CONTAINER, 21, 2100): "a" * 32, (CONTAINER, 22, 2200): "b" * 32}, "a replay beneath a command is not a root's child"


def test_a_launch_id_seen_on_two_roots_children_links_nothing():
    def session_clone(parent: int, parent_start: int, child: int, child_start: int) -> bytes:
        info = sentry_pb2.CloneInfo(context_data=ctx(parent, start=parent_start, exec_session=True), created_thread_id=child, created_thread_group_id=child, created_thread_start_time_ns=child_start)
        return frame(common_pb2.MESSAGE_SENTRY_CLONE, info)

    marker = launch_argv("c" * 32, ("true",))
    evidence = evidence_from(session_clone(30, 3000, 31, 3100), exec_(31, 3100, marker), session_clone(32, 3200, 33, 3300), exec_(33, 3300, marker))
    assert launched_processes(evidence) == {}


# -- the socket protocol (SOCK_SEQPACKET exists on Linux only) -------------------------------------

def _seqpacket_works() -> bool:
    try:
        socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET).close()
    except (AttributeError, OSError):
        return False
    return True


linux_only = pytest.mark.skipif(not _seqpacket_works(), reason="SOCK_SEQPACKET unix sockets are Linux only")


class FakeSandbox:
    """What runsc's remote sink does: connect, handshake, then stream frames."""

    def __init__(self, path: Path, version: int = 1) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.sock.connect(str(path))
        self.sock.send(common_pb2.Handshake(version=version).SerializeToString())
        self.reply = common_pb2.Handshake.FromString(self.sock.recv(1024)) if version == 1 else None

    def send(self, *frames: bytes) -> None:
        for data in frames:
            self.sock.send(data)

    def close(self) -> None:
        self.sock.close()


@pytest.fixture
def collector(tmp_path):
    c = SeccheckCollector(tmp_path / "seccheck.sock")
    c.start()
    yield c
    c.stop()


@linux_only
def test_handshake_replies_with_the_wire_version(collector, tmp_path):
    sandbox = FakeSandbox(tmp_path / "seccheck.sock")
    assert sandbox.reply.version == 1
    sandbox.close()


@linux_only
def test_events_are_journaled_per_container_and_clean_close_is_complete(collector, tmp_path):
    collector.session(CONTAINER)
    sandbox = FakeSandbox(tmp_path / "seccheck.sock")
    sandbox.send(container_start(), exec_(2, START_NS + 1, ("/bin/true",)), task_exit(2, START_NS + 1, 0))
    sandbox.close()
    evidence = collector.finish(CONTAINER, timeout_s=5)
    assert evidence.complete and evidence.loss_reasons == ()
    assert [e.kind for e in evidence.events] == [ProcessEventKind.CONTAINER_START, ProcessEventKind.EXEC, ProcessEventKind.TASK_EXIT]
    assert [e.seq for e in evidence.events] == [0, 1, 2]


@linux_only
def test_reported_drops_make_evidence_incomplete(collector, tmp_path):
    collector.session(CONTAINER)
    sandbox = FakeSandbox(tmp_path / "seccheck.sock")
    sandbox.send(container_start(), frame(common_pb2.MESSAGE_SENTRY_TASK_EXIT, sentry_pb2.TaskExit(context_data=ctx(2)), dropped=4))
    sandbox.close()
    evidence = collector.finish(CONTAINER, timeout_s=5)
    assert not evidence.complete and evidence.dropped == 4
    assert "reported_drops:4" in evidence.loss_reasons


@linux_only
def test_malformed_frame_is_counted_and_incomplete_but_later_frames_still_land(collector, tmp_path):
    collector.session(CONTAINER)
    sandbox = FakeSandbox(tmp_path / "seccheck.sock")
    sandbox.send(container_start(), b"\x01", task_exit(2, START_NS + 1, 0))
    sandbox.close()
    evidence = collector.finish(CONTAINER, timeout_s=5)
    assert evidence.malformed == 1 and not evidence.complete
    assert len(evidence.events) == 2


@linux_only
def test_a_frame_naming_another_container_is_rejected(collector, tmp_path):
    collector.session(CONTAINER)
    sandbox = FakeSandbox(tmp_path / "seccheck.sock")
    other = frame(common_pb2.MESSAGE_SENTRY_TASK_EXIT, sentry_pb2.TaskExit(context_data=ctx(2, container="d" * 64)))
    sandbox.send(container_start(), other)
    sandbox.close()
    evidence = collector.finish(CONTAINER, timeout_s=5)
    assert evidence.malformed == 1 and len(evidence.events) == 1 and not evidence.complete


@linux_only
def test_stopping_the_collector_mid_stream_marks_evidence_incomplete(tmp_path):
    collector = SeccheckCollector(tmp_path / "seccheck.sock")
    collector.start()
    collector.session(CONTAINER)
    sandbox = FakeSandbox(tmp_path / "seccheck.sock")
    sandbox.send(container_start())
    deadline = time.monotonic() + 5
    while collector.health().connections_open == 0 or time.monotonic() < deadline and not collector._sessions[CONTAINER].events:
        time.sleep(0.01)
    collector.stop()
    evidence = collector.finish(CONTAINER, timeout_s=1)
    assert not evidence.complete and "collector_stopped" in evidence.loss_reasons
    assert len(evidence.events) == 1  # what was already journaled stays available
    sandbox.close()


@linux_only
def test_a_container_that_never_connected_is_incomplete_not_silently_complete(collector):
    collector.session(CONTAINER)
    evidence = collector.finish(CONTAINER, timeout_s=0.1)
    assert not evidence.complete and "no_connection" in evidence.loss_reasons


@linux_only
def test_a_connection_still_open_at_finish_is_a_loss_reason(collector, tmp_path):
    collector.session(CONTAINER)
    sandbox = FakeSandbox(tmp_path / "seccheck.sock")
    sandbox.send(container_start())
    evidence = collector.finish(CONTAINER, timeout_s=0.3)
    assert "connection_open_at_finish" in evidence.loss_reasons
    sandbox.close()


@linux_only
def test_wrong_handshake_version_is_refused_and_counted(collector, tmp_path):
    sandbox = FakeSandbox(tmp_path / "seccheck.sock", version=2)
    sandbox.sock.settimeout(5)
    assert sandbox.sock.recv(1024) == b""  # the collector hung up
    assert collector.health().handshake_failures == 1
    sandbox.close()


@linux_only
def test_frames_for_unregistered_containers_are_counted_not_journaled(collector, tmp_path):
    sandbox = FakeSandbox(tmp_path / "seccheck.sock")
    sandbox.send(container_start())
    sandbox.close()
    deadline = time.monotonic() + 5
    while collector.health().unregistered_frames == 0 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert collector.health().unregistered_frames == 1


@linux_only
def test_journal_byte_budget_overflows_like_the_count_cap(tmp_path):
    collector = SeccheckCollector(tmp_path / "s.sock", max_chars_per_container=1)
    collector.start()
    try:
        collector.session(CONTAINER)
        sandbox = FakeSandbox(tmp_path / "s.sock")
        sandbox.send(container_start(), task_exit(2, START_NS, 0))
        sandbox.close()
        evidence = collector.finish(CONTAINER, timeout_s=5)
        assert "journal_overflow" in evidence.loss_reasons and len(evidence.events) < 2
    finally:
        collector.stop()


@linux_only
def test_journal_overflow_is_a_loss_reason(tmp_path):
    collector = SeccheckCollector(tmp_path / "s.sock", max_events_per_container=1)
    collector.start()
    try:
        collector.session(CONTAINER)
        sandbox = FakeSandbox(tmp_path / "s.sock")
        sandbox.send(container_start(), task_exit(2, START_NS, 0))
        sandbox.close()
        evidence = collector.finish(CONTAINER, timeout_s=5)
        assert "journal_overflow" in evidence.loss_reasons and len(evidence.events) == 1
    finally:
        collector.stop()


@linux_only
def test_start_fails_clearly_when_the_socket_cannot_be_bound(tmp_path):
    blocker = SeccheckCollector(tmp_path / "taken.sock")
    blocker.start()
    try:
        with pytest.raises(CollectorError) as caught:
            SeccheckCollector(tmp_path / "taken.sock").start()
        assert caught.value.code == "socket_unavailable" and "already listening" in caught.value.message
    finally:
        blocker.stop()
    with pytest.raises(CollectorError) as caught:
        SeccheckCollector(tmp_path / "missing-dir" / "s.sock").start()
    assert caught.value.code == "socket_unavailable"


@linux_only
def test_a_stale_socket_file_from_a_crashed_collector_is_replaced(tmp_path):
    path = tmp_path / "stale.sock"
    dead = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    dead.bind(str(path))
    dead.close()  # the file stays, nothing listens
    collector = SeccheckCollector(path)
    collector.start()
    assert collector.health().listening
    collector.stop()


def test_start_is_refused_where_seqpacket_does_not_exist(tmp_path, monkeypatch):
    monkeypatch.delattr(socket, "SOCK_SEQPACKET", raising=False)
    with pytest.raises(CollectorError) as caught:
        SeccheckCollector(tmp_path / "s.sock").start()
    assert caught.value.code == "unsupported_platform"


def test_session_requires_a_listening_collector(tmp_path):
    with pytest.raises(CollectorError) as caught:
        SeccheckCollector(tmp_path / "s.sock").session(CONTAINER)
    assert caught.value.code == "not_listening"

