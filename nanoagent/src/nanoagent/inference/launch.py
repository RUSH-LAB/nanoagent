"""Launch side: read WHERE to serve from one yaml; nanoagent.inference dispatches.

:mod:`nanoagent.inference.serve` is the *serve* side — it brings the SGLang endpoint up on whatever
machine it runs on (the ``mode`` key picks the topology). This module is the *launch* side:
it reads a serving yaml's optional ``launch`` block and decides where that serve runs.

  * ``launch.target: local`` (default) — run :func:`~nanoagent.inference.serve.serve_from_yaml` in this
    process. Identical to ``python -m nanoagent.inference.serve``.

The ``launch`` block is launch-side only — the serve side (:meth:`SGLangServer.from_conf` /
:meth:`SGLangRouterServer.from_conf`) ignores it, exactly like ``mode``, so the very same yaml
loads on the worker nodes.

Run as a module entry point::

    python3 -m nanoagent.inference.launch --config <yaml>   # serves locally per the yaml's launch.target
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from typing import Any, cast

from omegaconf import DictConfig, OmegaConf

from nanoagent.inference.config import load_yaml
from nanoagent.inference.serve import serve_from_yaml


@dataclass
class LaunchConfig:
    """The ``launch:`` block of a serving yaml — WHERE to bring the endpoint up."""

    # local: serve in this process.
    target: str = "local"


def _load_launch(raw: Any) -> LaunchConfig:
    """Merge a yaml ``launch`` mapping (or nothing) onto the :class:`LaunchConfig` defaults."""
    base = OmegaConf.structured(LaunchConfig)
    merged = OmegaConf.merge(base, raw) if raw is not None else base
    return cast(LaunchConfig, OmegaConf.to_object(merged))


def launch_from_yaml(config_path: str) -> None:
    """Load a serving yaml and bring the endpoint up where its ``launch.target`` selects.

    target (default ``local``): ``local`` -> :func:`~nanoagent.inference.serve.serve_from_yaml` here.
    """
    conf = load_yaml(config_path)
    # load_yaml only guards a non-mapping WHOLE file; a scalar/list VALUE for the `launch:`
    # key inside an otherwise-valid mapping (the typo `launch: local` instead of
    # `launch: {target: local}`) would otherwise reach `_load_launch` and raise an opaque OmegaConf
    # merge error that never names the file. Catch it here with a clear, path-naming ValueError.
    sel = OmegaConf.select(conf, "launch")
    if sel is not None and not isinstance(sel, DictConfig):
        raise ValueError(
            f'the "launch" block in config file {config_path!r} must be a mapping (e.g. launch: {{target: local}}), got {type(sel).__name__}'
        )
    cfg = _load_launch(sel)
    if cfg.target == "local":
        serve_from_yaml(config_path)
    else:
        raise SystemExit(f"unknown launch target {cfg.target!r}; expected local")


def main() -> None:
    """Module entry point: ``python -m nanoagent.inference.launch --config <yaml>`` (launch.target picks where)."""
    parser = argparse.ArgumentParser(description="Launch a nanoagent.inference serve locally.")
    parser.add_argument(
        "--config",
        required=True,
        help="serving yaml; its `launch.target` key selects where to serve (local)",
    )
    ns = parser.parse_args()
    launch_from_yaml(ns.config)


if __name__ == "__main__":
    main()
