"""`rush <command>` in the RUSH terminal (the shell reference harness's rush.py): the program a run is named by, whether it is scored,
its title and its one line; the attempt services' `/runs/<action>` route; the runner's side of a run (`_rush_run`), which keeps its
title and verdict on its process; and the projection, which puts them on the process's span."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from nanoagent import __version__
from nanoagent.plugin.verifier import VerifierError
from nanoagent.uploaded import records as rec
from nanoagent.uploaded.attempt import ServiceError
from nanoagent.uploaded.clis import CLIS
from nanoagent.uploaded.projection_normalize import normalize, parse_records
from nanoagent.uploaded.reference import FOLDER
from nanoagent.uploaded.runner import AttemptRunner, RushRuns, run_figures
from service_fakes import make_rig

spec = importlib.util.spec_from_file_location("rush_prefix", FOLDER / "shell" / "rush.py")
rush = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rush)

PROMPT = "Task: the weather in Paris.\n\nWrite your answer to /rush/workspace/answer.json."


def test_a_run_is_named_by_its_program_as_the_dashboard_names_its_chip() -> None:
    assert rush.program_of(["aider", "--message", "hi"]) == "aider"
    assert rush.program_of(["/opt/tools/bin/aider"]) == "aider"
    assert rush.program_of(["python3.12", "-m", "aider.main", "--yes"]) == "aider.main"
    assert rush.program_of(["python", "agent.py", "-m"]) == "python"  # -m with no module after it names none
    assert rush.program_of(["npx", "-y", "@scope/tool@1.2.0", "go"]) == "tool"
    assert rush.program_of(["npx", "cowsay"]) == "cowsay"


def test_a_run_is_scored_only_when_an_argument_holds_the_tasks_exact_prompt() -> None:
    assert rush.is_scored(["aider", "--message", PROMPT], PROMPT)
    assert rush.is_scored(["sh", "-c", f"agent '{PROMPT}'"], PROMPT)  # within an argument too
    assert not rush.is_scored(["aider", "--message", PROMPT[:-1]], PROMPT)
    assert not rush.is_scored(["aider"], PROMPT)
    assert not rush.is_scored(["aider", "--message", "hi"], None)  # no prompt pinned in this terminal
    assert not rush.is_scored(["aider", ""], "")


def test_a_one_shot_run_is_titled_by_its_prompt_argument_an_interactive_one_by_the_first_line_typed() -> None:
    assert rush.prompt_argument(["aider", "--model", "x", "--message", "list three   ids"]) == "list three ids"
    assert rush.prompt_argument(["aider", "notes.md"]) is None
    assert len(rush.prompt_argument(["claude", "-p", "word " * 100])) == rush.TITLE_CHARS
    first = rush.FirstLine()
    assert first.feed(b"\x1b[Alist thrx") is None  # an arrow key, then typing
    assert first.feed(b"\x7fee ids\r") == "list three ids"
    assert first.feed(b"later\r") is None  # only the first line
    assert rush.FirstLine().feed(b"\r\r  \rgo\r") == "go"  # Enter on an empty line is no line


def test_the_summary_line_says_time_tokens_and_cost_and_a_scored_runs_verdict() -> None:
    ran = {"input_tokens": 152_300, "output_tokens": 612, "cost_usd": 0.011}
    assert rush.summary_line("aider", 48.2, ran) == "rush · aider · 48 s · 152.3k/612 tokens · $0.0110"
    assert rush.summary_line("aider", 48.2, ran | {"verdict": "right"}) == "rush · aider · right · 48 s · 152.3k/612 tokens · $0.0110"
    assert rush.summary_line("aider", 0.4, {"input_tokens": 0, "output_tokens": 0, "cost_usd": None}) == "rush · aider · 0 s · 0/0 tokens · $—"


def test_rush_help_says_the_prefix_and_its_scored_form() -> None:
    assert 'rush <command> "$RUSH_PROMPT"' in rush.HELP and "rush <command>  runs" in rush.HELP
    for gone in ("rush save", "rush score", "Leaderboard"):
        assert gone not in rush.HELP


def test_each_terminal_cli_is_its_reference_harness_at_the_version_its_lock_pins() -> None:
    assert {name: (cli.reference, cli.version()) for name, cli in CLIS.items()} == {
        "nanoagent": ("nanoagent", __version__), "claude": ("claude-code", "2.1.325"), "codex": ("codex", "0.167.0"), "pi": ("pi", "0.84.4"),
        "dsh": ("dsh", "0.2.2-rc.1"), "hermes": ("hermes", "0.19.0"),
    }  # fmt: skip
    claude, nanoagent = CLIS["claude"], CLIS["nanoagent"]
    assert claude.key("node@sha256:a", "s1") == claude.key("node@sha256:a", "s2") != claude.key("node@sha256:b", "s1")  # one install per lock, image and machine
    assert nanoagent.key("python@sha256:a", "s1") != nanoagent.key("python@sha256:a", "s2")  # and NanoAgent's per its own source too


async def test_the_services_stream_a_cli_install_one_json_line_per_event(tmp_path: Path) -> None:
    asked: list[str] = []

    async def install(name: str) -> Any:
        asked.append(name)
        yield {"installing": "Claude Code", "version": "2.1.325"}
        yield {"path": "/opt/rush/clis/k/harness", "key": "k"}

    rig = make_rig(tmp_path, install_cli=install)
    async with rig.client() as client:
        answered = await client.post("/cli", json={"name": "claude"})
        assert answered.status_code == 200 and [json.loads(line) for line in answered.text.splitlines()] == [
            {"installing": "Claude Code", "version": "2.1.325"}, {"path": "/opt/rush/clis/k/harness", "key": "k"},
        ]  # fmt: skip
        assert (await client.post("/cli", json={"name": 3})).status_code == 400
        assert (await client.post("/cli", json={"name": "claude"}, headers={"authorization": "Bearer nope"})).status_code == 401
    assert asked == ["claude"]


async def test_the_services_hand_each_run_request_to_the_runner(tmp_path: Path) -> None:
    asked: list[tuple[str, dict[str, Any]]] = []

    async def run(action: str, body: dict[str, Any]) -> dict[str, Any]:
        asked.append((action, body))
        if body.get("run") == "gone":
            raise ServiceError(404, "unknown_run", "no run under way here has that id")
        return {"run": "r1"}

    rig = make_rig(tmp_path, rush_run=run)
    async with rig.client() as client:
        assert (await client.post("/runs/start", json={"pid": 7, "title": None})).json() == {"run": "r1"}
        assert (await client.post("/runs/end", json={"run": "gone"})).status_code == 404
        assert (await client.post("/runs/save", json={})).status_code == 404
        assert (await client.post("/runs/start", json={}, headers={"authorization": "Bearer nope"})).status_code == 401
    assert asked == [("start", {"pid": 7, "title": None}), ("end", {"run": "gone"})]


def response(at: int, input_tokens: int, output_tokens: int, cost: str | None) -> dict[str, Any]:
    return {"kind": "model_call.response", "occurred_ns": at, "data": {"usage": {"input": input_tokens, "output": output_tokens}, "settlement": {"cost_usd": cost}}}


def test_a_runs_figures_are_its_calls_answered_while_it_ran() -> None:
    records = [response(5, 100, 10, "0.001"), response(15, 200, 20, "0.002"), response(25, 400, 40, "0.004"), {"kind": "model_call.admitted", "occurred_ns": 16, "data": {}}]
    assert run_figures(records, 10, 30) == {"input_tokens": 600, "output_tokens": 60, "cost_usd": pytest.approx(0.006)}
    assert run_figures([*records, response(20, 1, 1, None)], 10, 30)["cost_usd"] is None  # a call not settled
    assert run_figures(records, 30, 40) == {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}


class Runs:
    """The runner's side of a session's `rush` runs, with a fake worker, clock, journal and verifier."""

    def __init__(self, tmp_path: Path, verdict: str = "pass") -> None:
        self.emitted: list[rec.Fact] = []
        self.clock = iter(range(100, 10_000, 100))
        self.journal = SimpleNamespace(records=[response(150, 1200, 30, "0.0021")])
        self.workspace = tmp_path
        self.verified: list[tuple[Any, ...]] = []
        case = {"case_id": "c1", "kind": "answer", "arguments": {"city": "Paris"}, "reference": {"temp": 20}}
        pinned = {"case": case, "prompt": PROMPT, "plugin": {"id": "city-weather", "sha256": "s"}, "task": {"id": "weather"}, "package": ""}

        async def score_case(attempt_id: str, fence: int) -> dict[str, Any]:
            return pinned

        def verify(manifest: Any, task_id: str, arguments: dict, outcome: dict, reference: Any, workspace: Path) -> Any:
            self.verified.append((task_id, arguments, outcome, reference, workspace))
            if verdict == "error":
                raise VerifierError("broken")
            return SimpleNamespace(verdict=verdict, explanation="20 °C is right" if verdict == "pass" else "off by 3")

        self.runner = SimpleNamespace(
            worker=SimpleNamespace(score_case=score_case), clock_ns=lambda: next(self.clock), verify_task_case=verify,
            _plugin=lambda plugin, package, work, tooled: "manifest",
        )  # fmt: skip
        self.runner._score_case = lambda job, runs, work: AttemptRunner._score_case(self.runner, job, runs, work)
        self.runs = RushRuns()

    async def __call__(self, action: str, body: dict[str, Any]) -> Any:
        async def emit(fact: rec.Fact) -> None:
            self.emitted.append(fact)

        async def flush() -> None:
            pass

        return await AttemptRunner._rush_run(
            self.runner, SimpleNamespace(attempt_id="a0", fence=3), self.runs, SimpleNamespace(emit=emit), self.journal, SimpleNamespace(flush=flush),
            SimpleNamespace(handle=SimpleNamespace(workspace=self.workspace)), self.workspace, action, body,
        )  # fmt: skip


async def test_an_interactive_run_is_titled_by_its_first_line_and_ends_with_what_its_calls_took(tmp_path: Path) -> None:
    runs = Runs(tmp_path)
    run = (await runs("start", {"pid": 42, "title": None}))["run"]
    assert runs.emitted == []
    assert await runs("title", {"run": run, "title": "list three ids"}) == {}
    assert await runs("end", {"run": run, "exit_code": 0, "scored": False}) == {"input_tokens": 1200, "output_tokens": 30, "cost_usd": pytest.approx(0.0021)}
    assert runs.emitted == [rec.ProcessRush(42, 200, title="list three ids")]
    assert runs.verified == []  # an unscored run is not verified
    with pytest.raises(ServiceError, match="no run under way"):
        await runs("end", {"run": run, "exit_code": 0, "scored": False})


async def test_a_scored_run_is_verified_on_the_answer_it_left_and_its_verdict_kept_on_its_process(tmp_path: Path) -> None:
    runs = Runs(tmp_path)
    assert await runs("prompt", {}) == {"prompt": PROMPT}
    (tmp_path / "answer.json").write_text('{"temp": 20}')
    run = (await runs("start", {"pid": 42, "title": "the weather"}))["run"]
    ended = await runs("end", {"run": run, "exit_code": 0, "scored": True})
    assert ended == {"input_tokens": 1200, "output_tokens": 30, "cost_usd": pytest.approx(0.0021), "verdict": "right", "explanation": "20 °C is right"}
    assert runs.verified == [("weather", {"city": "Paris"}, {"status": "answered", "answer": {"temp": 20}}, {"temp": 20}, tmp_path)]
    assert runs.emitted == [rec.ProcessRush(42, 100, title="the weather"), rec.ProcessRush(42, 300, verdict="right")]


async def test_a_scored_run_that_failed_or_wrote_no_answer_is_scored_on_that(tmp_path: Path) -> None:
    runs = Runs(tmp_path, verdict="fail")
    await runs("prompt", {})
    run = (await runs("start", {"pid": 42, "title": None}))["run"]
    assert (await runs("end", {"run": run, "exit_code": 0, "scored": True}))["verdict"] == "wrong"
    run = (await runs("start", {"pid": 43, "title": None}))["run"]
    await runs("end", {"run": run, "exit_code": 2, "scored": True})
    assert [outcome for _, _, outcome, _, _ in runs.verified] == [
        {"status": "execution_failed", "reason": "missing_result"}, {"status": "execution_failed", "reason": "nonzero_exit"},
    ]  # fmt: skip


async def test_a_scored_run_needs_the_tasks_prompt_pinned_and_a_working_verifier(tmp_path: Path) -> None:
    runs = Runs(tmp_path, verdict="error")
    run = (await runs("start", {"pid": 42, "title": None}))["run"]
    with pytest.raises(ServiceError, match="not pinned the task's prompt"):
        await runs("end", {"run": run, "exit_code": 0, "scored": True})
    await runs("prompt", {})
    run = (await runs("start", {"pid": 42, "title": None}))["run"]
    with pytest.raises(ServiceError, match="verifier failed"):
        await runs("end", {"run": run, "exit_code": 0, "scored": True})


def test_the_projection_puts_a_runs_title_and_verdict_on_the_process_that_ran_then() -> None:
    facts = [
        (rec.ProcessExec(42, 1, ["python", "/harness/rush.py", "run", "aider"], "/rush/workspace", 10), 10),
        (rec.ProcessExit(42, 1, 50), 50),
        (rec.ProcessExec(42, 2, ["sleep", "1"], "/rush/workspace", 60), 60),  # the pid used again, after the run
        (rec.ProcessRush(42, 20, title="list three ids"), 20),
        (rec.ProcessRush(42, 40, verdict="right"), 40),
    ]
    raw = [rec.make_record(fact, event_id=f"e{n}", sequence=n, occurred_ns=at) for n, (fact, at) in enumerate(facts, 1)]
    records, issues = parse_records(raw)
    processes = {p.identity: p for p in normalize(records, {}, issues).processes}
    assert (processes[(42, 1)].title, processes[(42, 1)].verdict) == ("list three ids", "right")
    assert (processes[(42, 2)].title, processes[(42, 2)].verdict) == (None, None)


def test_a_run_passes_its_output_through_and_exits_as_its_command_did(capfd: pytest.CaptureFixture[str]) -> None:
    assert rush.interact(["sh", "-c", "test -t 0 && test -t 1 && echo ran on a tty: yes; exit 3"], lambda data: None) == 3
    assert "ran on a tty: yes" in capfd.readouterr().out
    assert rush.interact(["sh", "-c", "kill -TERM $$"], lambda data: None) == 128 + 15
