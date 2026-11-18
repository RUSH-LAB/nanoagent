"""Stand-ins for the configuration stack NanoAgent's chat client module imports but never uses to send a request.

`nanoagent.inference.config` imports omegaconf and slimconfig at module level, only to load YAML configs. Neither can be
installed by the network-less wheel build (omegaconf and its antlr4 runtime ship no wheels, slimconfig is a git
source), so the harness provides these names and fails loudly if anything ever calls them.
"""

from __future__ import annotations

import sys
import types


def _unused(name: str):
    def call(*args, **kwargs):
        raise RuntimeError(f"{name} is not available in the uploaded harness")

    return call


def install() -> None:
    """Registers the stand-ins for omegaconf and slimconfig, whether or not the real packages are installed."""
    omegaconf = types.ModuleType("omegaconf")
    omegaconf.OmegaConf = types.SimpleNamespace(**{n: _unused(f"OmegaConf.{n}") for n in ("create", "merge", "structured", "to_container")})
    omegaconf.DictConfig = dict
    sys.modules["omegaconf"] = omegaconf
    slimconfig = types.ModuleType("slimconfig")
    slimconfig.load_mapping_yaml = _unused("slimconfig.load_mapping_yaml")
    slimconfig.resolve_path = _unused("slimconfig.resolve_path")
    sys.modules["slimconfig"] = slimconfig
