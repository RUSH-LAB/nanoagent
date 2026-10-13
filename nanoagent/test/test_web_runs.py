"""A run's own model and settings, on a fake PI runner that answers with the options it was given."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from nanoagent.runtime.config import load_config_args
from nanoagent.web.app import create_app
from nanoagent.web.config import WebConfig

ROOT = Path(__file__).resolve().parents[1]

# Stands in for js/pi-runner/dist/index.js: answers with the options of its envelope.
RUNNER = """
import json, sys
envelope = json.loads(sys.stdin.readline())
print(json.dumps({"type": "done", "answer": json.dumps(envelope["options"]), "stop_reason": "answer",
                  "steps": 1, "usage": {}, "cost": 0.0, "error": None}))
"""
# Stands in for models.js.
CATALOG = {
    "providers": [{"id": "openrouter", "name": "OpenRouter", "keySet": True}, {"id": "anthropic", "name": "Anthropic", "keySet": False}],
    "models": [
        {
            "provider": "openrouter",
            "id": "deepseek/deepseek-v4-flash-0731",
            "name": "DeepSeek",
            "contextWindow": 1000,
            "maxTokens": 100,
            "reasoning": False,
            "cost": {"input": 0.05, "output": 0.2},
        },
        {
            "provider": "anthropic",
            "id": "claude-x",
            "name": "Claude X",
            "contextWindow": 2000,
            "maxTokens": 200,
            "reasoning": True,
            "cost": {"input": 3.0, "output": 15.0},
        },
    ],
}


def _client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, run_models: bool) -> TestClient:
    monkeypatch.chdir(ROOT)
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    runner = tmp_path / "pi"
    runner.mkdir()
    (runner / "index.js").write_text(RUNNER)
    (runner / "models.js").write_text(f"import json; print(json.dumps({CATALOG!r}))")
    profile = tmp_path / "pi-fake.yaml"
    profile.write_text(
        "_ > nanoagent.runtime.config.HarnessProfileConfig:\n"
        "label: Fake · PI\n"
        "model: deepseek/deepseek-v4-flash-0731\n"
        "harness > nanoagent.runtime.config.HarnessConfig:\n"
        "  type: pi\n"
        f"  command: [{sys.executable}, {runner / 'index.js'}]\n"
        "  cwd: null\n"
        "  options: [provider=openrouter, api_key_env=OPENROUTER_API_KEY, thinking_level=off]\n"
        "model_overrides > nanoagent.runtime.config.ModelPart:\n"
    )
    config = load_config_args(
        WebConfig,
        [
            "web_cfg=deploy/railway/nanoagent.yaml",
            f"profiles=[{profile}]",
            "default_profile=pi-fake",
            "packages=[]",
            f"workspaces={tmp_path / 'workspaces'}",
            f"installs={tmp_path / 'installs'}",
            "host=127.0.0.1",
            "api_token=null",
            "sandbox=none",
            f"run_models={str(run_models).lower()}",
        ],
    )
    return TestClient(create_app(config))


def _answer(response) -> dict:
    assert response.status_code == 200, response.text
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
    assert events[-1]["type"] == "done", events[-1]
    return {"options": json.loads(events[-1]["answer"]), "model": events[-1]["model"]}


def test_a_run_tunes_its_profile_without_changing_it_for_the_next(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, run_models=False)
    tuned = _answer(client.post("/v1/runs", json={"input": "x", "settings": {"thinking_level": "high", "temperature": 0.3, "max_tokens": 100}}))
    assert tuned["options"]["thinking_level"] == "high" and tuned["options"]["temperature"] == 0.3
    plain = _answer(client.post("/v1/runs", json={"input": "x"}))
    assert plain["options"]["thinking_level"] == "off" and "temperature" not in plain["options"]
    over = client.post("/v1/runs", json={"input": "x", "settings": {"max_tokens": 4096}})
    assert over.status_code == 400 and "at most 2048" in over.json()["error"]
    steps = client.post("/v1/runs", json={"input": "x", "settings": {"max_steps": 2}})
    assert steps.status_code == 400 and "max_steps does not apply to PI" in steps.json()["error"]
    named = client.post("/v1/runs", json={"input": "x", "model": {"provider": "anthropic", "model": "claude-x"}})
    assert named.status_code == 400 and "configured profiles" in named.json()["error"]
    assert client.get("/v1/models").status_code == 404


def test_a_members_own_nanoagent_runs_the_model_they_name(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, run_models=True)
    run = _answer(
        client.post("/v1/runs", json={"input": "x", "model": {"provider": "anthropic", "model": "claude-x"}, "settings": {"max_tokens": 9000}})
    )
    assert run["model"] == "claude-x"
    # The profile's OpenRouter key does not go with an Anthropic model; pi-ai finds Anthropic's own.
    assert run["options"]["provider"] == "anthropic" and "api_key_env" not in run["options"]
    assert run["options"]["max_tokens"] == 9000
    unknown = client.post("/v1/runs", json={"input": "x", "model": {"provider": "anthropic", "model": "nope"}})
    assert unknown.status_code == 400 and "unknown model" in unknown.json()["error"]
    listing = client.get("/v1/models").json()
    assert [provider["keySet"] for provider in listing["providers"]] == [True, False]
    assert [model["apps"] for model in listing["models"]] == [True, False]
    assert listing["limits"]["capped"] is False


def test_the_profiles_say_what_they_are_for_and_what_they_cost(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    listing = _client(tmp_path, monkeypatch, run_models=False).get("/v1/profiles").json()
    (profile,) = listing["profiles"]
    assert profile["uses"] == ["chat", "inline"] and profile["provider"] == "openrouter" and profile["providerName"] == "OpenRouter"
    assert profile["price"] == {"input": 0.05, "output": 0.2} and profile["contextWindow"] == 1000
    assert listing["limits"]["capped"] is True


def test_keys_set_while_running_reach_the_next_catalog_and_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, run_models=True)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    # A catalog that, like pi-ai's, says which providers' keys its environment holds.
    (tmp_path / "pi" / "models.js").write_text(
        "import json, os\n"
        f"catalog = {CATALOG!r}\n"
        "catalog['providers'][1]['keySet'] = 'ANTHROPIC_API_KEY' in os.environ\n"
        "print(json.dumps(catalog))\n"
    )
    assert [provider["keySet"] for provider in client.get("/v1/models").json()["providers"]] == [True, False]
    assert client.put("/v1/keys", json={"changes": {"ANTHROPIC_API_KEY": "sk-ant"}}).json() == {"keys": ["ANTHROPIC_API_KEY"]}
    assert [provider["keySet"] for provider in client.get("/v1/models").json()["providers"]] == [True, True]
    assert client.put("/v1/keys", json={"changes": {"ANTHROPIC_API_KEY": None}}).status_code == 200
    assert [provider["keySet"] for provider in client.get("/v1/models").json()["providers"]] == [True, False]
    for changes in ({"PATH": "/tmp"}, {"NANOAGENT_API_TOKEN": "x"}, {"OPENAI_API_KEY": "two words"}, {}):
        assert client.put("/v1/keys", json={"changes": changes}).status_code == 400



def test_a_model_whose_key_is_not_set_says_which_key_it_needs(monkeypatch: pytest.MonkeyPatch) -> None:
    from nanoagent.inference.config import LeanInferConfig
    from nanoagent.inference.providers import MissingKeyError, build_provider

    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(MissingKeyError, match=r"No OpenRouter API key is set \(OPENROUTER_API_KEY\): add one to run a/b"):
        build_provider(LeanInferConfig(provider="openrouter", model="a/b"))
