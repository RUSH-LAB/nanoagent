"""Teardown: an SGLang engine holds its GPUs until its process is gone, so nothing may outlive
the launcher.

These use REAL child processes rather than fakes, because the thing under test is process
signalling — a stubbed ``terminate()`` would assert that nanoagent.inference called a method, not that the
child actually died. ``_TERM_GRACE_S`` is patched down so the escalation path costs a fraction of
a second instead of ten.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
import urllib.error

import pytest

from nanoagent.inference import SGLangServeConfig
from nanoagent.inference import router as router_mod

# A child that exits only when killed, and one that additionally refuses SIGTERM. Both announce
# themselves on stdout: the interpreter needs tens of milliseconds to get going, and a SIGTERM that
# lands before line 1 kills the stubborn one by default disposition — the escalation path would go
# untested while the test still passed.
_SLEEPER = "print('ready', flush=True); import time; time.sleep(60)"
_STUBBORN = (
    "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready', flush=True); time.sleep(60)"
)

# Bound at import: the bring-up tests monkeypatch subprocess.Popen (which router.py reads through
# the shared module object), and the spawn fixture must keep starting REAL children.
_POPEN = subprocess.Popen


@pytest.fixture
def spawn():
    """Starts throwaway children, waits until each is really running, and cleans up after the test."""
    started: list[subprocess.Popen[bytes]] = []

    def _spawn(code: str) -> subprocess.Popen[bytes]:
        p = _POPEN([sys.executable, "-c", code], stdout=subprocess.PIPE)
        started.append(p)
        assert p.stdout is not None
        assert p.stdout.readline().strip() == b"ready", "child never started"
        return p

    yield _spawn
    for p in started:
        if p.poll() is None:
            p.kill()
            p.wait()
        if p.stdout is not None:
            p.stdout.close()


@pytest.fixture(autouse=True)
def short_grace(monkeypatch) -> None:
    monkeypatch.setattr(router_mod, "_TERM_GRACE_S", 0.5)


def test_reap_terminates_every_live_child(spawn) -> None:
    procs = [spawn(_SLEEPER) for _ in range(3)]
    router_mod._reap(procs)
    assert all(p.poll() is not None for p in procs)


def test_reap_kills_a_child_that_ignores_sigterm(spawn) -> None:
    """The case that used to strand GPUs: terminate() alone leaves this process running."""
    p = spawn(_STUBBORN)
    router_mod._reap([p])
    assert p.poll() is not None


def test_reap_shares_one_grace_period_across_children(spawn) -> None:
    """Signal-all-then-wait, not terminate-and-wait per child: N stubborn engines still take ONE
    grace period to reap, not N. At the real 10s grace, per-child waits would mean a node full of
    engines takes minutes to release its GPUs."""
    procs = [spawn(_STUBBORN) for _ in range(3)]
    start = time.monotonic()
    router_mod._reap(procs)
    elapsed = time.monotonic() - start
    assert all(p.poll() is not None for p in procs)
    assert elapsed < 2 * router_mod._TERM_GRACE_S, f"reaping 3 children took {elapsed:.2f}s"


def test_reap_leaves_an_already_exited_child_alone(spawn) -> None:
    """A child that died on its own keeps its exit code — reaping must not overwrite it with the
    -SIGKILL of a signal sent to a dead pid."""
    p = spawn("print('ready', flush=True); raise SystemExit(3)")
    p.wait()
    router_mod._reap([p])
    assert p.returncode == 3


def test_reap_of_nothing_is_a_no_op() -> None:
    router_mod._reap([])


# ─── health gates ────────────────────────────────────────────────────────────────────────────
# Bring-up is ordered by these: engines are only registered once they answer, so a router never
# advertises a worker that is still loading weights.


def test_wait_tcp_returns_as_soon_as_something_listens() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        router_mod._wait_tcp("127.0.0.1", listener.getsockname()[1], timeout=5.0, interval=0.01)


def test_wait_tcp_names_the_address_it_gave_up_on() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        closed_port = probe.getsockname()[1]
    with pytest.raises(TimeoutError, match=f"127.0.0.1:{closed_port}"):
        router_mod._wait_tcp("127.0.0.1", closed_port, timeout=0.05, interval=0.01)


def test_wait_http_accepts_any_non_5xx(monkeypatch) -> None:
    """The gate is "the process is answering", not "this route exists" — a 404 from an engine
    without a /health route still means it is up."""
    monkeypatch.setattr(
        router_mod.urllib.request,
        "urlopen",
        lambda *_a, **_k: (_ for _ in ()).throw(urllib.error.HTTPError("u", 404, "nope", {}, None)),
    )
    router_mod._wait_http("http://h/health", timeout=5.0, interval=0.01)


def test_wait_http_keeps_polling_through_a_server_that_is_still_starting(monkeypatch) -> None:
    """A refused connection and a 5xx both mean "not ready yet"; weights take minutes to load, so
    neither may be treated as a terminal failure."""
    attempts: list[str] = []

    def urlopen(*_a, **_k):
        attempts.append("try")
        if len(attempts) < 3:
            raise OSError("connection refused")
        if len(attempts) == 3:
            raise urllib.error.HTTPError("u", 503, "starting", {}, None)
        return _NullCtx(status=200)

    monkeypatch.setattr(router_mod.urllib.request, "urlopen", urlopen)
    router_mod._wait_http("http://h/health", timeout=5.0, interval=0.001)
    assert len(attempts) == 4


def test_wait_http_eventually_gives_up(monkeypatch) -> None:
    monkeypatch.setattr(router_mod.urllib.request, "urlopen", lambda *_a, **_k: (_ for _ in ()).throw(OSError("refused")))
    with pytest.raises(TimeoutError, match="http://h/health"):
        router_mod._wait_http("http://h/health", timeout=0.05, interval=0.001)


# ─── port reservation and registration ───────────────────────────────────────────────────────


def test_free_port_prefers_its_candidate_and_never_hands_one_out_twice(free_port) -> None:
    """Fixed base+i ports race when several engines start at once — each engine's HTTP and nccl
    port is reserved from ONE `used` set so two engines can't be handed the same number."""
    used: set[int] = set()
    first = router_mod._free_port(free_port, used)
    second = router_mod._free_port(free_port, used)  # same preference, already taken
    assert first == free_port
    assert second != first and second in used


def test_free_port_skips_a_port_something_else_is_listening_on() -> None:
    """The `used` set is only half of it — the probe bind is what catches a port this process
    never reserved."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as taken:
        taken.bind(("", 0))
        taken.listen(1)
        occupied = taken.getsockname()[1]
        assert router_mod._free_port(occupied, set()) != occupied


def test_free_port_gives_up_rather_than_scanning_forever() -> None:
    exhausted = set(range(45000, 46000))
    with pytest.raises(RuntimeError, match="no free port"):
        router_mod._free_port(45000, exhausted)


def test_an_engine_registers_itself_to_the_router_as_a_regular_worker(monkeypatch) -> None:
    """slime's >0.2.1 path: engines are not passed to the router on its command line, they POST
    themselves in once they are actually serving."""
    posted: list[object] = []
    monkeypatch.setattr(router_mod.urllib.request, "urlopen", lambda req, **_k: posted.append(req) or _NullCtx())
    cfg = SGLangServeConfig(mode="router", num_gpus_per_node=2, gpus_per_engine=1, port=30000, worker_base_port=31000)
    router_mod._register(cfg, router_mod.worker_url(cfg, 1))
    (req,) = posted
    assert req.full_url == "http://127.0.0.1:30000/workers"
    assert req.method == "POST"
    assert json.loads(req.data) == {"url": "http://127.0.0.1:31001", "worker_type": "regular"}


class _NullCtx:
    """A context-manager stand-in for whatever ``urlopen`` returns."""

    def __init__(self, status: int = 200) -> None:
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> None:
        return None


def _router_cfg() -> SGLangServeConfig:
    return SGLangServeConfig(mode="router", model_path="org/m", num_gpus_per_node=2, gpus_per_engine=1)


@pytest.fixture
def fake_bringup(monkeypatch, spawn):
    """Stands run_router up against real children but no router, no HTTP, and no signal handlers.

    Returns the list of children it launched, so a test can assert on their fate.
    """
    monkeypatch.setitem(sys.modules, "sglang_router", object())
    launched: list[subprocess.Popen[bytes]] = []
    monkeypatch.setattr(router_mod.subprocess, "Popen", lambda *_a, **_k: launched.append(spawn(_SLEEPER)) or launched[-1])
    monkeypatch.setattr(router_mod, "_wait_tcp", lambda *_a, **_k: None)
    monkeypatch.setattr(router_mod.signal, "signal", lambda *_a, **_k: None)  # pytest owns the handlers
    return launched


def test_a_failed_bringup_does_not_strand_the_engines(monkeypatch, fake_bringup) -> None:
    """An engine that never passes its health check must not leave its siblings holding GPUs."""
    monkeypatch.setattr(router_mod, "_wait_http", lambda *_a, **_k: (_ for _ in ()).throw(TimeoutError("no health")))
    with pytest.raises(TimeoutError):
        router_mod.run_router(_router_cfg())
    assert fake_bringup, "the test never got as far as launching a child"
    assert all(p.poll() is not None for p in fake_bringup)


def test_a_dead_child_takes_the_whole_node_down(monkeypatch, fake_bringup) -> None:
    """Supervision is fail-loud: one engine exiting means the rest are reaped and the launcher
    exits non-zero, rather than a router quietly serving a shrunken pool."""
    monkeypatch.setattr(router_mod, "_wait_http", lambda *_a, **_k: None)
    monkeypatch.setattr(router_mod, "_register", lambda *_a, **_k: None)
    # The supervise loop polls, then sleeps: kill a child during the sleep and the next poll sees it.
    monkeypatch.setattr(router_mod.time, "sleep", lambda _s: fake_bringup[-1].kill() or fake_bringup[-1].wait())
    with pytest.raises(SystemExit) as exc:
        router_mod.run_router(_router_cfg())
    assert exc.value.code != 0
    assert all(p.poll() is not None for p in fake_bringup)


def test_a_missing_sglang_router_names_the_extra(monkeypatch) -> None:
    """The router topology is behind an optional extra, so its absence must read as an install
    instruction, not as a bare ImportError from three frames down."""
    monkeypatch.setitem(sys.modules, "sglang_router", None)  # `import x` with a None entry -> ImportError
    with pytest.raises(SystemExit, match=r"nanoagent\[serve\]"):
        router_mod.run_router(_router_cfg())
