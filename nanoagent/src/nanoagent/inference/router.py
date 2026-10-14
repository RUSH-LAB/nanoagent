"""Serve a model behind an ``sglang_router`` fronting multiple single-node SGLang engines.

This is the multi-engine launcher — slime's actual multi-node inference topology
(``slime/ray/rollout.py``) made self-contained, no Ray: a standalone ``sglang_router`` process
load-balances requests across N independent single-node ``sglang serve`` engines, and
each engine registers itself to the router (``POST /workers``, exactly like slime's
``SGLangEngine._register_to_router`` at ``sglang_engine.py:194-217``). Use it to fill one node
with several smaller engines (e.g. 4 x tp=2 on 8 GPUs) and/or to span nodes by running the same
config on each node.

This module is internal to :class:`nanoagent.inference.serve.SGLangServer`. It does NOT define its own
config schema — ONE :class:`~nanoagent.inference.serve.SGLangServeConfig` covers every topology, with
``mode: router`` (or ``multinode``) selecting this launcher.

Per node, engine ``i`` gets GPUs ``[i*gpus_per_engine, (i+1)*gpus_per_engine)`` via
``--base-gpu-id``, plus its own ``--port`` and ``--nccl-port``; only ``node_rank`` 0 starts the
router. Every engine (on every node) registers to the router at ``router_address``.

Requires the ``sglang-router`` package — the ``serve`` extra (``pip install 'nanoagent[serve]'``).
The import is deferred to :func:`run_router`, so command builders remain unit-testable without it
installed.
"""

from __future__ import annotations

import json
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any

from nanoagent.inference.serve import SGLangServeConfig, SGLangServer


def router_command(cfg: SGLangServeConfig) -> list[str]:
    """The ``sglang_router.launch_router`` argv (pure; assertable without launching)."""
    return [
        sys.executable,
        "-m",
        "sglang_router.launch_router",
        "--host",
        cfg.host,
        "--port",
        str(cfg.port),
        "--policy",
        cfg.policy,
    ]


def worker_command(
    cfg: SGLangServeConfig,
    i: int,
    *,
    port: int | None = None,
    nccl_port: int | None = None,
) -> list[str]:
    """The ``sglang serve`` argv for this node's engine ``i``.

    Each engine is a single-node :class:`SGLangServeConfig` (mode=single, nnodes=1, no cross-node
    TP); its GPU slice and ports are passed through as base-gpu-id / nccl-port / port. ``port`` /
    ``nccl_port`` default to ``worker_base_*+i``; :func:`run_router` overrides them with ports it
    has verified free (several servers launching at once otherwise race on the nccl port).
    """
    extra: dict[str, Any] = {
        **cfg.extra_args,
        "base-gpu-id": i * cfg.gpus_per_engine,
        "nccl-port": cfg.worker_base_nccl_port + i if nccl_port is None else nccl_port,
    }
    engine = SGLangServeConfig(
        mode="single",
        model_path=cfg.model_path,
        served_model_name=cfg.name,
        host=cfg.host,
        port=cfg.worker_base_port + i if port is None else port,
        gpus_per_engine=cfg.gpus_per_engine,
        num_gpus_per_node=cfg.gpus_per_engine,  # single-node engine -> nnodes=1
        max_running_requests=cfg.max_running_requests,
        context_length=cfg.context_length,
        extra_args=extra,
    )
    return SGLangServer(engine).command()


def worker_url(cfg: SGLangServeConfig, i: int, *, port: int | None = None) -> str:
    """The URL engine ``i`` registers to the router (router-reachable host + its port)."""
    p = cfg.worker_base_port + i if port is None else port
    return f"http://{cfg.resolved_worker_host}:{p}"


def _free_port(preferred: int, used: set[int]) -> int:
    """A currently-free TCP port, preferring ``preferred`` then scanning up, skipping ``used``.

    Binding multiple same-node engines on fixed base+i ports races on the torch-distributed
    (nccl) port; reserving a verified-free port per engine right before launch avoids it.
    """
    for cand in range(preferred, preferred + 1000):
        if cand in used:
            continue
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("", cand))
        except OSError:
            continue
        finally:
            s.close()
        used.add(cand)
        return cand
    raise RuntimeError(f"no free port found near {preferred}")


def _wait_tcp(host: str, port: int, timeout: float = 120.0, interval: float = 1.0) -> None:
    """Block until something accepts TCP on host:port (used for the router coming up)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(2)
            if s.connect_ex((host, port)) == 0:
                return
        time.sleep(interval)
    raise TimeoutError(f"router {host}:{port} did not come up within {timeout}s")


def _wait_http(url: str, timeout: float = 1800.0, interval: float = 2.0) -> None:
    """Block until ``url`` answers (any non-5xx); engines take minutes to load weights."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                if r.status < 500:
                    return
        except urllib.error.HTTPError as e:
            if e.code < 500:
                return
        except OSError:
            pass
        time.sleep(interval)
    raise TimeoutError(f"timed out waiting for {url}")


def _register(cfg: SGLangServeConfig, worker_url_str: str) -> None:
    """Register one engine with the router (``POST /workers``), like slime's >0.2.1 path."""
    addr = cfg.resolved_router_address
    body = json.dumps({"url": worker_url_str, "worker_type": "regular"}).encode()
    req = urllib.request.Request(
        f"http://{addr}/workers",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10):
        pass


# How long a terminated child gets to exit on its own before it is SIGKILLed. An SGLang engine
# holds GPU memory until its process is gone, so a child that ignores SIGTERM must not be allowed
# to outlive this launcher: on a scheduler that reclaims the container by killing only the top
# process, an orphaned engine keeps the GPUs occupied for the rest of the allocation.
_TERM_GRACE_S: float = 10.0


def _reap(procs: list[subprocess.Popen[bytes]]) -> None:
    """Terminate every live child, then escalate to SIGKILL for any that outlast the grace period.

    Signals all of them first and waits second, so the grace period is shared rather than paid
    once per child. Each ``wait`` is bounded, so this returns in at most ``_TERM_GRACE_S`` however
    many engines are running.
    """
    live = [p for p in procs if p.poll() is None]
    for p in live:
        p.terminate()
    deadline = time.monotonic() + _TERM_GRACE_S
    for p in live:
        try:
            p.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            print(f"child pid {p.pid} ignored SIGTERM; killing", flush=True)
            p.kill()
            p.wait()


def run_router(cfg: SGLangServeConfig) -> None:
    """Launch the router (node 0) + this node's engines, register them, then supervise.

    Blocks until killed or any child dies (then it tears the rest down). The caller
    (:meth:`SGLangServer.run`) has already ensured the weights are on disk; the ``sglang_router``
    import is deferred to here.
    """
    try:
        import sglang_router  # noqa: F401  (presence check — clear message if pruned)
    except ImportError as e:
        raise SystemExit(
            "sglang-router is not installed: `pip install 'nanoagent[serve]'` (its wheels come "
            "from docs.sglang.ai, so the install needs that index reachable)."
        ) from e

    procs: list[subprocess.Popen[bytes]] = []

    def shutdown(*_: object, code: int = 0) -> None:
        _reap(procs)
        sys.exit(code)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Everything past this point can leave GPU-holding children behind if it raises — an engine
    # that fails its health check, a registration POST that times out, a KeyboardInterrupt during
    # weight load. Reap on the way out so a failed bring-up never strands engines on the node.
    try:
        # Only node_rank 0 runs the router; other nodes just launch engines that register to it.
        if cfg.node_rank == 0:
            rc = router_command(cfg)
            print("launching router:", " ".join(rc), flush=True)
            procs.append(subprocess.Popen(rc))
            _wait_tcp("127.0.0.1", cfg.port)

        # Reserve a verified-free HTTP + nccl port per engine (fixed base+i races when several
        # engines launch at once — see _free_port).
        used: set[int] = set()
        ports = [_free_port(cfg.worker_base_port + i, used) for i in range(cfg.engines_per_node)]
        nccl_ports = [_free_port(cfg.worker_base_nccl_port + i, used) for i in range(cfg.engines_per_node)]

        for i in range(cfg.engines_per_node):
            wc = worker_command(cfg, i, port=ports[i], nccl_port=nccl_ports[i])
            print(f"launching engine {i}:", " ".join(wc), flush=True)
            procs.append(subprocess.Popen(wc))

        for i in range(cfg.engines_per_node):
            url = worker_url(cfg, i, port=ports[i])
            _wait_http(url + "/health")
            _register(cfg, url)
            print("registered", url, flush=True)

        print(
            f"router serving {cfg.name} at {cfg.base_url} over {cfg.engines_per_node} "
            f"engine(s) on node {cfg.node_rank}",
            flush=True,
        )

        # Supervise: if the router or any engine dies, take the whole node down (fail loud).
        while True:
            for p in procs:
                if p.poll() is not None:
                    print(f"child pid {p.pid} exited (code {p.returncode}); shutting down", flush=True)
                    shutdown(code=p.returncode or 1)
            time.sleep(5)
    except BaseException:
        # BaseException, not Exception: SystemExit (from shutdown()) and KeyboardInterrupt both
        # land here, and both must still reap. _reap only signals children that are still live,
        # so the shutdown() path reaping first and this reaping again is a no-op, not a double-kill.
        _reap(procs)
        raise
