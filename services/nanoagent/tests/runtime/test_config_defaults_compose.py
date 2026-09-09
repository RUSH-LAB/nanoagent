"""Offline pin: ``load_config_args`` composes a ``defaults:`` chain in a ``*_cfg=`` file.

A config YAML loaded via a ``<name>_cfg=path`` token may carry a top-level ``defaults: [path, ...]``
list naming other YAMLs to merge in first (this file wins on top) — the Hydra-lite composition
:func:`slimconfig.load_mapping_yaml` provides, now reachable through nanoagent's loader
(:func:`nanoagent.runtime.config._merge_specs`). This lets one self-contained config pull in a shared one
(e.g. a benchmark config ``defaults``-composing the shared agent harness it evaluates)
instead of the caller threading both files as separate tokens.

``defaults`` entries resolve relative to the CWD (the project root every script is run from) — the
same single path convention as a tool manifest's paths — NOT relative to the file that names them.
The tests chdir into ``tmp_path`` to make that resolution observable; no model / network / GPU.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_config_defaults_compose.py -x -q
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest
from nanoagent.runtime.config import load_config_args
from omegaconf import MISSING


@dataclass
class _Schema:
    a: int = MISSING
    b: int = MISSING
    c: int = MISSING


def test_cfg_file_composes_defaults_chain(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # base sets all three; child `defaults`-composes base (cwd-relative path) and overrides one
    # leaf. The merged result is base with the child on top, and the consumed `defaults` key never
    # reaches the struct-mode schema merge (which would otherwise reject it as unknown).
    monkeypatch.chdir(tmp_path)  # cwd is where `defaults` entries resolve from
    (tmp_path / "base.yaml").write_text("a: 1\nb: 2\nc: 3\n")
    (tmp_path / "child.yaml").write_text("defaults:\n  - base.yaml\nb: 20\n")

    cfg = load_config_args(_Schema, ["x_cfg=child.yaml"])

    assert (cfg.a, cfg.b, cfg.c) == (1, 20, 3)  # base provides a/c; child's b wins


def test_defaults_resolve_from_cwd_not_the_files_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # The base lives in cwd; the child that names it sits in a SUBDIR. A `defaults: [base.yaml]`
    # entry resolves from cwd (finds it), not from the child's own dir (where there is none) — the
    # behavior that makes `defaults` read like every other repo path.
    monkeypatch.chdir(tmp_path)
    (tmp_path / "base.yaml").write_text("a: 1\nb: 2\nc: 3\n")
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "child.yaml").write_text("defaults:\n  - base.yaml\nb: 20\n")

    cfg = load_config_args(_Schema, ["x_cfg=sub/child.yaml"])

    assert (cfg.a, cfg.b, cfg.c) == (1, 20, 3)


def test_dotted_override_still_wins_over_composed_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # A dotted key=value override is applied after the file includes (see _ordered_specs), so it
    # beats both the composed default and the child file.
    monkeypatch.chdir(tmp_path)
    (tmp_path / "base.yaml").write_text("a: 1\nb: 2\nc: 3\n")
    (tmp_path / "child.yaml").write_text("defaults:\n  - base.yaml\nb: 20\n")

    cfg = load_config_args(_Schema, ["x_cfg=child.yaml", "c=99"])

    assert (cfg.a, cfg.b, cfg.c) == (1, 20, 99)
