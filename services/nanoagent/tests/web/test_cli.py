from pathlib import Path

from nanoagent.runtime.config import InteractiveConfig, load_config_args
from nanoagent.web import WebConfig, cli


def test_help_does_not_load_a_config(capsys) -> None:
    assert cli.main(["--help"]) == 0
    assert "web_cfg=<config.yaml>" in capsys.readouterr().out


def test_web_and_interactive_configs_share_one_openrouter_model(monkeypatch) -> None:
    root = Path(__file__).parents[2]
    monkeypatch.chdir(root)
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

    interactive = load_config_args(InteractiveConfig, ["mgen_cfg=configs/openrouter.yaml"])
    web = load_config_args(WebConfig, ["web_cfg=configs/web_openrouter.yaml"])

    assert interactive.model.model == web.model.model
    assert interactive.model.base_url == web.model.base_url
    assert interactive.model.max_tokens == 4096
    assert web.model.max_tokens == 2048  # the web policy narrows only its output budget
    profile = web.profiles[web.default_profile]
    assert profile.harness.type == "native"
    assert profile.model == web.model.model


def test_web_harness_can_be_selected_with_dotted_overrides(monkeypatch) -> None:
    root = Path(__file__).parents[2]
    monkeypatch.chdir(root)
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

    web = load_config_args(
        WebConfig,
        [
            "web_cfg=configs/web_openrouter.yaml",
            "profiles.native-deepseek.harness.type=pi",
            "profiles.native-deepseek.harness.options.provider=openrouter",
            "profiles.native-deepseek.model=anthropic/claude-sonnet-4",
        ],
    )

    profile = web.profiles[web.default_profile]
    assert profile.harness.type == "pi"
    assert profile.model == "anthropic/claude-sonnet-4"
    assert profile.harness.options == {"provider": "openrouter"}
