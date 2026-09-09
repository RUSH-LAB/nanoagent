from __future__ import annotations

from starlette.testclient import TestClient

from nanoagent.web.app import create_app
from tests.web.test_runtime import AnsweringAgent, config
from nanoagent.web.runtime import RunHost


def test_health_and_authenticated_stream() -> None:
    cfg = config(api_token="secret")
    host = RunHost(cfg, agent_factory=lambda instructions: (AnsweringAgent(), instructions or "BASE"))
    with TestClient(create_app(cfg, host=host)) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["service"] == "nanoagent"
        assert health.json()["apiVersion"] == "v1"
        assert health.json()["harness"] == "native"
        assert health.json()["capabilities"]["streaming"] is True

        assert client.get("/v1/profiles").status_code == 401
        profiles = client.get(
            "/v1/profiles", headers={"Authorization": "Bearer secret"}
        )
        assert profiles.status_code == 200
        assert profiles.json()["defaultProfile"] == "native-test"
        assert profiles.json()["profiles"][0]["model"] == "test"

        assert client.post("/v1/runs", json={"input": "hi"}).status_code == 401
        response = client.post(
            "/v1/runs",
            json={"input": "hi"},
            headers={"Authorization": "Bearer secret"},
        )
        assert response.status_code == 200
        assert response.headers["x-nanoagent-api-version"] == "v1"
        assert response.headers["x-nanoagent-run-id"]
        assert '"type":"delta"' in response.text
        assert '"type":"done"' in response.text


def test_rejects_invalid_or_oversized_requests() -> None:
    cfg = config(max_request_bytes=20)
    host = RunHost(cfg, agent_factory=lambda instructions: (AnsweringAgent(), "BASE"))
    with TestClient(create_app(cfg, host=host)) as client:
        invalid = client.post("/v1/runs", content=b"not-json")
        assert invalid.status_code == 400
        oversized = client.post("/v1/runs", content=b"x" * 21)
        assert oversized.status_code == 413
