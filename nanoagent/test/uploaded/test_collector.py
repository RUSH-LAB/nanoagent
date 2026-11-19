"""The strace evidence: `strace -ff -ttt -xx -y` files parsed into process events, lifetimes and launch links."""

from __future__ import annotations

from nanoagent.uploaded.collector import (
    LAUNCH_ENV,
    LAUNCH_MARKER,
    MAX_EVENTS_PER_CONTAINER,
    ProcessEventKind,
    TraceSession,
    launch_argv,
    launched_processes,
    parse_trace,
)

C = "rush-case-1"


def h(text: str) -> str:
    """A string as strace -xx prints it."""
    return '"' + "".join(f"\\x{byte:02x}" for byte in text.encode()) + '"'


def execve(t: str, argv: list[str], result: str = "0") -> str:
    return f"{t} execve({h(argv[0])}, [{', '.join(h(a) for a in argv)}], 0xffff /* 5 vars */) = {result}"


def clone(t: str, child: int, *, thread: bool = False) -> str:
    flags = "CLONE_VM|CLONE_FS|CLONE_THREAD|CLONE_SIGHAND" if thread else "CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD"
    return f"{t} clone(child_stack=NULL, flags={flags}, child_tidptr=0xffff) = {child}"


def session(files: dict[int, list[str]], *, cwd: str = "/rush/workspace", exec_session: bool = False, tracer_ok: bool = True) -> TraceSession:
    return TraceSession({pid: "\n".join(lines).encode() for pid, lines in files.items()}, cwd, exec_session, tracer_ok)


def test_the_harness_root_child_exits_and_signals_join_by_group_id_and_start_time():
    evidence = parse_trace(C, [session({
        10: [execve("100.000001", ["python", "/harness/main.py"]), clone("100.000100", 11), "100.000900 +++ exited with 0 +++"],
        11: [execve("100.000200", ["/bin/sh", "-c", "exit 23"]), "100.000300 +++ exited with 23 +++"],
        12: ["100.000400 +++ killed by SIGSEGV (core dumped) +++"],
    })])
    assert evidence.complete and evidence.malformed == 0 and evidence.connections == 1
    root = evidence.root()
    assert root is not None and root.argv == ("python", "/harness/main.py") and root.exit.exit_code == 0
    child = next(p for p in evidence.lifetimes() if p.argv == ("/bin/sh", "-c", "exit 23"))
    assert child.parent == root.identity and child.exit.exit_code == 23 and child.exit.exit_status == 23 << 8
    assert child.identity == (C, 11, 100_000_100_000), "a child starts when it is cloned"
    killed = next(e for e in evidence.events if e.thread_id == 12)
    assert (killed.exit_signal, killed.exit_code) == (11, None), "Linux signal numbers, whatever the host's"
    assert [e.kind for e in evidence.events][:2] == [ProcessEventKind.CONTAINER_START, ProcessEventKind.CLONE]


def test_strings_are_exact_whatever_they_hold_and_long_or_many_arguments_are_flagged():
    odd = 'say "hi", [x] /* not a comment */ \\ \n ünïcode'
    evidence = parse_trace(C, [session({
        10: [execve("1.000001", ["/bin/echo", odd]), f'1.000002 execve({h("/bin/a")}, [{h("a")}, {h("b")}...], 0x1 /* 1 var */) = 0'],
    })])
    first, second = (e for e in evidence.events if e.kind in (ProcessEventKind.CONTAINER_START, ProcessEventKind.EXEC))
    assert first.argv == ("/bin/echo", odd) and not first.argv_truncated and first.binary_path == "/bin/echo"
    assert second.argv == ("a", "b") and second.argv_truncated


def test_a_failed_exec_replaces_nothing_and_signal_lines_are_not_events():
    evidence = parse_trace(C, [session({
        10: [
            execve("1.000001", ["/usr/local/bin/date"], "-1 ENOENT (No such file or directory)"),
            execve("1.000002", ["/usr/bin/date"]),
            "1.000003 --- SIGCHLD {si_signo=SIGCHLD, si_code=CLD_EXITED, si_pid=11} ---",
            "1.000004 +++ exited with 0 +++",
        ],
    })])
    assert evidence.root().argv == ("/usr/bin/date",)
    assert [e.kind for e in evidence.events] == [ProcessEventKind.CONTAINER_START, ProcessEventKind.TASK_EXIT]
    assert evidence.complete


def test_chdir_and_fchdir_move_a_process_and_its_later_children():
    evidence = parse_trace(C, [session({
        10: [
            execve("1.000001", ["sh"]),
            f"1.000002 chdir({h('sub')}) = 0",
            f"1.000003 chdir({h('/nowhere')}) = -1 ENOENT (No such file or directory)",
            clone("1.000004", 11),
            f"1.000006 fchdir(3<{h('/tmp/x').strip(chr(34))}>) = 0",
            clone("1.000007", 12),
        ],
        11: [execve("1.000005", ["/bin/true"])],
        12: [execve("1.000008", ["/bin/false"])],
    })])
    cwd = {p.argv: p.cwd for p in evidence.lifetimes()}
    assert cwd[("/bin/true",)] == "/rush/workspace/sub"
    assert cwd[("/bin/false",)] == "/tmp/x"


def test_a_thread_joins_its_thread_group_and_only_the_leaders_exit_ends_the_process():
    evidence = parse_trace(C, [session({
        10: [execve("1.000001", ["python"]), clone("1.000002", 11, thread=True), "1.000009 +++ exited with 0 +++"],
        11: [execve("1.000003", ["/bin/true"]), "1.000004 +++ exited with 0 +++"],
    })])
    processes = evidence.lifetimes()
    assert len(processes) == 1, "a thread is not a process"
    root = processes[0]
    assert {e.thread_id for e in evidence.events} == {10, 11} and {e.thread_group_id for e in evidence.events} == {10}
    assert root.exit.time_ns == 1_000_009_000, "the leader's exit, not the thread's"


def test_resumed_calls_are_joined_and_an_unreadable_line_makes_evidence_incomplete():
    evidence = parse_trace(C, [session({
        10: [
            f"1.000001 execve({h('/bin/sh')}, [{h('sh')}], 0x1 /* 1 var */ <unfinished ...>",
            "1.000002 <... execve resumed>) = 0",
            "garbage",
        ],
    })])
    assert evidence.root().argv == ("sh",)
    assert not evidence.complete and evidence.loss_reasons == ("trace_malformed",) and evidence.malformed == 1


def test_a_tracer_that_did_not_end_normally_is_a_loss():
    evidence = parse_trace(C, [session({10: [execve("1.000001", ["sh"])]}, tracer_ok=False)])
    assert not evidence.complete and evidence.loss_reasons == ("tracer_lost",) and evidence.connections_lost == 1


def test_events_past_the_bound_are_dropped_and_overflow_is_a_loss():
    lines = [execve("1.000001", ["sh"])] + [f"2.{i:06d} chdir({h('/')}) = 0" for i in range(1)]
    lines += [clone(f"3.{i:06d}", 1000 + i) for i in range(MAX_EVENTS_PER_CONTAINER + 5)]
    evidence = parse_trace(C, [session({10: lines})])
    assert len(evidence.events) == MAX_EVENTS_PER_CONTAINER and evidence.dropped == 6
    assert "journal_overflow" in evidence.loss_reasons


def test_launch_markers_join_a_command_to_its_process_by_evidence():
    harness = session({10: [execve("1.000001", ["python", "/harness/main.py"])]})
    command = session({
        20: [execve("2.000001", ["timeout", "5", *launch_argv("abc", ["/bin/sh", "-c", "exit 5"])]), clone("2.000002", 21), "2.000009 +++ exited with 5 +++"],
        21: [execve("2.000003", launch_argv("abc", ["/bin/sh", "-c", "exit 5"])), execve("2.000004", ["/bin/sh", "-c", "exit 5"]), "2.000008 +++ exited with 5 +++"],
    }, exec_session=True)
    evidence = parse_trace(C, [harness, command])
    links = launched_processes(evidence)
    member = next(p for p in evidence.lifetimes() if p.identity in links)
    assert links[member.identity] == "abc" and member.argv == ("/bin/sh", "-c", "exit 5") and member.is_exec_session
    assert evidence.root().argv == ("python", "/harness/main.py"), "a command's root is no container start"
    assert launch_argv("x", ["a"]) == [LAUNCH_ENV, "-u", f"{LAUNCH_MARKER}x", "a"]


def test_a_launch_id_replayed_by_the_member_links_nothing():
    replay = launch_argv("abc", ["/bin/true"])
    evidence = parse_trace(C, [
        session({10: [execve("1.000001", ["python"]), clone("1.000002", 11)], 11: [execve("1.000003", replay)]}),
        session({20: [execve("2.000001", ["timeout", "5", *replay]), clone("2.000002", 21)], 21: [execve("2.000003", replay)]}, exec_session=True),
        session({30: [execve("3.000001", ["timeout", "5", *replay]), clone("3.000002", 31)], 31: [execve("3.000003", replay)]}, exec_session=True),
    ])
    assert launched_processes(evidence) == {}, "seen beneath two exec roots, and once in the harness: nothing links"
