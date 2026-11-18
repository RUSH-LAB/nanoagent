"""`nanoagent harness`: its config, RUSH Lab's connection and what it makes of a sealed attempt."""

import json
from pathlib import Path

import pytest

from nanoagent.cli.harness import DEFAULT_CONFIG, HarnessCommandConfig, answer_of, connection, find_lab, summary_line, verdict
from nanoagent.runtime.config import load_config_args


def test_the_config_takes_plugin_and_harness_and_leaves_the_rest_to_the_tab_s_choices() -> None:
    cfg = load_config_args(HarnessCommandConfig, [f"harness_cfg={DEFAULT_CONFIG}", "plugin=city-weather", "harness=codex"])
    assert (cfg.plugin, cfg.harness, cfg.prompt, cfg.task, cfg.model, cfg.home, cfg.workspace) == (
        "city-weather",
        "codex",
        None,
        None,
        None,
        None,
        None,
    )
    assert cfg.lab is None


def sign_in(lab: Path) -> Path:
    folder = lab / "connections" / "localhost-3000-x"
    folder.mkdir(parents=True)
    (folder / "site").write_text("http://localhost:3000\n")
    (folder / "runner-credentials.json").write_text(json.dumps({"site": "http://localhost:3000", "token": "t"}))
    return folder


def test_the_connection_is_rush_lab_s_one_signed_in_connection(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="holds 0"):
        connection(tmp_path)
    folder = sign_in(tmp_path)
    assert connection(tmp_path) == (folder, "http://localhost:3000", "t")


def test_without_lab_it_is_whichever_of_rush_lab_and_rush_lab_dev_is_signed_in(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="neither"):
        find_lab(tmp_path)
    sign_in(tmp_path / "lab.mochi.lab.dev")
    assert find_lab(tmp_path) == tmp_path / "lab.mochi.lab.dev"
    sign_in(tmp_path / "lab.mochi.lab")
    with pytest.raises(SystemExit, match="pass lab="):
        find_lab(tmp_path)


def test_a_sealed_attempt_reads_as_right_wrong_or_no_verdict_with_its_answer() -> None:
    answered = {"execution": {"status": "answered"}}
    assert [verdict(answered | {"verdict": v}) for v in ("pass", "fail", None)] == ["right", "wrong", "no verdict"]
    assert verdict({"execution": {"status": "execution_failed"}, "verdict": "fail"}) == "no verdict"  # no answer.json: nothing scored
    recording = [
        {"kind": "model_call.response", "data": {}},
        {"kind": "result.read", "data": {"outcome": {"status": "answered", "answer": {"x": 1}}}},
    ]
    assert answer_of(recording) == {"x": 1} and answer_of([]) is None
    result = {
        "harness": "codex",
        "plugin": "city-weather",
        "verdict": "right",
        "elapsed_s": 48.2,
        "input_tokens": 152_300,
        "output_tokens": 6_100,
        "cost_usd": 0.011,
    }
    assert summary_line(result, Path("r/result.json")) == "codex · city-weather · right · 48 s · 152k in / 6k out · $0.0110 · r/result.json"
