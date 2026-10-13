"""A run's own model and settings, on a fake PI runner that answers with the options it was given."""

from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

from nanoagent.runtime.config import load_config_args
from nanoagent.web.app import create_app
from nanoagent.web.config import WebConfig

ROOT = Path(__file__).resolve().parents[1]

# Stands in for js/pi-runner/dist/index.js: answers with the options of its envelope and the
# provider keys its environment holds.
RUNNER = """
import json, os, sys
envelope = json.loads(sys.stdin.readline())
keys = {name: value for name, value in os.environ.items() if name.endswith("_API_KEY")}
print(json.dumps({"type": "done", "answer": json.dumps({"options": envelope["options"], "keys": keys}),
                  "stop_reason": "answer", "steps": 1, "usage": {}, "cost": 0.0, "error": None}))
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
    return {**json.loads(events[-1]["answer"]), "model": events[-1]["model"]}


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



def test_a_run_with_keys_reaches_pi_with_them_alone(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, run_models=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "server-ant")
    keyed = _answer(client.post("/v1/runs", json={"input": "x", "keys": {"OPENROUTER_API_KEY": "sk-run"}}))
    assert keyed["keys"] == {"OPENROUTER_API_KEY": "sk-run"}
    assert keyed["options"]["run_keys"] == ["OPENROUTER_API_KEY"]
    # The next run without keys has the server's own, which the keyed run left as they were.
    plain = _answer(client.post("/v1/runs", json={"input": "x"}))
    assert plain["keys"] == {"OPENROUTER_API_KEY": "test-key", "ANTHROPIC_API_KEY": "server-ant"}
    assert "run_keys" not in plain["options"]


def test_a_run_with_keys_may_name_its_model_within_the_limits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, run_models=False)
    named = {"input": "x", "model": {"provider": "anthropic", "model": "claude-x"}, "keys": {"ANTHROPIC_API_KEY": "sk-ant-run"}}
    run = _answer(client.post("/v1/runs", json=named))
    assert run["model"] == "claude-x" and run["options"]["provider"] == "anthropic"
    assert run["keys"] == {"ANTHROPIC_API_KEY": "sk-ant-run"}
    over = client.post("/v1/runs", json={**named, "settings": {"max_tokens": 4096}})
    assert over.status_code == 400 and "at most 2048" in over.json()["error"]
    # The profile reaches OpenRouter with OPENROUTER_API_KEY, which this run did not bring.
    missing = client.post("/v1/runs", json={"input": "x", "keys": {"ANTHROPIC_API_KEY": "sk-ant-run"}})
    assert missing.status_code == 400 and "brings no OPENROUTER_API_KEY" in missing.json()["error"]
    assert "sk-ant-run" not in missing.text


def test_a_run_refuses_keys_that_are_not_provider_keys(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, run_models=False)
    for keys in ({}, {"PATH": "/tmp"}, {"OPENAI_API_KEY": "two words"}, {"OPENAI_API_KEY": ""}, {"OPENAI_API_KEY": 7}, "sk-x"):
        refused = client.post("/v1/runs", json={"input": "x", "keys": keys})
        assert refused.status_code == 400 and refused.json()["error"].startswith("keys")
        assert "two words" not in refused.text and "sk-x" not in refused.text


def test_a_run_with_keys_reaches_the_loop_with_them_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    from nanoagent.harness.choice import keyed_environ
    from nanoagent.harness.registry import keyed_model, loop_model
    from nanoagent.inference.providers import MissingKeyError
    from nanoagent.plugin.runtime import plugin_env

    monkeypatch.chdir(ROOT)
    cfg = load_config_args(WebConfig, ["web_cfg=deploy/railway/nanoagent.yaml", "host=127.0.0.1", "api_token=null"])
    model_cfg, _ = loop_model(cfg, None)
    assert keyed_model(model_cfg, {"OPENROUTER_API_KEY": "sk-run"}).api_key == "sk-run"
    with pytest.raises(MissingKeyError, match=r"brings no OpenRouter API key \(OPENROUTER_API_KEY\)"):
        keyed_model(model_cfg, {"ANTHROPIC_API_KEY": "sk-ant"})
    with pytest.raises(MissingKeyError, match="bedrock models run on this host's own credentials"):
        keyed_model(replace(model_cfg, provider="bedrock"), {"OPENROUTER_API_KEY": "sk-run"})
    # A plugin the run starts gets the run's keys, and none of the server's.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "server-ant")
    monkeypatch.setenv("PLUGIN_REGION", "eu")
    manifest = SimpleNamespace(env=("OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "PLUGIN_REGION"))
    env = plugin_env(manifest, ROOT, keyed_environ({"OPENROUTER_API_KEY": "sk-run"}))
    assert {name: env.get(name) for name in manifest.env} == {"OPENROUTER_API_KEY": "sk-run", "ANTHROPIC_API_KEY": None, "PLUGIN_REGION": "eu"}


def test_a_model_whose_key_is_not_set_says_which_key_it_needs(monkeypatch: pytest.MonkeyPatch) -> None:
    from nanoagent.inference.config import LeanInferConfig
    from nanoagent.inference.providers import MissingKeyError, build_provider

    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(MissingKeyError, match=r"No OpenRouter API key is set \(OPENROUTER_API_KEY\): add one to run a/b"):
        build_provider(LeanInferConfig(provider="openrouter", model="a/b"))
