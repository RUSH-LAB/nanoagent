"""`nanoagent harness`: its config, RUSH Lab's connection, what it makes of a sealed attempt, and joining a live session."""

import base64
import json
import socket
import threading
from pathlib import Path

import pytest

from nanoagent.cli.harness import DEFAULT_CONFIG, HarnessCommandConfig, Link, answer_of, connection, find_lab, summary_line, verdict
from nanoagent.runtime.config import load_config_args


def test_joining_a_live_session_opens_a_terminal_of_its_own_follows_it_alone_and_leaves_when_it_closes() -> None:
    listener = socket.create_server(("127.0.0.1", 0))
    heard: list[dict] = []

    def worker() -> None:  # the session's link (nanoagent.uploaded.terminal), whose terminals 0 and 1 the page has open
        conn, _ = listener.accept()
        with conn, conn.makefile("rb") as lines:
            heard.extend(json.loads(lines.readline()) for _ in range(2))
            data = lambda terminal, text: {"terminal": terminal, "data": base64.b64encode(text).decode()}  # noqa: E731
            send = lambda *items: conn.sendall(b"".join(json.dumps(item).encode() + b"\n" for item in items))  # noqa: E731
            send(data(0, b"page's shell"), {"opened": 2}, data(2, b"$ "), data(1, b"other"))
            heard.append(json.loads(lines.readline()))  # what is typed once it is open goes to its terminal
            send({"terminal": 2, "closed": True}, data(2, b"never"))

    thread = threading.Thread(target=worker)
    thread.start()
    written: list[bytes] = []
    link = Link(listener.getsockname()[1], "t", written.append, joined=True)
    assert link.terminal is None and not link.ready.is_set()
    sender = threading.Thread(target=lambda: (link.ready.wait(), link.send({"terminal": link.terminal, "data": "eA=="})))
    sender.start()
    assert link.follow() == b"$ "
    sender.join()
    thread.join()
    assert written == [b"$ "] and link.terminal == 2 and link.error is None
    assert [heard[0], set(heard[1]), heard[1]["open"], heard[2]] == [{"token": "t"}, {"open", "rows", "cols"}, True, {"terminal": 2, "data": "eA=="}]


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
