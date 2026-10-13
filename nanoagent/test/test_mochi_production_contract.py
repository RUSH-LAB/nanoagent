from __future__ import annotations

from pathlib import Path

from nanoagent.runtime.config import load_config_args
from nanoagent.web.config import WebConfig
from nanoagent.web.runtime import RunHost


ROOT = Path(__file__).resolve().parents[1]


def test_railway_config_is_private_authenticated_and_mochi_compatible(
    monkeypatch,
) -> None:
    monkeypatch.chdir(ROOT)
    monkeypatch.setenv("PORT", "9876")
    monkeypatch.setenv("NANOAGENT_API_TOKEN", "contract-test-secret")

    config = load_config_args(
        WebConfig,
        ["web_cfg=deploy/railway/nanoagent.yaml"],
    )
    host = RunHost(config)
    catalog = host.profiles

    assert config.host == "0.0.0.0"
    assert config.port == 9876
    assert config.api_token == "contract-test-secret"
    assert config.sandbox == "bwrap"
    assert catalog["defaultProfile"] == "pi-deepseek"
    assert catalog["profiles"] == [
        {
            "id": "pi-deepseek",
            "label": "DeepSeek V4 Flash · PI",
            "harness": "pi",
            "model": "deepseek/deepseek-v4-flash-0731",
            "available": True,
            "unavailableReason": None,
            "capabilities": {
                "streaming": True,
                "reasoning": True,
                "tools": False,
                "usage": True,
                "cancellation": True,
                "history": True,
            },
        }
    ]


def test_production_container_and_railway_manifest_exist() -> None:
    assert (ROOT / "Dockerfile").is_file()
    assert (ROOT / ".dockerignore").is_file()
    assert (ROOT / ".railway" / "railway.ts").is_file()
