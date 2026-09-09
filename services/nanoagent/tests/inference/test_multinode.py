"""mode=multinode: turning a scheduler's per-node env into {node_rank, nnodes, router_address}.

A whole-node scheduler runs the SAME `--config` on every node and hands each one only an index —
no master address, no peer list. Everything here is that translation, plus the weight check that
runs before any topology starts. No GPU and no scheduler required: the rendezvous is a
shared-filesystem barrier, so tmp_path stands in for the shared FS and threads for the peers.
"""

from __future__ import annotations

import os
import sys
import threading
import types

import pytest

from nanoagent.inference import SGLangServeConfig
from nanoagent.inference import serve as serve_mod


@pytest.fixture(autouse=True)
def clean_env(monkeypatch) -> None:
    """No scheduler here — make sure a stray var in the dev shell can't decide a test's rank."""
    for name in (*serve_mod._RANK_ENV, "NNODES", "RDZV_DIR", "no_proxy", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)


# ─── env → rank ──────────────────────────────────────────────────────────────────────────────


def test_the_scheduler_index_wins_over_the_torchrun_fallbacks(monkeypatch) -> None:
    """_RANK_ENV is ordered: TW_TASK_ID is the whole-node scheduler's own index, and the torchrun
    names are only fallbacks — a torchrun-flavoured RANK left in the env must not override it."""
    monkeypatch.setenv("TW_TASK_ID", "2")
    monkeypatch.setenv("RANK", "0")
    assert serve_mod._first_env(*serve_mod._RANK_ENV, default="9") == "2"


def test_an_empty_var_counts_as_unset() -> None:
    """Schedulers export a var as "" when they have nothing to put in it; that must fall through
    to the next candidate rather than crash int()."""
    os.environ["TW_TASK_ID"] = ""
    try:
        assert serve_mod._first_env("TW_TASK_ID", "GROUP_RANK", default="7") == "7"
    finally:
        del os.environ["TW_TASK_ID"]


# ─── rendezvous ──────────────────────────────────────────────────────────────────────────────


def test_rendezvous_returns_every_peers_ip(tmp_path, monkeypatch) -> None:
    """Each node publishes its own IP and blocks until all N are present — nobody proceeds with a
    partial peer map, because node 0's IP IS the router address the others dial."""
    monkeypatch.setattr(serve_mod, "_local_ip", lambda: "10.0.0.1")
    (tmp_path / "node1").write_text("10.0.0.2\n")
    peers = serve_mod._rendezvous(str(tmp_path), node_rank=0, nnodes=2, timeout=5.0)
    assert peers == {0: "10.0.0.1", 1: "10.0.0.2"}


def test_rendezvous_publishes_atomically(tmp_path, monkeypatch) -> None:
    """A peer reading a half-written file would parse a truncated IP, so the write goes to a tmp
    name and is renamed into place; only the final name is ever visible."""
    monkeypatch.setattr(serve_mod, "_local_ip", lambda: "10.0.0.5")
    (tmp_path / "node0").write_text("10.0.0.4\n")
    serve_mod._rendezvous(str(tmp_path), node_rank=1, nnodes=2, timeout=5.0)
    assert (tmp_path / "node1").read_text().strip() == "10.0.0.5"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["node0", "node1"]  # no .tmp left behind


def test_every_node_agrees_on_the_peer_map(tmp_path, monkeypatch) -> None:
    """The real shape: N nodes run this concurrently against a shared FS and every one of them
    must come out with the SAME map, or they disagree about who the router is."""
    monkeypatch.setattr(serve_mod, "_local_ip", lambda: f"10.0.0.{threading.current_thread().name}")
    monkeypatch.setattr(serve_mod.time, "sleep", lambda _s: None)  # poll flat out
    results: dict[int, dict[int, str]] = {}

    def node(rank: int) -> None:
        results[rank] = serve_mod._rendezvous(str(tmp_path), node_rank=rank, nnodes=3, timeout=10.0)

    threads = [threading.Thread(target=node, args=(r,), name=str(r)) for r in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)
    expected = {0: "10.0.0.0", 1: "10.0.0.1", 2: "10.0.0.2"}
    assert results == {0: expected, 1: expected, 2: expected}


def test_a_peer_that_never_shows_up_times_out(tmp_path, monkeypatch) -> None:
    """Fail loud with the partial map: hanging forever on a node the scheduler never placed would
    hold the whole allocation."""
    monkeypatch.setattr(serve_mod, "_local_ip", lambda: "10.0.0.1")
    monkeypatch.setattr(serve_mod.time, "sleep", lambda _s: None)
    with pytest.raises(TimeoutError, match="rendezvous incomplete"):
        serve_mod._rendezvous(str(tmp_path), node_rank=0, nnodes=2, timeout=0.05)


# ─── no_proxy ────────────────────────────────────────────────────────────────────────────────


def test_peer_ips_are_added_to_no_proxy_without_dropping_what_was_there(monkeypatch) -> None:
    """Engine registration is a plain urllib POST to a peer; behind a corporate egress proxy that
    request leaves the cluster and never arrives unless the peer is exempted."""
    monkeypatch.setenv("no_proxy", "example.com")
    serve_mod._extend_no_proxy(["10.0.0.1", "10.0.0.2"])
    assert os.environ["no_proxy"].split(",") == ["example.com", "127.0.0.1", "localhost", "10.0.0.1", "10.0.0.2"]
    assert os.environ["NO_PROXY"].endswith("10.0.0.2")  # both spellings; urllib reads either


def test_extending_no_proxy_twice_does_not_duplicate_entries(monkeypatch) -> None:
    serve_mod._extend_no_proxy(["10.0.0.1"])
    serve_mod._extend_no_proxy(["10.0.0.1"])
    assert os.environ["no_proxy"].split(",").count("10.0.0.1") == 1


# ─── the dispatch itself ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def ran(monkeypatch) -> list[SGLangServeConfig]:
    """Captures the config handed to run_router instead of launching anything."""
    seen: list[SGLangServeConfig] = []
    monkeypatch.setitem(sys.modules, "nanoagent.inference.router", types.SimpleNamespace(run_router=seen.append))
    return seen


def _cfg(**kw) -> SGLangServeConfig:
    return SGLangServeConfig(mode="multinode", model_path="org/m", num_gpus_per_node=2, gpus_per_engine=1, **kw)


def test_a_single_node_placement_needs_no_rendezvous(monkeypatch, ran) -> None:
    """NNODES=1 is the common case (and what a local test run looks like); it must not demand a
    shared-FS dir it has no peers to meet in."""
    monkeypatch.setenv("TW_TASK_ID", "0")
    serve_mod._serve_multinode(_cfg())
    assert (ran[0].nnodes, ran[0].node_rank) == (1, 0)


def test_the_env_overrides_the_yamls_placement(monkeypatch, ran) -> None:
    """nnodes/node_rank are launch context, not model config: the yaml is identical on every node
    and the scheduler's env is what differs."""
    monkeypatch.setenv("NNODES", "2")
    monkeypatch.setenv("TW_TASK_ID", "1")
    monkeypatch.setenv("RDZV_DIR", "/unused")
    monkeypatch.setattr(serve_mod, "_rendezvous", lambda *_a, **_k: {0: "10.0.0.1", 1: "10.0.0.2"})
    serve_mod._serve_multinode(_cfg())
    assert (ran[0].nnodes, ran[0].node_rank) == (2, 1)
    assert ran[0].router_address == f"10.0.0.1:{ran[0].port}"  # node 0 hosts the router


def test_a_rank_outside_the_placement_is_refused(monkeypatch, ran) -> None:
    """The env is the untrusted input here: a stale index (or the wrong var picked up) would
    otherwise publish node5 into a 2-node rendezvous that nobody ever reads."""
    monkeypatch.setenv("NNODES", "2")
    monkeypatch.setenv("TW_TASK_ID", "5")
    monkeypatch.setenv("RDZV_DIR", "/unused")
    with pytest.raises(ValueError, match="node_rank"):
        serve_mod._serve_multinode(_cfg())
    assert ran == []


def test_a_multinode_placement_without_a_shared_dir_is_refused(monkeypatch, ran) -> None:
    """Without RDZV_DIR the nodes have no way to find each other; failing here beats every node
    coming up as its own rank-0 island."""
    monkeypatch.setenv("NNODES", "2")
    with pytest.raises(SystemExit, match="RDZV_DIR"):
        serve_mod._serve_multinode(_cfg())
    assert ran == []


# ─── weights ─────────────────────────────────────────────────────────────────────────────────


def test_a_local_dir_with_weights_is_used_as_is(tmp_path, hub) -> None:
    (tmp_path / "model-00001-of-00001.safetensors").write_bytes(b"")
    assert serve_mod.ensure_weights(str(tmp_path)) == str(tmp_path)


def test_a_configs_only_dir_is_rejected_before_sglang_sees_it(tmp_path, hub) -> None:
    """The failure this check exists for: a partially cached repo has config.json + tokenizer but
    no shards, and SGLang's own error ("Cannot find any model weights") arrives minutes later,
    after the launcher has already claimed the GPUs."""
    (tmp_path / "config.json").write_text("{}")
    with pytest.raises(FileNotFoundError, match="no weight files"):
        serve_mod.ensure_weights(str(tmp_path))


def test_a_cached_repo_is_not_re_downloaded(tmp_path, hub, monkeypatch) -> None:
    (tmp_path / "model.safetensors").write_bytes(b"")

    def snapshot_download(_repo: str, *, local_files_only: bool = False, **_k) -> str:
        assert local_files_only, "the cache must be consulted without touching the network"
        return str(tmp_path)

    hub.snapshot_download = snapshot_download
    assert serve_mod.ensure_weights("org/m") == str(tmp_path)


def test_an_uncached_repo_is_downloaded_with_offline_mode_forced_off(tmp_path, hub, monkeypatch) -> None:
    """An offline sandbox exports HF_HUB_OFFLINE=1, and huggingface_hub latches it into a module
    global at import time — so the fetch has to clear both to reach the Hub at all."""
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    calls: list[bool] = []

    def snapshot_download(_repo: str, *, local_files_only: bool = False, **_k) -> str:
        calls.append(local_files_only)
        if local_files_only:
            raise sys.modules["huggingface_hub.errors"].LocalEntryNotFoundError
        return str(tmp_path)

    hub.snapshot_download = snapshot_download
    assert serve_mod.ensure_weights("org/m") == str(tmp_path)
    assert calls == [True, False]  # cache first, then the network
    assert os.environ["HF_HUB_OFFLINE"] == "0"
    assert sys.modules["huggingface_hub.constants"].HF_HUB_OFFLINE is False


def test_a_client_only_install_is_told_which_extra_to_add(monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "huggingface_hub", None)  # `import x` with a None entry -> ImportError
    with pytest.raises(ImportError, match=r"nanoagent\[serve\]"):
        serve_mod.ensure_weights("org/m")
