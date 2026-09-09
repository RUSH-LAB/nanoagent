"""Serve a model with SGLang — the launch side of nanoagent.inference.

The rest of the package is the *client* side (``BatchedInference`` → an OpenAI-compatible
endpoint); this module is the *launch* side: it starts that endpoint by running
``sglang serve`` from a typed, yaml-driven config, so callers never hand-assemble the
command line.

  >>> from nanoagent.inference import SGLangServer, SGLangServeConfig
  >>> SGLangServer.from_yaml("serve.yaml").run()   # blocks; becomes the server

The two sides compose: an :class:`SGLangServeConfig`'s :attr:`~SGLangServeConfig.base_url`
is exactly the endpoint a client :class:`~nanoagent.inference.config.LeanInferConfig` points at, and
its ``served_model_name`` is the client's ``model``.

ONE schema, ONE server class. The yaml's ``mode`` key selects the topology — every topology
shares the same fields (with a few mode-specific extras silently ignored where they don't apply):

  * ``single`` (default) — one SGLang engine in this process; ``gpus_per_engine`` GPUs of TP, and
    for ``nnodes > 1`` it spans nodes SGLang-natively via ``dist_init_addr``.
  * ``router`` — an ``sglang_router`` (started on this process) fronting
    ``num_gpus_per_node // gpus_per_engine`` single-node engines. For a manual multi-node cluster
    set ``node_rank`` / ``router_address`` yourself.
  * ``multinode`` — the same router topology with AUTOMATIC cross-node rendezvous: ``node_rank``
    and peer IPs are discovered from the scheduler's per-node env (``TW_TASK_ID`` / ...) plus a
    shared rendezvous dir (``RDZV_DIR``), so a whole-node launch that runs
    the same command on every node needs only this one ``--config``.

Run as a module entry point::

    python3 -m nanoagent.inference.serve --config configs/gemma_4_31b_serve.yaml

Parallelism mirrors slime's ``_compute_server_args``: ``gpus_per_engine`` is the per-engine TP
width (slime ``sglang_engine.py:559-583``), ``tp_size = gpus_per_engine // pp_size``. ``nnodes`` is
EXPLICIT (default 1); for a single-engine cross-node TP, set it to
``gpus_per_engine // num_gpus_per_node`` and the engine fans across that many nodes. Only
``node_rank`` 0 serves the HTTP endpoint in any cross-node topology.
"""

from __future__ import annotations

import argparse
import glob
import logging
import os
import socket
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, cast

from omegaconf import DictConfig, OmegaConf

from nanoagent.inference.config import _at_least, load_yaml

logger: logging.Logger = logging.getLogger(__name__)

# A model load needs real weight shards; configs + tokenizer alone make SGLang fail with
# "Cannot find any model weights". So we check for these globs specifically, not merely
# that a HF snapshot folder exists (a repo can be cached configs-only).
_WEIGHT_GLOBS = ("*.safetensors", "*.bin")

_VALID_MODES = ("single", "router", "multinode")


def _port_in_range(name: str, port: int) -> None:
    """Raise :class:`ValueError` unless ``port`` is a usable TCP port (1..65535)."""
    if not 1 <= port <= 65535:
        raise ValueError(f"{name} must be in 1..65535, got {port}")


def _dir_has_weights(path: str) -> bool:
    """True if ``path`` directly contains at least one weight shard."""
    return any(glob.glob(os.path.join(path, g)) for g in _WEIGHT_GLOBS)


def ensure_weights(model_path: str) -> str:
    """Make sure ``model_path``'s weights are on disk, downloading them if not. Returns the local dir.

    ``model_path`` is either a local directory or a HuggingFace repo id. A repo can be
    *partially* cached — configs + tokenizer but no weight shards (exactly what makes
    SGLang report "Cannot find any model weights") — so we look for weight files, not
    just for a cached snapshot folder.

    A bare local directory can only be checked, not fetched; a missing repo is downloaded.

    huggingface_hub is imported here rather than at module scope: it is a launch-side
    dependency (the ``serve`` extra), so a client-only install can import this module.
    """
    try:
        from huggingface_hub import snapshot_download
        from huggingface_hub.errors import LocalEntryNotFoundError
    except ImportError as e:  # client-only install — name the extra instead of a bare ImportError
        raise ImportError("fetching weights needs huggingface_hub: pip install 'nanoagent[serve]'") from e

    # A local directory is handed to SGLang as-is — we can verify but not download it.
    if os.path.isdir(model_path):
        if not _dir_has_weights(model_path):
            raise FileNotFoundError(
                f"local model dir {model_path!r} has no weight files "
                f"({' / '.join(_WEIGHT_GLOBS)})"
            )
        return model_path

    # HF repo id: check the local cache first, without touching the network.
    try:
        cached = snapshot_download(model_path, local_files_only=True)
        if _dir_has_weights(cached):
            return cached
    except LocalEntryNotFoundError:
        pass  # nothing cached for this repo → fall through and download

    # Weights missing. An offline sandbox commonly exports HF_HUB_OFFLINE=1, which
    # huggingface_hub latches into a module global at import (is_offline_mode() reads it once);
    # flip it off here so the fetch can actually reach the Hub.
    import huggingface_hub.constants as hf_constants

    hf_constants.HF_HUB_OFFLINE = False
    os.environ["HF_HUB_OFFLINE"] = "0"

    print(f"weights for {model_path!r} not found in cache — downloading...", flush=True)
    path = snapshot_download(model_path)
    print(f"downloaded to: {path}", flush=True)
    return path


# Per-node index env vars a whole-node scheduler exposes (e.g. TW_TASK_ID); the rest are
# torchrun/accelerate fallbacks. Used by the multinode rendezvous to learn this node's rank.
_RANK_ENV = ("TW_TASK_ID", "GROUP_RANK", "NODE_RANK", "RANK", "LOCAL_RANK")


def _local_ip() -> str:
    """Best-effort reachable IP of this node (for the URLs engines advertise to the router)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no packet is sent; this just picks the outbound interface
        return s.getsockname()[0]
    except OSError:
        return socket.gethostbyname(socket.gethostname())
    finally:
        s.close()


@dataclass
class SGLangServeConfig:
    """ONE config for SGLang serving across every topology — ``mode`` selects which.

    Fields are shared across modes except the explicitly mode-tagged ones (silently ignored
    where they don't apply, so a yaml can be flipped between modes by changing one line).
    """

    # ── topology ──
    mode: str = "single"  # single | router | multinode

    # ── model + endpoint ──
    # HuggingFace id or local dir handed to --model-path.
    model_path: str = "google/gemma-4-31B-it"
    # Name clients address the model by (--served-model-name); defaults to model_path via .name.
    served_model_name: str | None = None
    # 0.0.0.0 binds all interfaces; base_url rewrites it to 127.0.0.1 for local clients.
    host: str = "127.0.0.1"
    port: int = 30000

    # ── parallelism (all modes) ──
    # Per-engine TP width (slime ``_compute_server_args`` / sglang_engine.py:559-583): single mode
    # uses this as the whole engine's TP; router/multinode launches num_gpus_per_node //
    # gpus_per_engine engines per node, each tp=gpus_per_engine. tp_size = gpus_per_engine // pp_size.
    gpus_per_engine: int = 1
    num_gpus_per_node: int = 1
    # Pipeline / data / expert parallel = slime's sglang_pp_size / sglang_dp_size / sglang_ep_size.
    # dp and ep are intra-engine (e.g. dp-attention), not extra nodes — they share the engine's GPUs.
    # Single-mode only (router engines stay single-node tp=gpus_per_engine).
    pp_size: int = 1
    dp_size: int = 1
    ep_size: int = 1

    # ── multinode rendezvous (all modes; single uses SGLang-native TP, router/multinode use rendezvous) ──
    # Explicit (default 1). For a single-engine cross-node TP set to gpus_per_engine //
    # num_gpus_per_node; for router/multinode set to the cluster's node count.
    nnodes: int = 1
    node_rank: int = 0
    # Single mode cross-node TP (nnodes > 1): rank 0's reachable HOST:PORT that all nodes dial.
    dist_init_addr: str | None = None

    # ── per-engine SGLang admission caps (applied to single AND every router/multinode engine) ──
    # SGLang's --max-running-requests (max concurrent decode requests the server admits) and
    # --context-length (max prompt+completion tokens per request). Promoted to first-class fields
    # because they are the SINGLE SOURCE OF TRUTH for two client-side knobs as well: a batch
    # driver's fan-out concurrency and an agent loop's context-window hard-stop. Keeping them
    # here means "what the server is willing to do" and "what the client asks for" can never
    # drift. ``None`` leaves SGLang's own default in place and is not propagated to the client
    # (a launcher reading these should then refuse to derive concurrency / context_window
    # rather than guess).
    max_running_requests: int | None = None
    context_length: int | None = None

    # ── router/multinode only (silently ignored when mode: single) ──
    # Router routing policy (round_robin | cache_aware | ...). cache_aware sends same-prefix
    # requests to the same engine, so per-engine prefix caches actually get reused.
    policy: str = "cache_aware"
    # Router HOST:PORT engines register to (multinode/router cross-node). Required when
    # mode != single and nnodes > 1; for multinode the rendezvous fills it. Single-node defaults
    # to 127.0.0.1:port.
    router_address: str | None = None
    # Host the router uses to reach THIS node's engines (the host in each registered URL).
    # Defaults to 127.0.0.1 single-node, else this node's detected IP.
    worker_host: str | None = None
    # First engine's HTTP port / nccl port; engine i uses base + i (must not collide on a node).
    worker_base_port: int = 31000
    worker_base_nccl_port: int = 41000

    # Any other launch_server flag, passed verbatim as --<key> <value>. A True value emits a
    # bare flag (store_true, e.g. {disable-radix-cache: true}); None/False is dropped. This is
    # the escape hatch for --tool-call-parser, --reasoning-parser, --mem-fraction-static, etc.,
    # so adding a flag never needs a schema change. Applied to single AND every router engine.
    # WARNING: do NOT set `disable-radix-cache: true` when serving an agent loop. Such a loop is
    # stateless — every step re-sends the full growing message history over
    # /v1/chat/completions, and relies on SGLang's RadixAttention prefix cache (on by default) to
    # reuse the KV of the unchanged prefix so each step only prefills the newly appended tokens.
    # There is no session API in play; the radix cache IS the prefix reuse. Disabling it
    # re-prefills the whole history every step (and kills cross-question sharing of the common
    # system prompt) — a big throughput loss.
    extra_args: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Fail fast on out-of-range knobs, so a typo surfaces at config time, not on launch."""
        if self.mode not in _VALID_MODES:
            raise ValueError(f"mode must be one of {_VALID_MODES}, got {self.mode!r}")
        _port_in_range("port", self.port)
        _at_least("gpus_per_engine", self.gpus_per_engine, 1)
        _at_least("num_gpus_per_node", self.num_gpus_per_node, 1)
        _at_least("pp_size", self.pp_size, 1)
        _at_least("dp_size", self.dp_size, 1)
        _at_least("ep_size", self.ep_size, 1)
        # None on either cap leaves SGLang's own default in place, so _at_least skips it.
        _at_least("max_running_requests", self.max_running_requests, 1)
        _at_least("context_length", self.context_length, 1)
        if self.gpus_per_engine % self.pp_size != 0:
            raise ValueError(
                f"gpus_per_engine ({self.gpus_per_engine}) must be divisible by pp_size ({self.pp_size})"
            )
        _at_least("nnodes", self.nnodes, 1)
        if not 0 <= self.node_rank < self.nnodes:
            raise ValueError(f"node_rank must be in 0..{self.nnodes - 1}, got {self.node_rank}")
        # Mode-specific:
        if self.mode == "single":
            # An engine larger than a node must tile whole nodes — slime's integer nnodes formula
            # (gpus_per_engine // gpus_per_node) silently truncates otherwise.
            if (
                self.gpus_per_engine > self.num_gpus_per_node
                and self.gpus_per_engine % self.num_gpus_per_node != 0
            ):
                raise ValueError(
                    f"gpus_per_engine ({self.gpus_per_engine}) must be a multiple of "
                    f"num_gpus_per_node ({self.num_gpus_per_node}) when it spans nodes"
                )
            if self.nnodes > 1 and not self.dist_init_addr:
                raise ValueError("dist_init_addr (rank 0 HOST:PORT) is required when nnodes > 1 in single mode")
        else:
            # router / multinode: this node packs num_gpus_per_node // gpus_per_engine engines, so
            # the per-node GPU count must divide evenly.
            if self.num_gpus_per_node % self.gpus_per_engine != 0:
                raise ValueError(
                    f"num_gpus_per_node ({self.num_gpus_per_node}) must be divisible by "
                    f"gpus_per_engine ({self.gpus_per_engine}) in mode {self.mode!r}"
                )
            _port_in_range("worker_base_port", self.worker_base_port)
            _port_in_range("worker_base_nccl_port", self.worker_base_nccl_port)
            # router mode with > 1 node needs an explicit router_address (multinode fills it at rendezvous).
            if self.mode == "router" and self.nnodes > 1 and not self.router_address:
                raise ValueError("router_address (router HOST:PORT) is required when nnodes > 1 in router mode")

    @property
    def tp_size(self) -> int:
        """Tensor-parallel degree per engine — gpus_per_engine // pp_size (slime parity)."""
        return self.gpus_per_engine // self.pp_size

    @property
    def name(self) -> str:
        """The served model name clients use — ``served_model_name`` or, if unset, ``model_path``."""
        return self.served_model_name or self.model_path

    @property
    def base_url(self) -> str:
        """The OpenAI-compatible ``/v1`` endpoint a client config should point ``base_url`` at.

        A 0.0.0.0 bind (all interfaces) is rewritten to 127.0.0.1, which is what a local
        client actually connects to.
        """
        host = "127.0.0.1" if self.host == "0.0.0.0" else self.host
        return f"http://{host}:{self.port}/v1"

    @property
    def engines_per_node(self) -> int:
        """Engines this node launches in router/multinode mode — num_gpus_per_node // gpus_per_engine."""
        return self.num_gpus_per_node // self.gpus_per_engine

    @property
    def resolved_worker_host(self) -> str:
        """Host used in engine registration URLs: explicit override, else localhost / node IP."""
        if self.worker_host:
            return self.worker_host
        return "127.0.0.1" if self.nnodes == 1 else _local_ip()

    @property
    def resolved_router_address(self) -> str:
        """Router HOST:PORT engines register to — explicit override, else single-node localhost."""
        return self.router_address or f"127.0.0.1:{self.port}"


def _extra_flags(extra: dict[str, Any]) -> list[str]:
    """Turn the ``extra_args`` mapping into ``--key value`` tokens (True → bare flag, None/False dropped)."""
    tokens: list[str] = []
    for key, value in extra.items():
        if value is None or value is False:
            continue
        tokens.append(f"--{key}")
        if value is not True:
            tokens.append(str(value))
    return tokens


# The top-level key that scopes the serve spec inside a UNIFIED yaml — one file that also carries
# blocks this schema doesn't own (a client `model:`, an `agent:`, whatever the consuming project
# has). Writing that block is what buys the right to put foreign keys next to the serve spec.
_SERVE_KEY = "serve"

# The ONLY foreign top-level key a flat yaml may carry. nanoagent.inference owns it: it is the launch
# dispatcher's block (nanoagent.inference.launch.launch_from_yaml reads `launch.target`), and the same file
# is deliberately loaded by both sides, so the serve side has to skip past it.
#
# Nothing else is exempt. An earlier version also skipped `model`/`agent`/`tools`/`batch`/
# `benchmark`/`defaults`: `defaults` is already consumed by slimconfig's composition and never
# reaches here, and the rest were one downstream project's vocabulary — which both coupled this
# library to that project's config names AND silently swallowed any serve-field typo that happened
# to match one. A yaml that really does carry foreign blocks uses `serve:` instead.
_LAUNCH_KEY = "launch"


def _from_conf_dict[T](conf: Any, schema: type[T]) -> T:
    """Merge ``conf`` onto the structured ``schema`` and return the instantiated dataclass.

    Two accepted layouts, both struct-mode strict — an undeclared key raises either way, so a
    typo like ``model_pth:`` is always an error rather than a silently defaulted field:

      * **Flat** (the common case) — the whole mapping is the serve spec, except the ``launch:``
        block nanoagent.inference itself owns (see :data:`_LAUNCH_KEY`).
      * **Scoped** — the mapping has a top-level ``serve:`` block and only that block is the serve
        spec. Sibling blocks are ignored by construction, so this is how one file carries both a
        serve spec and a consumer's own config without this loader needing to know their names.
    """
    mapping = cast(DictConfig, OmegaConf.create(conf))
    if _SERVE_KEY in mapping:
        scoped = mapping.get(_SERVE_KEY)
        if not isinstance(scoped, DictConfig):
            raise ValueError(f'the "{_SERVE_KEY}" block must be a mapping, got {type(scoped).__name__}')
        overrides = scoped
    else:
        overrides = mapping.copy()
        overrides.pop(_LAUNCH_KEY, None)
    merged = OmegaConf.merge(OmegaConf.structured(schema), overrides)
    return cast(T, OmegaConf.to_object(merged))


class SGLangServer:
    """Launches SGLang serving from one :class:`SGLangServeConfig`.

    ``run()`` dispatches on ``config.mode``: ``single`` execs one ``sglang serve``;
    ``router`` / ``multinode`` delegate to :mod:`nanoagent.inference.router` to bring up an ``sglang_router``
    and N single-node engines.
    """

    def __init__(self, config: SGLangServeConfig) -> None:
        self.config = config

    @classmethod
    def from_yaml(cls, path: str) -> SGLangServer:
        """Build a server from a yaml file (relative paths resolve against the project root)."""
        return cls.from_conf(load_yaml(path))

    @classmethod
    def from_conf(cls, conf: Any) -> SGLangServer:
        """Build from an already-loaded OmegaConf/dict, ignoring the launch-side ``launch`` key (see :func:`_from_conf_dict`)."""
        return cls(_from_conf_dict(conf, SGLangServeConfig))

    def command(self) -> list[str]:
        """The full single-engine ``sglang serve ...`` argv this server would exec (mode=single).

        Pure and side-effect-free, so it can be asserted in tests without launching a GPU. For
        mode=router/multinode the per-engine command is built by :mod:`nanoagent.inference.router`.
        """
        cfg = self.config
        cmd = [
            "sglang",
            "serve",
            "--model-path",
            cfg.model_path,
            "--served-model-name",
            cfg.name,
            "--host",
            cfg.host,
            "--port",
            str(cfg.port),
            "--tp-size",
            str(cfg.tp_size),  # derived: gpus_per_engine // pp_size
        ]
        # Emit pp/dp/ep only when non-trivial (each maps to slime's sglang_*_size).
        if cfg.pp_size > 1:
            cmd += ["--pp-size", str(cfg.pp_size)]
        if cfg.dp_size > 1:
            cmd += ["--dp-size", str(cfg.dp_size)]
        if cfg.ep_size > 1:
            cmd += ["--ep-size", str(cfg.ep_size)]
        # Single node (nnodes == 1): omit distributed flags. Multi-node: every node carries nnodes
        # + dist-init-addr and its own rank (dist_init_addr validated non-None in __post_init__).
        if cfg.nnodes > 1:
            cmd += [
                "--nnodes",
                str(cfg.nnodes),
                "--node-rank",
                str(cfg.node_rank),
                "--dist-init-addr",
                cast(str, cfg.dist_init_addr),
            ]
        if cfg.max_running_requests is not None:
            cmd += ["--max-running-requests", str(cfg.max_running_requests)]
        if cfg.context_length is not None:
            cmd += ["--context-length", str(cfg.context_length)]
        cmd += _extra_flags(cfg.extra_args)
        return cmd

    def run(self) -> None:
        """Bring up the topology selected by ``config.mode``. Blocks until killed (or the server's
        child dies, in router/multinode mode).

        single  -> exec ``sglang serve`` in this process (signals / exit code pass through).
        router  -> :func:`nanoagent.inference.router.run_router` (this process supervises router + engines).
        multinode -> resolve rendezvous from the scheduler's env + RDZV_DIR, then run_router.
        """
        cfg = self.config
        ensure_weights(cfg.model_path)
        if cfg.mode == "single":
            cmd = self.command()
            print("launching:", " ".join(cmd), flush=True)
            os.execvp(cmd[0], cmd)
        elif cfg.mode == "router":
            from nanoagent.inference.router import run_router  # lazy: router imports serve (avoid a cycle)

            run_router(cfg)
        elif cfg.mode == "multinode":
            _serve_multinode(cfg)
        else:  # pragma: no cover  (mode is validated in __post_init__)
            raise SystemExit(f"unknown serve mode {cfg.mode!r}; expected one of {_VALID_MODES}")


# ─── multinode rendezvous (mode: multinode) ──────────────────────────────────────────────────
# A whole-node scheduler runs the SAME command on every node and exposes
# only a per-node index env var — no master address, no peer list. These helpers turn that into
# the {node_rank, router_address, nnodes} that the router needs, via a shared-filesystem barrier,
# so the launcher stays a thin "run this one --config on N nodes" wrapper.


def _first_env(*names: str, default: str) -> str:
    """First of ``names`` that is set (and non-empty) in the environment, else ``default``."""
    for n in names:
        v = os.environ.get(n)
        if v is not None and v != "":
            return v
    return default


def _rendezvous(rdzv_dir: str, node_rank: int, nnodes: int, timeout: float = 600.0) -> dict[int, str]:
    """Publish this node's IP and block until all ``nnodes`` IPs are present. Returns {rank: ip}."""
    d = Path(rdzv_dir)
    d.mkdir(parents=True, exist_ok=True)
    ip = _local_ip()
    tmp = d / f".node{node_rank}.{os.getpid()}.tmp"
    tmp.write_text(ip + "\n")
    os.replace(tmp, d / f"node{node_rank}")  # atomic publish

    deadline = time.monotonic() + timeout
    while True:
        peers = {}
        for r in range(nnodes):
            f = d / f"node{r}"
            if f.exists():
                c = f.read_text().strip()
                if c:
                    peers[r] = c
        if len(peers) == nnodes:
            return peers
        if time.monotonic() >= deadline:
            raise TimeoutError(f"rendezvous incomplete after {timeout}s: have {peers}, need {nnodes}")
        time.sleep(2.0)


def _extend_no_proxy(ips: list[str]) -> None:
    """Add ips (+ loopback) to no_proxy so intra-cluster urllib bypasses the egress/corporate proxy."""
    extra = ["127.0.0.1", "localhost", *ips]
    for key in ("no_proxy", "NO_PROXY"):
        cur = [p for p in os.environ.get(key, "").split(",") if p]
        os.environ[key] = ",".join(dict.fromkeys(cur + extra))


def _serve_multinode(cfg: SGLangServeConfig) -> None:
    """Run the router topology with scheduler-driven rendezvous (mode: multinode).

    ``nnodes`` comes from the ``NNODES`` env, ``node_rank`` from the scheduler's per-node index
    (``TW_TASK_ID`` / fallbacks); for nnodes > 1 the peers' IPs are discovered through a shared
    ``RDZV_DIR`` and ``router_address`` is set to node 0's. These are launch context (how the job
    is placed), not model config, so they come from the env the launcher injects — the only CLI
    flag remains ``--config``. The model/topology fields come from the yaml.
    """
    from nanoagent.inference.router import run_router  # lazy: router imports serve (avoid a cycle)

    nnodes = int(_first_env("NNODES", default="1"))
    node_rank = int(_first_env(*_RANK_ENV, default="0"))
    # nnodes/node_rank live on the config; rebuild via dataclasses.replace so __post_init__ re-checks.
    cfg = replace(cfg, nnodes=nnodes, node_rank=node_rank)
    print(
        f"[serve:multinode] host={socket.gethostname()} node_rank={node_rank} nnodes={nnodes} "
        + " ".join(f"{k}={os.environ.get(k)}" for k in _RANK_ENV),
        flush=True,
    )
    if nnodes > 1:
        rdzv_dir = os.environ.get("RDZV_DIR")
        if not rdzv_dir:
            raise SystemExit("mode multinode with nnodes > 1 requires RDZV_DIR (a shared-FS rendezvous dir)")
        peers = _rendezvous(rdzv_dir, node_rank, nnodes)
        cfg = replace(cfg, router_address=f"{peers[0]}:{cfg.port}")
        _extend_no_proxy(list(peers.values()))
        print(
            f"[serve:multinode] rendezvous complete peers={peers} router_address={cfg.router_address}",
            flush=True,
        )
    run_router(cfg)


def serve_from_yaml(config_path: str) -> None:
    """Load a serving yaml and launch the topology its ``mode`` key selects (via :class:`SGLangServer`)."""
    SGLangServer.from_yaml(config_path).run()


def main() -> None:
    """Module entry point: ``python -m nanoagent.inference.serve --config <yaml>`` (mode selects topology)."""
    parser = argparse.ArgumentParser(description="Serve a model with SGLang for nanoagent.inference.")
    parser.add_argument(
        "--config",
        required=True,
        help="serving yaml; its `mode` key selects single | router | multinode",
    )
    ns = parser.parse_args()
    serve_from_yaml(ns.config)


if __name__ == "__main__":
    main()
