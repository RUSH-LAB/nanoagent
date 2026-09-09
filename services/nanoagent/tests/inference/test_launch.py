"""The launch dispatcher: one yaml says WHERE to serve, and nanoagent.inference routes on it."""

from __future__ import annotations

import sys

import pytest

from nanoagent.inference import launch as launch_mod
from nanoagent.inference import launch_from_yaml


@pytest.fixture
def served(monkeypatch) -> list[str]:
    """Records the config path handed to the serve side instead of launching a server."""
    calls: list[str] = []
    monkeypatch.setattr(launch_mod, "serve_from_yaml", calls.append)
    return calls


def _yaml(tmp_path, text: str) -> str:
    p = tmp_path / "serve.yaml"
    p.write_text(text)
    return str(p)


def test_a_yaml_with_no_launch_block_serves_locally(tmp_path, served) -> None:
    path = _yaml(tmp_path, "mode: single\nmodel_path: org/m\n")
    launch_from_yaml(path)
    assert served == [path]


def test_launch_target_local_serves_in_this_process(tmp_path, served) -> None:
    path = _yaml(tmp_path, "mode: single\nmodel_path: org/m\nlaunch:\n  target: local\n")
    launch_from_yaml(path)
    assert served == [path]


def test_an_unknown_target_is_refused(tmp_path, served) -> None:
    path = _yaml(tmp_path, "mode: single\nlaunch:\n  target: mars\n")
    with pytest.raises(SystemExit, match="mars"):
        launch_from_yaml(path)
    assert served == []


def test_a_scalar_launch_block_names_the_offending_file(tmp_path, served) -> None:
    """`launch: local` instead of `launch: {target: local}` is the easy typo — it must not
    surface as an opaque OmegaConf merge error that never mentions the config."""
    path = _yaml(tmp_path, "mode: single\nlaunch: local\n")
    with pytest.raises(ValueError, match="must be a mapping"):
        launch_from_yaml(path)


def test_the_module_entry_point_takes_only_a_config(monkeypatch, tmp_path, served) -> None:
    path = _yaml(tmp_path, "mode: single\nmodel_path: org/m\n")
    monkeypatch.setattr(sys, "argv", ["nanoagent.inference.launch", "--config", path])
    launch_mod.main()
    assert served == [path]


def test_the_module_entry_point_refuses_to_guess_a_config(monkeypatch, served) -> None:
    monkeypatch.setattr(sys, "argv", ["nanoagent.inference.launch"])
    with pytest.raises(SystemExit):
        launch_mod.main()
    assert served == []
