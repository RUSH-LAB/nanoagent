"""CLI acceptance: a member's own agent, added in a Terminal session and run there as `rush <command>`, runs a benchmark as `rush <command>`.

In a free-form Terminal session (the Harness tab's shell, driven over the worker's terminal link) the member installs `myagent` into
`.rush/python/bin/` and runs it once as `rush myagent --version`, which remembers it; the session ends and is kept. Step 2 then runs the
ab-report benchmark with `harness=rush myagent`: the worker pins that installation for the run and mounts it in the case's VM, the shell starts the agent
through rush.py with the case's prompt, and the verifier scores what it left.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_rush_agent.py -m uploaded_acceptance
"""

from __future__ import annotations

import base64
import json
import socket
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
import stack as st

pytestmark = [pytest.mark.microsandbox, pytest.mark.uploaded_acceptance]

AGENT = Path(__file__).with_name("myagent.py")


@dataclass
class Ran:
    session_screen: str
    session_events: list[dict[str, Any]]
    report: dict[str, Any]
    attempt: dict[str, Any]
    events: list[dict[str, Any]]
    ledger: Any
    benchmark: dict[str, Any]


def terminal_session(s: st.Stack, commands: list[str], timeout: float = 600) -> tuple[str, str]:
    """A free-form Terminal session of the probe plugin, each of ``commands`` typed at its shell once the one before printed its marker,
    then `exit`: (its attempt id, what its terminal showed)."""
    prefix = f"{s.rush.base_url}/api/workspaces/{s.rush.workspace_id}/benchmark"
    headers = {"authorization": f"Bearer {s.rush.token}", "origin": s.rush.base_url}
    started = httpx.post(f"{prefix}/sessions", json={"plugin_id": st.PLUGIN, "harness": "shell", "interactive": True, "model": s.model}, headers=headers, timeout=600)
    assert started.status_code == 201, started.text
    attempt_id = started.json()["attempt_id"]
    deadline = time.monotonic() + timeout
    while (link := httpx.get(f"{prefix}/attempts/{attempt_id}/terminal-link", headers=headers, timeout=120)).status_code == 204:
        assert time.monotonic() < deadline, "the session's terminal link never came up"
    assert link.status_code == 200, link.text
    found = link.json()
    sock = socket.create_connection(("127.0.0.1", found["port"]))
    screen = bytearray()
    lock = threading.Lock()

    def follow() -> None:
        with sock.makefile("rb") as lines:
            for raw in lines:
                line = json.loads(raw)
                if line.get("terminal") == 0 and "data" in line:
                    with lock:
                        screen.extend(base64.b64decode(line["data"]))

    reader = threading.Thread(target=follow, daemon=True)
    sock.sendall(json.dumps({"token": found["token"]}).encode() + b"\n")
    reader.start()

    def typed(text: str) -> None:
        sock.sendall(json.dumps({"terminal": 0, "data": base64.b64encode(text.encode()).decode()}).encode() + b"\n")

    for number, command in enumerate(commands):
        marker = f"DONE-{number}-OK"
        typed(f"{command}; echo DONE-{number}-O''K\r")  # the echoed input reads O''K, so only the command's output matches the marker
        while marker.encode() not in screen:
            assert time.monotonic() < deadline, f"{command!r} never finished:\n{screen.decode(errors='replace')[-3000:]}"
            time.sleep(0.2)
    typed("exit\r")
    reader.join(timeout=120)
    sock.close()
    while not s.attempt(attempt_id)["sealed"]:
        assert time.monotonic() < deadline, "the session never sealed"
        time.sleep(0.5)
    return attempt_id, screen.decode(errors="replace")


def remember_agent(s: st.Stack) -> tuple[str, str]:
    """Install myagent in a Terminal session and run it there as `rush myagent --version`, then wait until the worker advertises it:
    (the session's attempt id, what its terminal showed)."""
    encoded = base64.b64encode(AGENT.read_bytes()).decode()
    session_id, screen = terminal_session(s, [
        f"mkdir -p .rush/python/bin && echo {encoded} | base64 -d > .rush/python/bin/myagent && chmod +x .rush/python/bin/myagent",
        "rush myagent --version",
    ])  # fmt: skip
    (s.logs / "session-terminal.log").write_text(screen)
    # The worker advertises the remembered agent with the next claim it makes after the session is kept.
    st.wait_until(lambda: s.row("select exists(select 1 from benchmark_worker_capability where capabilities->'installed_agents' ? 'myagent')") == "t",
                  "the worker advertises myagent", 120)  # fmt: skip
    return session_id, screen


@pytest.fixture(scope="module")
def ran() -> Iterator[Ran]:
    if reason := st.skip_reason():
        pytest.skip(reason)
    with st.stack("test_rush_agent", member_computer=True) as s:
        published = s.publish("ab-report", st.AB_B_CASES)
        benchmark = s.client.benchmark(published["benchmark"]["benchmark_id"])
        session_id, screen = remember_agent(s)
        ledger = s.script(st.B_WINS, "pi", st.script_of(*st.ab_acts("b_wins"))).ledger
        [report] = s.submit("ab-report", ["rush myagent"], "rush-agent")
        [line] = report["attempts"]
        attempt, events = s.attempt(line["attempt_id"]), s.events(line["attempt_id"])
        (s.logs / "attempt.json").write_text(json.dumps({"attempt": attempt, "events": events}, indent=1))
        yield Ran(screen, s.events(session_id), report, attempt, events, ledger, benchmark)


def test_the_session_ran_the_agent_as_a_recorded_rush_run(ran: Ran) -> None:
    assert "myagent 1.0" in ran.session_screen and "rush · myagent ·" in ran.session_screen, ran.session_screen[-2000:]
    argvs = [event["data"]["argv"] for event in ran.session_events if event["kind"] == "process.exec"]
    assert any(argv[-1:] == ["--version"] and argv[0].endswith("myagent") for argv in argvs), argvs[-20:]


def test_the_benchmark_ran_with_the_members_agent_and_passed(ran: Ran) -> None:
    assert ran.report["harness"] == "rush myagent"
    assert ran.report["status"] == "complete" and ran.report["score"]["value"] == 1, ran.report
    assert (ran.attempt["execution"], ran.attempt["verdict"]) == ({"status": "answered", "reason": None}, "pass"), ran.attempt
    assert not ran.ledger.violations
    assert ran.benchmark["cases"][0]["prompt"] in st.user_texts(ran.ledger.calls[0].request)


def test_the_agent_was_started_through_rush_with_the_prompt_and_its_calls_recorded(ran: Ran) -> None:
    prompt = ran.benchmark["cases"][0]["prompt"]
    argvs = [event["data"]["argv"] for event in ran.events if event["kind"] == "process.exec"]
    assert any(argv[-2:] == ["myagent", prompt] and "rush.py" in " ".join(argv) for argv in argvs), [a[:4] for a in argvs][:12]
    assert any(argv[0].endswith("myagent") and argv[-1] == prompt for argv in argvs), [a[:4] for a in argvs][:12]
    responses = [event for event in ran.events if event["kind"] == "model_call.response"]
    assert len(responses) == len(ran.ledger.calls) >= 2
    usage = ran.ledger.usage("main", "side")
    assert (ran.attempt["metrics"]["input_tokens"], ran.attempt["metrics"]["output_tokens"]) == (usage.input, usage.output), ran.attempt["metrics"]
    [exited] = [event for event in ran.events if event["kind"] == "case.exited"]
    assert exited["data"]["termination"] == {"status": "exited", "exit_code": 0}, exited


def test_on_real_openrouter_every_attempt_seals_with_its_calls_recorded() -> None:
    """Opt-in (RUSH_ACCEPTANCE_OPENROUTER=1): the same flow on real OpenRouter (worker.openrouter.yaml's endpoint, OPENROUTER_MODEL), the
    ab-report B-wins benchmark run once by `nanoagent` and by `rush myagent`. The model may fail the task; every attempt seals with a
    verdict or a reason, and its figures are the gateway's. Each harness's figures go to openrouter-summary.json."""
    if reason := st.openrouter_skip_reason():
        pytest.skip(reason)
    with st.stack("test_rush_agent_openrouter", member_computer=True, openrouter=True) as s:
        s.publish("ab-report", st.AB_B_CASES)
        remember_agent(s)
        summary = []
        for report in s.submit("ab-report", ["nanoagent", "rush myagent"], "rush-agent-openrouter"):
            [line] = report["attempts"]
            attempt, events = s.attempt(line["attempt_id"]), s.events(line["attempt_id"])
            accounting = s.get(f"attempts/{line['attempt_id']}/accounting")
            assert accounting.status_code == 200, accounting.text
            execs = [event["data"] for event in events if event["kind"] == "process.exec"]
            summary.append({
                "harness": report["harness"], "status": report["status"], "verdict": attempt["verdict"], "execution": attempt["execution"],
                "checks": attempt.get("checks"), "metrics": attempt["metrics"], "accounting": accounting.json(),
                "model_call_responses": sum(event["kind"] == "model_call.response" for event in events),
                "process_exec": execs[:40],
            })  # fmt: skip
            (s.logs / f"attempt-{report['harness'].replace(' ', '-')}.json").write_text(json.dumps({"attempt": attempt, "events": events}, indent=1))
            assert attempt["sealed"] and (attempt["verdict"] is not None or attempt["execution"]["reason"] is not None), attempt
        (s.logs / "openrouter-summary.json").write_text(json.dumps(summary, indent=1))


# aider at a release tag, installed from its GitHub repository (a git checkout: built from an archive, setuptools_scm leaves out its data files).
AIDER = "git+https://github.com/Aider-AI/aider.git@v0.86.1"
AIDER_HARNESS = (
    f"rush aider --model openai/{st.OPENROUTER_MODEL} --yes-always --no-git --no-auto-commits --no-check-update --no-analytics "
    "--no-show-model-warnings --no-pretty --message"
)


def test_on_real_openrouter_an_agent_installed_from_its_repo_runs_a_benchmark() -> None:
    """Opt-in (RUSH_ACCEPTANCE_OPENROUTER=1): aider, pip-installed in a Terminal session from its GitHub repository and run there once as
    `rush aider --version`, runs the ab-report benchmark as `rush aider <flags> --message`. The model may fail the task; the attempt
    seals, the agent was started through rush.py with the prompt, and every model call it made went through the gateway."""
    if reason := st.openrouter_skip_reason():
        pytest.skip(reason)
    with st.stack("test_rush_agent_repo", member_computer=True, openrouter=True) as s:
        published = s.publish("ab-report", st.AB_B_CASES, limits={"workspace_bytes": 4 << 30})
        prompt = s.client.benchmark(published["benchmark"]["benchmark_id"])["cases"][0]["prompt"]
        _, screen = terminal_session(s, [
            f"PIP_BREAK_SYSTEM_PACKAGES=1 pip install --user --quiet {AIDER}",
            "rush aider --version",
        ], timeout=1800)  # fmt: skip
        (s.logs / "session-terminal.log").write_text(screen)
        assert "aider 0.86.1" in screen and "rush · aider ·" in screen, screen[-3000:]
        st.wait_until(lambda: s.row("select exists(select 1 from benchmark_worker_capability where capabilities->'installed_agents' ? 'aider')") == "t",
                      "the worker advertises aider", 120)  # fmt: skip
        [report] = s.submit("ab-report", [AIDER_HARNESS], "rush-aider")
        [line] = report["attempts"]
        attempt, events = s.attempt(line["attempt_id"]), s.events(line["attempt_id"])
        accounting = s.get(f"attempts/{line['attempt_id']}/accounting")
        (s.logs / "attempt.json").write_text(json.dumps({"report": report, "attempt": attempt, "events": events, "accounting": accounting.json()}, indent=1))
        assert report["harness"] == AIDER_HARNESS
        assert attempt["sealed"] and attempt["execution"]["status"] != "worker_error", attempt
        argvs = [event["data"]["argv"] for event in events if event["kind"] == "process.exec"]
        assert any("rush.py" in " ".join(argv) and argv[-1] == prompt and "aider" in argv for argv in argvs), [a[:6] for a in argvs][:12]
        assert any(argv[0].endswith("aider") and argv[-1] == prompt for argv in argvs), [a[:6] for a in argvs][:12]
        responses = [event for event in events if event["kind"] == "model_call.response"]
        assert responses and attempt["metrics"]["input_tokens"] > 0, attempt["metrics"]
        assert accounting.status_code == 200 and accounting.json()["calls"], accounting.text
