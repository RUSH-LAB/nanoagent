"""The argv the launch side would exec — asserted without a GPU, since `command()` is pure."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

from nanoagent.inference import SGLangServeConfig, SGLangServer
from nanoagent.inference import serve as serve_mod
from nanoagent.inference.router import router_command, worker_command

CONFIGS = Path(__file__).resolve().parents[2] / "configs"


def _flag(cmd: list[str], name: str) -> str | None:
    """The value following ``name`` in ``cmd``, or None when the flag is absent."""
    return cmd[cmd.index(name) + 1] if name in cmd else None


def test_single_command_carries_model_endpoint_and_tp() -> None:
    cmd = SGLangServer(SGLangServeConfig(model_path="org/m", gpus_per_engine=8, port=30000)).command()
    assert cmd[:2] == ["sglang", "serve"]
    assert _flag(cmd, "--model-path") == "org/m"
    assert _flag(cmd, "--served-model-name") == "org/m"
    assert _flag(cmd, "--port") == "30000"
    assert _flag(cmd, "--tp-size") == "8"


def test_trivial_parallelism_and_unset_caps_emit_no_flag() -> None:
    """pp/dp/ep of 1 and null caps are SGLang's own defaults — don't restate them on the CLI."""
    cmd = SGLangServer(SGLangServeConfig(gpus_per_engine=1)).command()
    for flag in ("--pp-size", "--dp-size", "--ep-size", "--nnodes", "--max-running-requests", "--context-length"):
        assert flag not in cmd


def test_multinode_single_engine_carries_the_rendezvous_flags() -> None:
    cfg = SGLangServeConfig(gpus_per_engine=16, num_gpus_per_node=8, nnodes=2, node_rank=1, dist_init_addr="h:5000")
    cmd = SGLangServer(cfg).command()
    assert _flag(cmd, "--nnodes") == "2"
    assert _flag(cmd, "--node-rank") == "1"
    assert _flag(cmd, "--dist-init-addr") == "h:5000"


def test_non_trivial_parallelism_and_caps_are_emitted() -> None:
    """The mirror of the previous test: each of these maps to one slime sglang_*_size, and tp is
    DERIVED (gpus_per_engine // pp_size) rather than configured."""
    cfg = SGLangServeConfig(gpus_per_engine=8, pp_size=2, dp_size=2, ep_size=4, max_running_requests=64, context_length=8192)
    cmd = SGLangServer(cfg).command()
    assert _flag(cmd, "--tp-size") == "4"
    assert (_flag(cmd, "--pp-size"), _flag(cmd, "--dp-size"), _flag(cmd, "--ep-size")) == ("2", "2", "4")
    assert (_flag(cmd, "--max-running-requests"), _flag(cmd, "--context-length")) == ("64", "8192")


def test_a_single_node_engine_advertises_itself_on_loopback() -> None:
    """nnodes == 1 means the router and its engines share a host, so registration must not depend
    on the node's outbound IP being reachable (or even discoverable)."""
    cfg = SGLangServeConfig(mode="router", num_gpus_per_node=2, gpus_per_engine=1, port=30000)
    assert cfg.resolved_worker_host == "127.0.0.1"
    assert cfg.resolved_router_address == "127.0.0.1:30000"


def test_explicit_addresses_win_over_the_derived_ones() -> None:
    cfg = SGLangServeConfig(
        mode="router", num_gpus_per_node=2, gpus_per_engine=1, worker_host="10.0.0.9", router_address="10.0.0.1:8000"
    )
    assert (cfg.resolved_worker_host, cfg.resolved_router_address) == ("10.0.0.9", "10.0.0.1:8000")


def test_an_engine_that_spans_nodes_must_tile_them_wholly() -> None:
    """slime's nnodes formula is integer division, so a 12-GPU engine on 8-GPU nodes would
    silently become a 1-node engine that then fails to find its peers."""
    with pytest.raises(ValueError, match="multiple of"):
        SGLangServeConfig(gpus_per_engine=12, num_gpus_per_node=8, nnodes=2, dist_init_addr="h:5000")


def test_extra_args_pass_through_verbatim() -> None:
    cfg = SGLangServeConfig(extra_args={"tool-call-parser": "qwen25", "enable-metrics": True, "off": False, "gone": None})
    cmd = SGLangServer(cfg).command()
    assert _flag(cmd, "--tool-call-parser") == "qwen25"
    assert "--enable-metrics" in cmd  # a True value is a bare store_true flag
    assert "--off" not in cmd and "--gone" not in cmd  # False / None are dropped


def test_router_and_worker_commands_partition_the_node() -> None:
    cfg = SGLangServeConfig(mode="router", num_gpus_per_node=8, gpus_per_engine=2, port=30000, worker_base_port=31000)
    assert _flag(router_command(cfg), "--policy") == "cache_aware"
    # Engine i owns GPUs [i*gpus_per_engine, ...) and its own port, so 4 engines share the node.
    assert _flag(worker_command(cfg, 2), "--base-gpu-id") == "4"
    assert _flag(worker_command(cfg, 2), "--port") == "31002"


def test_a_flat_yaml_is_all_serve_spec_except_the_launch_block(tmp_path) -> None:
    """`launch:` is this package's own key, so the same flat file feeds both launch_from_yaml
    (which reads `launch.target`) and the serve loader."""
    path = tmp_path / "flat.yaml"
    path.write_text("mode: single\nmodel_path: org/m\nlaunch:\n  target: local\n")
    assert SGLangServer.from_yaml(str(path)).config.model_path == "org/m"


def test_a_scoped_yaml_carries_blocks_the_serve_loader_ignores(tmp_path) -> None:
    """One unified yaml describes both how to serve and how a consumer configures itself.
    Under a `serve:` block the sibling blocks are ignored BY CONSTRUCTION, so nanoagent.inference never
    has to know a downstream project's config vocabulary."""
    path = tmp_path / "unified.yaml"
    path.write_text("serve:\n  mode: single\n  model_path: org/m\nlaunch:\n  target: local\nagent:\n  max_steps: 3\n")
    assert SGLangServer.from_yaml(str(path)).config.model_path == "org/m"


def test_a_scalar_serve_block_names_what_is_wrong(tmp_path) -> None:
    path = tmp_path / "scalar.yaml"
    path.write_text("serve: org/m\n")
    with pytest.raises(ValueError, match="must be a mapping"):
        SGLangServer.from_yaml(str(path))


@pytest.mark.parametrize(
    "text",
    [
        "mode: single\nmodel_pth: org/m\n",  # flat: a plain typo
        "serve:\n  mode: single\n  model_pth: org/m\n",  # scoped: strict inside the block too
        "mode: single\nagent:\n  max_steps: 3\n",  # flat: a foreign block must move under `serve:`
    ],
)
def test_an_undeclared_key_raises_in_either_layout(tmp_path, text: str) -> None:
    """Struct-mode strictness is the whole point: a misspelled serve field must never come back
    as a silently defaulted one, whichever layout the file uses."""
    path = tmp_path / "bad.yaml"
    path.write_text(text)
    with pytest.raises(Exception):  # noqa: B017  (OmegaConf struct-mode error type is its own)
        SGLangServer.from_yaml(str(path))


def test_run_execs_the_engine_in_this_process_for_mode_single(monkeypatch, hub, tmp_path) -> None:
    """`single` execs rather than spawns, so the scheduler's signals and the exit code reach SGLang
    directly — there is no supervisor in between to swallow them."""
    (tmp_path / "model.safetensors").write_bytes(b"")
    execs: list[tuple[str, list[str]]] = []
    monkeypatch.setattr(serve_mod.os, "execvp", lambda f, a: execs.append((f, a)))
    server = SGLangServer(SGLangServeConfig(mode="single", model_path=str(tmp_path), gpus_per_engine=1))
    server.run()
    assert execs == [("sglang", server.command())]


@pytest.mark.parametrize(("mode", "delegate"), [("router", "run_router"), ("multinode", "_serve_multinode")])
def test_run_delegates_the_multi_engine_modes(monkeypatch, hub, tmp_path, mode: str, delegate: str) -> None:
    (tmp_path / "model.safetensors").write_bytes(b"")
    called: list[SGLangServeConfig] = []
    monkeypatch.setitem(sys.modules, "nanoagent.inference.router", types.SimpleNamespace(run_router=called.append))
    if delegate == "_serve_multinode":
        monkeypatch.setattr(serve_mod, delegate, called.append)
    monkeypatch.setattr(serve_mod.os, "execvp", lambda *_a: pytest.fail("a multi-engine mode must not exec"))
    cfg = SGLangServeConfig(mode=mode, model_path=str(tmp_path), num_gpus_per_node=2, gpus_per_engine=1)
    SGLangServer(cfg).run()
    assert called == [cfg]


def test_run_checks_the_weights_before_claiming_the_gpus(monkeypatch, hub, tmp_path) -> None:
    """A configs-only model dir must fail here, not minutes later inside SGLang."""
    (tmp_path / "config.json").write_text("{}")
    monkeypatch.setattr(serve_mod.os, "execvp", lambda *_a: pytest.fail("launched without weights"))
    with pytest.raises(FileNotFoundError):
        SGLangServer(SGLangServeConfig(model_path=str(tmp_path), gpus_per_engine=1)).run()


def test_the_module_entry_point_takes_only_a_config(monkeypatch, tmp_path) -> None:
    """`--config` is the ONLY flag: every other knob lives in the yaml, so the same command line
    is valid on every node of every topology."""
    served: list[str] = []
    monkeypatch.setattr(serve_mod, "serve_from_yaml", served.append)
    monkeypatch.setattr(sys, "argv", ["nanoagent.inference.serve", "--config", str(tmp_path / "s.yaml")])
    serve_mod.main()
    assert served == [str(tmp_path / "s.yaml")]


def test_the_module_entry_point_refuses_to_guess_a_config(monkeypatch) -> None:
    monkeypatch.setattr(sys, "argv", ["nanoagent.inference.serve"])
    with pytest.raises(SystemExit):
        serve_mod.main()


@pytest.mark.parametrize("name", ["gemma_4_31b_serve.yaml", "gemma_4_31b_serve_2node.yaml", "gemma_4_31b_router.yaml"])
def test_the_shipped_serve_examples_load(name: str) -> None:
    """The committed examples are the documentation; a schema change must not leave them stale."""
    cfg = SGLangServer.from_yaml(str(CONFIGS / name)).config
    # Each mode's real launch path builds its own argv: single execs command(), router/multinode
    # exec one worker_command() per engine.
    argv = SGLangServer(cfg).command() if cfg.mode == "single" else worker_command(cfg, 0)
    assert argv[:2] == ["sglang", "serve"]
