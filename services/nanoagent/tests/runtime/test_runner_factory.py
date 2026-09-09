from __future__ import annotations

import pytest

from nanoagent.runtime.config import HarnessConfig, HarnessProfileConfig
from nanoagent.runtime.native_runner import NativeRunner
from nanoagent.runtime.process_runner import SubprocessRunner
from nanoagent.runtime.runner_factory import build_runner
from tests.web.test_runtime import config


def test_native_harness_builds_native_runner() -> None:
    cfg = config()
    runner = build_runner(
        cfg,
        cfg.profiles[cfg.default_profile],
        agent_factory=lambda _instructions: (object(), ""),
    )

    assert isinstance(runner, NativeRunner)
    assert runner.name == "native"


def test_external_harness_uses_default_or_explicit_command() -> None:
    cfg = config()
    default = build_runner(
        cfg,
        HarnessProfileConfig(
            label="PI", model="anthropic/test",
            harness=HarnessConfig(type="pi", command=None, cwd=None, options={}),
            model_overrides={},
        ),
    )
    explicit = build_runner(
        cfg,
        HarnessProfileConfig(
            label="Hermes", model="test",
            harness=HarnessConfig(
                type="hermes", command=["custom-hermes"], cwd="/tmp", options={}
            ),
            model_overrides={},
        ),
    )

    assert isinstance(default, SubprocessRunner)
    assert default.command == ("nanoagent-pi-runner",)
    assert default.capabilities.streaming is True
    assert default.capabilities.tools is False
    assert explicit.command == ("custom-hermes",)
    assert explicit.cwd == "/tmp"


def test_harness_config_rejects_invalid_values() -> None:
    with pytest.raises(ValueError, match="native, hermes, or pi"):
        HarnessConfig(type="unknown", command=None, cwd=None, options={})
    with pytest.raises(ValueError, match="must be null"):
        HarnessConfig(type="native", command=["agent"], cwd=None, options={})
    with pytest.raises(ValueError, match="non-empty list"):
        HarnessConfig(type="pi", command=[], cwd=None, options={})


def test_agent_factory_is_only_for_native_harness() -> None:
    cfg = config()
    with pytest.raises(ValueError, match="only be used"):
        build_runner(
            cfg,
            HarnessProfileConfig(
                label="PI", model="test",
                harness=HarnessConfig(type="pi", command=None, cwd=None, options={}),
                model_overrides={},
            ),
            agent_factory=lambda _instructions: (object(), ""),
        )
