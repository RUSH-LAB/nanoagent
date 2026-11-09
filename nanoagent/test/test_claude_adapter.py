from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanoagent.harness.adapters import claude


def _run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, result: dict) -> dict:
    monkeypatch.setattr(claude, "run_child", lambda *args, **kwargs: (json.dumps(result), ""))
    payload = {
        "protocol": "nanoagent.runner.v1",
        "request": {"input": "hi", "messages": [], "instructions": None, "metadata": None, "workspace": str(tmp_path)},
        "options": {},
    }
    return claude._run(payload)


def test_passes_on_claude_codes_own_timing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    done = _run(tmp_path, monkeypatch, {"result": "ok", "num_turns": 1, "duration_ms": 3547, "duration_api_ms": 3494})
    assert done["metrics"] == {"duration_s": 3.547, "model_s": 3.494}


def test_leaves_metrics_out_when_claude_code_reports_no_timing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert _run(tmp_path, monkeypatch, {"result": "ok"})["metrics"] is None
