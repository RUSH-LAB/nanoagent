"""`rush <command>` in the RUSH terminal (the shell reference harness's rush.py): the program a run is named by, its title and its one
line; the attempt services' `/runs/<action>` route; the runner's side of a run (`_rush_run`), which keeps its title on its process and
remembers its program for the member (RememberedAgents), and the terminal's bash, which runs a remembered program typed plain as
`rush <program>`; and the projection, which puts a run's id and title on the process's span."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from nanoagent import __version__
from nanoagent.uploaded import records as rec
from nanoagent.uploaded.attempt import ServiceError
from nanoagent.uploaded.clis import CLIS
from nanoagent.uploaded.projection_normalize import normalize, parse_records
from nanoagent.uploaded.reference import FOLDER
from nanoagent.uploaded.runner import AttemptRunner, RememberedAgents, RushRuns, run_figures
from service_fakes import make_rig

spec = importlib.util.spec_from_file_location("rush_prefix", FOLDER / "shell" / "rush.py")
rush = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rush)

def test_a_run_is_named_by_its_program_as_the_dashboard_names_its_chip() -> None:
    assert rush.program_of(["aider", "--message", "hi"]) == "aider"
    assert rush.program_of(["/opt/tools/bin/aider"]) == "aider"
    assert rush.program_of(["python3.12", "-m", "aider.main", "--yes"]) == "aider.main"
    assert rush.program_of(["python", "agent.py", "-m"]) == "python"  # -m with no module after it names none
    assert rush.program_of(["npx", "-y", "@scope/tool@1.2.0", "go"]) == "tool"
    assert rush.program_of(["npx", "cowsay"]) == "cowsay"


def test_a_one_shot_run_is_titled_by_its_prompt_argument_an_interactive_one_by_the_first_line_typed() -> None:
    assert rush.prompt_argument(["aider", "--model", "x", "--message", "list three   ids"]) == "list three ids"
    assert rush.prompt_argument(["aider", "notes.md"]) is None
    assert len(rush.prompt_argument(["claude", "-p", "word " * 100])) == rush.TITLE_CHARS
    first = rush.FirstLine()
    assert first.feed(b"\x1b[Alist thrx") is None  # an arrow key, then typing
    assert first.feed(b"\x7fee ids\r") == "list three ids"
    assert first.feed(b"later\r") is None  # only the first line
    assert rush.FirstLine().feed(b"\r\r  \rgo\r") == "go"  # Enter on an empty line is no line


def test_the_summary_line_says_time_tokens_cost_and_rejected_calls() -> None:
    ran = {"input_tokens": 152_300, "output_tokens": 612, "cost_usd": 0.011}
    assert rush.summary_line("aider", 48.2, ran) == "rush · aider · 48 s · 152.3k/612 tokens · $0.0110"
    assert rush.summary_line("aider", 0.4, {"input_tokens": 0, "output_tokens": 0, "cost_usd": None}) == "rush · aider · 0 s · 0/0 tokens · $—"
    rejected = ran | {"rejected": ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-sonnet-4-5"]}
    assert rush.summary_line("aider", 48.2, rejected) == "rush · aider · 48 s · 152.3k/612 tokens · $0.0110 · 3 calls rejected: asked for claude-haiku-4-5, claude-sonnet-4-5"
    assert rush.summary_line("aider", 48.2, ran | {"rejected": ["x/y"]}).endswith(" · 1 call rejected: asked for x/y")


def test_rush_help_says_the_prefix_and_forget_and_nothing_of_scoring() -> None:
    assert "rush <command>  runs" in rush.HELP and "rush forget <program>" in rush.HELP
    for gone in ("RUSH_PROMPT", "scored", "rush save", "Leaderboard"):
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
        assert (await client.post("/runs/start", json={"pid": 7, "title": None, "command": "aider"})).json() == {"run": "r1"}
        assert (await client.post("/runs/end", json={"run": "gone"})).status_code == 404
        assert (await client.post("/runs/forget", json={"program": "aider"})).status_code == 200
        for gone in ("save", "prompt"):
            assert (await client.post(f"/runs/{gone}", json={})).status_code == 404
        assert (await client.post("/runs/start", json={}, headers={"authorization": "Bearer nope"})).status_code == 401
    assert asked == [("start", {"pid": 7, "title": None, "command": "aider"}), ("end", {"run": "gone"}), ("forget", {"program": "aider"})]


def call(call_id: str, run: str | None, input_tokens: int, output_tokens: int, cost: str | None) -> list[dict[str, Any]]:
    """A model call's admission, under the run its token named, and its response."""
    return [
        {"kind": "model_call.admitted", "occurred_ns": 0, "data": {"call_id": call_id, "run": run}},
        {"kind": "model_call.response", "occurred_ns": 0, "data": {"call_id": call_id, "usage": {"input": input_tokens, "output": output_tokens}, "settlement": {"cost_usd": cost}}},
    ]


def test_two_overlapping_runs_each_get_only_the_calls_their_process_trees_made() -> None:
    # Runs r1 and r2 at once in two terminals, their calls interleaved, beside a listed agent's call that names no run.
    records = [*call("c1", "r1", 100, 10, "0.001"), *call("c2", "r2", 200, 20, "0.002"), *call("c3", None, 800, 80, "0.008"), *call("c4", "r1", 400, 40, "0.004")]
    assert run_figures(records, "r1") == {"input_tokens": 500, "output_tokens": 50, "cost_usd": pytest.approx(0.005), "rejected": []}
    assert run_figures(records, "r2") == {"input_tokens": 200, "output_tokens": 20, "cost_usd": pytest.approx(0.002), "rejected": []}
    assert run_figures([*records, *call("c5", "r2", 1, 1, None)], "r2")["cost_usd"] is None  # a call not settled
    assert run_figures(records, "r3") == {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "rejected": []}


def test_a_runs_figures_name_the_models_its_refused_calls_asked_for() -> None:
    def rejected(run: str | None, code: str, model: str | None) -> dict:
        return {"kind": "model_call.rejected", "occurred_ns": 0, "data": {"code": code, "requested_model": model, "run": run}}

    records = [rejected("r2", "model_not_pinned", "another run's"), rejected("r1", "model_not_pinned", "claude-sonnet-4-5"), rejected("r1", "output_cap_exceeded", None)]
    assert run_figures(records, "r1")["rejected"] == ["claude-sonnet-4-5"]


class Runs:
    """The runner's side of a session's `rush` runs, with a fake clock and journal, its workspace and its computer's scratch folder."""

    def __init__(self, tmp_path: Path, agents: RememberedAgents | None = None) -> None:
        self.emitted: list[rec.Fact] = []
        self.clock = iter(range(100, 10_000, 100))
        self.journal = SimpleNamespace(records=[])
        self.workspace = tmp_path / "workspace"
        self.workspace.mkdir()
        self.agents = agents or RememberedAgents(tmp_path)
        self.agents.attach(self.workspace)
        self.runner = SimpleNamespace(clock_ns=lambda: next(self.clock), agents=self.agents)
        self.runs = RushRuns()

    async def __call__(self, action: str, body: dict[str, Any]) -> Any:
        async def emit(fact: rec.Fact) -> None:
            self.emitted.append(fact)

        async def flush() -> None:
            pass

        return await AttemptRunner._rush_run(self.runner, self.runs, SimpleNamespace(emit=emit), self.journal, SimpleNamespace(flush=flush), action, body)

    def called(self, run: str) -> None:
        """Run ``run``'s process tree made a call."""
        self.journal.records += call(f"c{len(self.journal.records)}", run, 1200, 30, "0.0021")

    def listed(self) -> str:
        return (self.workspace / ".rush" / "agents").read_text()


async def test_a_run_is_recorded_titled_and_ends_with_what_its_calls_took_and_nothing_scores_it(tmp_path: Path) -> None:
    runs = Runs(tmp_path)
    (runs.workspace / "answer.json").write_text('{"temp": 20}')  # an answer left in the workspace is no one's to score
    run = (await runs("start", {"pid": 42, "title": None, "command": "aider"}))["run"]
    assert runs.emitted == [rec.ProcessRush(42, 100, run=run)]
    runs.called(run)
    assert await runs("title", {"run": run, "title": "list three ids"}) == {}
    assert await runs("end", {"run": run, "exit_code": 0}) == {"input_tokens": 1200, "output_tokens": 30, "cost_usd": pytest.approx(0.0021), "rejected": []}
    assert runs.emitted == [rec.ProcessRush(42, 100, run=run), rec.ProcessRush(42, 200, title="list three ids")]
    with pytest.raises(ServiceError, match="no run under way"):
        await runs("end", {"run": run, "exit_code": 0})


async def test_a_runs_program_is_remembered_for_the_member_in_a_new_session_and_forgotten(tmp_path: Path) -> None:
    scratch = tmp_path / "scratch"
    for folder in ("scratch", "s1", "s2", "s3"):
        (tmp_path / folder).mkdir()
    first = Runs(tmp_path / "s1", RememberedAgents(scratch))
    for command in ("aider", "./agent.py", "claude", "rush", "aider", "goose"):  # a path, a listed CLI and the shell's own are not
        await first("start", {"pid": 42, "title": None, "command": command})
    assert first.listed() == "aider\ngoose\n"
    assert Runs(tmp_path / "s3", RememberedAgents(scratch)).listed() == "aider\ngoose\n"  # after the worker restarts too
    second = Runs(tmp_path / "s2", first.agents)  # a new session beside the first, its workspace fresh
    assert second.listed() == "aider\ngoose\n"
    await second("forget", {"program": "aider"})
    assert first.listed() == second.listed() == "goose\n"  # every live session's list follows
    first.agents.detach(first.workspace)
    await second("forget", {"program": "goose"})
    assert second.listed() == "" and first.listed() == "goose\n"  # an ended session's is no longer written
    with pytest.raises(ServiceError, match="aider is not a remembered program"):
        await second("forget", {"program": "aider"})


BASHRC = FOLDER / "shell" / "bashrc"


def bash(workspace: Path, script: str, tmp_path: Path) -> str:
    """``script`` run in the terminal's bash (its bashrc), `rush` and `python` logging how they were run instead of running."""
    logged = tmp_path / "ran.log"
    preamble = f"""rush() {{ echo "rush $*" >> {logged}; }}
python() {{ echo "python $*" >> {logged}; }}
"""
    rc = tmp_path / "rc"
    rc.write_text(BASHRC.read_text().replace("rush() {\n  command python /harness/rush.py run \"$@\"\n}\n", preamble))
    subprocess.run(
        ["bash", "--rcfile", str(rc), "-i"], input=script, text=True, env={"PATH": os.environ["PATH"], "RUSH_WORKSPACE": str(workspace), "HOME": str(tmp_path)},
        capture_output=True, check=True, timeout=30,
    )  # fmt: skip
    return logged.read_text() if logged.is_file() else ""


def test_a_remembered_program_typed_plain_runs_as_rush_once_and_a_forgotten_one_as_itself(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    (workspace / ".rush").mkdir(parents=True)
    agents = workspace / ".rush" / "agents"
    agents.write_text("goose\n")
    # goose typed plain is one rush run; aider is not remembered until the list says so, which every prompt reads again.
    script = f"""aider --version
goose run --text 'hi'
printf 'aider\\n' > {agents}
:
aider --yes
goose --version
exit 0
"""
    assert bash(workspace, script, tmp_path) == "rush goose run --text hi\nrush aider --yes\n"


def test_the_projection_puts_a_runs_id_and_title_on_the_process_that_ran_then() -> None:
    facts = [
        (rec.ProcessExec(42, 1, ["python", "/harness/rush.py", "run", "aider"], "/rush/workspace", 10), 10),
        (rec.ProcessExit(42, 1, 50), 50),
        (rec.ProcessExec(42, 2, ["sleep", "1"], "/rush/workspace", 60), 60),  # the pid used again, after the run
        (rec.ProcessRush(42, 15, run="r1"), 15),
        (rec.ProcessRush(42, 20, title="list three ids"), 20),
    ]
    raw = [rec.make_record(fact, event_id=f"e{n}", sequence=n, occurred_ns=at) for n, (fact, at) in enumerate(facts, 1)]
    records, issues = parse_records(raw)
    processes = {p.identity: p for p in normalize(records, {}, issues).processes}
    assert (processes[(42, 1)].title, processes[(42, 1)].run) == ("list three ids", "r1")
    assert (processes[(42, 2)].title, processes[(42, 2)].run) == (None, None)


def test_a_runs_id_said_before_the_guest_clock_saw_its_process_start_is_still_that_processs() -> None:
    facts = [
        (rec.ProcessExec(42, 1, ["sleep", "1"], "/rush/workspace", 10), 10),
        (rec.ProcessExit(42, 1, 20), 20),  # the pid's earlier process, ended before the run began
        (rec.ProcessRush(42, 95, run="r1"), 95),  # the worker's clock, behind the guest's that stamped the run's start
        (rec.ProcessExec(42, 2, ["python", "/harness/rush.py", "run", "aider"], "/rush/workspace", 100), 100),
        (rec.ProcessRush(42, 300, title="y"), 300),
    ]
    raw = [rec.make_record(fact, event_id=f"e{n}", sequence=n, occurred_ns=at) for n, (fact, at) in enumerate(facts, 1)]
    records, issues = parse_records(raw)
    processes = {p.identity: p for p in normalize(records, {}, issues).processes}
    assert (processes[(42, 2)].title, processes[(42, 2)].run) == ("y", "r1")
    assert (processes[(42, 1)].title, processes[(42, 1)].run) == (None, None)


def test_a_runs_command_holds_a_key_naming_the_run_wherever_the_token_was(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    for name in ("RUSH_ATTEMPT_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.setenv(name, "tok")
    monkeypatch.setenv("RUSH_MODEL", "tok-model")
    monkeypatch.setenv("RUSH_WORKSPACE", str(tmp_path))
    (tmp_path / ".rush").mkdir()  # the session's own folder, which the worker made as it started
    monkeypatch.setattr(rush, "service", lambda path, body: {"run": "r1", "agents": ["aider"]} if path == "/runs/start" else {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0})
    seen: dict[str, str] = {}
    monkeypatch.setattr(rush, "interact", lambda argv, heard: seen.update(os.environ) or 0)
    with pytest.raises(SystemExit):
        rush.run(["sh"])
    assert [seen[name] for name in ("RUSH_ATTEMPT_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "RUSH_MODEL")] == ["tok.r1", "tok.r1", "tok.r1", "tok-model"]
    assert (tmp_path / ".rush" / "agents").read_text() == "aider\n"  # the remembered programs, written again from inside the VM


def test_a_run_passes_its_output_through_and_exits_as_its_command_did(capfd: pytest.CaptureFixture[str]) -> None:
    assert rush.interact(["sh", "-c", "test -t 0 && test -t 1 && echo ran on a tty: yes; exit 3"], lambda data: None) == 3
    assert "ran on a tty: yes" in capfd.readouterr().out
    assert rush.interact(["sh", "-c", "kill -TERM $$"], lambda data: None) == 128 + 15
