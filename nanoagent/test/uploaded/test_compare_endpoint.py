"""POST /v1/benchmark/compare: the comparison of two posted attempts, by the same path the CLI's step 4 uses."""

from __future__ import annotations

import base64
import sys
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient
from test_cli_compare import recorded
from test_projection_trace import Trace

from nanoagent.runtime.config import load_config_args
from nanoagent.web.app import create_app
from nanoagent.web.config import WebConfig

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "compare-secret"


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.chdir(ROOT)
    monkeypatch.setenv("NANOAGENT_API_TOKEN", TOKEN)
    config = load_config_args(
        WebConfig,
        [
            "web_cfg=deploy/railway/nanoagent.yaml", "packages=[]", f"workspaces={tmp_path / 'w'}", f"installs={tmp_path / 'i'}",
            f"uv_cache={tmp_path / 'u'}", f"plugin_python={sys.executable}", "host=127.0.0.1", "sandbox=none",
        ],
    )  # fmt: skip
    return TestClient(create_app(config), headers={"Authorization": f"Bearer {TOKEN}"})


def side(trace: Trace) -> dict[str, Any]:
    return {
        "records": trace.records,
        "payloads": {sha: base64.b64encode(data).decode() for sha, data in trace.payloads.items()},
        "redactions": {sha: "none" for sha in trace.payloads},
    }


def test_a_changed_command_argv_is_a_field_diff(client: TestClient) -> None:
    reply = client.post("/v1/benchmark/compare", json={"a": side(recorded()), "b": side(recorded(argv=("go", "test", "./pkg")))})
    assert reply.status_code == 200, reply.text
    body = reply.json()
    changed = [row for row in body["rows"] if row["status"] != "same"]
    assert [row["status"] for row in changed] == ["changed"]
    assert [d["path"] for d in changed[0]["input_diff"]] == ["$.argv[2]"]
    assert body["first_difference"] == changed[0]["index"]
    assert body["estimate_withheld"] is None and body["condition_differences"] == []


def test_a_different_reference_rate_withholds_the_estimate_delta(client: TestClient) -> None:
    body = client.post("/v1/benchmark/compare", json={"a": side(recorded()), "b": side(recorded(reference=50.0))}).json()
    assert body["estimate_delta_ns"] is None and "reference rate" in body["estimate_withheld"]


def test_an_extra_tool_call_is_only_in_b(client: TestClient) -> None:
    body = client.post("/v1/benchmark/compare", json={"a": side(recorded()), "b": side(recorded(extra_tool=True))}).json()
    assert [row["b"][0]["target"] for row in body["rows"] if row["status"] == "only_b"] == ["validate"]


@pytest.mark.parametrize("body", [{}, {"a": {"records": []}}, {"a": {"records": [], "payloads": {"x": "!!"}}, "b": {"records": []}}])
def test_a_malformed_body_is_a_400(client: TestClient, body: dict[str, Any]) -> None:
    reply = client.post("/v1/benchmark/compare", json=body)
    assert reply.status_code == 400 and "error" in reply.json()


def test_the_endpoint_needs_the_token(client: TestClient) -> None:
    assert client.post("/v1/benchmark/compare", json={}, headers={"Authorization": "Bearer nope"}).status_code == 401
