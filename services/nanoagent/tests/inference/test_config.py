"""The two config schemas: what a yaml is allowed to say, and what it derives."""

from __future__ import annotations

from pathlib import Path

import pytest

from nanoagent.inference import LeanInferConfig, SGLangServeConfig, load_config

CONFIGS = Path(__file__).resolve().parents[2] / "configs"


def _write(tmp_path, name: str, text: str) -> str:
    p = tmp_path / name
    p.write_text(text)
    return str(p)


def test_load_config_merges_yaml_over_defaults(tmp_path) -> None:
    path = _write(tmp_path, "c.yaml", "model: m\nbase_url: http://h:1/v1\nconcurrency: 4\n")
    cfg = load_config(path)
    assert (cfg.model, cfg.base_url, cfg.concurrency) == ("m", "http://h:1/v1", 4)
    assert cfg.backend == "sglang"  # untouched keys keep the schema default


def test_load_config_rejects_an_unknown_key(tmp_path) -> None:
    path = _write(tmp_path, "c.yaml", "concurrenyc: 4\n")  # typo
    with pytest.raises(Exception):  # noqa: B017  (OmegaConf struct-mode error type is its own)
        load_config(path)


def test_dotted_overrides_apply_after_the_yaml(tmp_path) -> None:
    path = _write(tmp_path, "c.yaml", "concurrency: 4\n")
    assert load_config(path, ["concurrency=9"]).concurrency == 9


@pytest.mark.parametrize(
    "kwargs",
    [
        {"concurrency": 0},
        {"max_retries": -1},
        {"request_timeout": 0},
        {"temperature": -0.1},
        {"max_tokens": 0},
        {"base_url": "host:8000/v1"},  # no scheme
    ],
)
def test_out_of_range_knobs_fail_at_config_time(kwargs) -> None:
    with pytest.raises(ValueError):
        LeanInferConfig(**kwargs)


def test_the_shipped_client_example_loads() -> None:
    """The committed example is the documentation for a client yaml; a schema change must not
    leave it stale — and it is also the replacement for the per-model constructor helpers that
    used to hardcode one family's sampling in Python."""
    cfg = load_config(str(CONFIGS / "gemma_4_31b_sglang.yaml"))
    assert cfg.backend == "sglang"
    assert cfg.base_url.endswith("/v1")


def test_an_out_of_range_override_fails_the_same_way_the_yaml_would(tmp_path) -> None:
    """The per-run budget knob is a dotted override, and it is revalidated: the merged result is
    instantiated as the dataclass, so `__post_init__` runs on the override too rather than the
    field being mutated past its range check."""
    path = _write(tmp_path, "c.yaml", "model: m\nmax_tokens: 128\n")
    assert load_config(path, ["max_tokens=4096", "concurrency=32"]).max_tokens == 4096
    with pytest.raises(ValueError):
        load_config(path, ["max_tokens=0"])


def test_serve_config_derives_tp_name_and_base_url() -> None:
    cfg = SGLangServeConfig(model_path="org/m", gpus_per_engine=8, pp_size=2, host="0.0.0.0", port=1234)
    assert cfg.tp_size == 4  # gpus_per_engine // pp_size
    assert cfg.name == "org/m"  # served_model_name unset -> model_path
    assert cfg.base_url == "http://127.0.0.1:1234/v1"  # 0.0.0.0 bind -> what a local client dials


def test_serve_config_router_mode_packs_engines_per_node() -> None:
    cfg = SGLangServeConfig(mode="router", num_gpus_per_node=8, gpus_per_engine=2)
    assert cfg.engines_per_node == 4


@pytest.mark.parametrize(
    "kwargs",
    [
        {"mode": "nonsense"},
        {"port": 0},
        {"gpus_per_engine": 8, "pp_size": 3},  # not divisible
        {"nnodes": 2},  # single mode without dist_init_addr
        {"mode": "router", "num_gpus_per_node": 8, "gpus_per_engine": 3},  # doesn't tile the node
        {"mode": "router", "nnodes": 2, "num_gpus_per_node": 8, "gpus_per_engine": 2},  # no router_address
    ],
)
def test_serve_config_rejects_an_incoherent_topology(kwargs) -> None:
    with pytest.raises(ValueError):
        SGLangServeConfig(**kwargs)
