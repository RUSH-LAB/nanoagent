"""Shared pieces of the gateway-and-hosted-tools and complete-trace gates: the scripted harness, benchmarks of the workspace-tools
plugin (the task's tools are the agent's tools), submitting through step 2, reading a sealed trace (and the harness's own report of what each
service answered) through step 3, and a worker whose upstream and endpoint label are chosen by its YAML."""

from __future__ import annotations

import json
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from slimconfig import load_layout

import support
from support import Cli, VmWorker

NANOAGENT = support.NANOAGENT
SCRIPTED = Path(__file__).resolve().parent / "harnesses" / "scripted"
ANTHROPIC_SDK = Path(__file__).resolve().parent / "harnesses" / "anthropic_sdk"
PLUGIN = NANOAGENT / "test" / "plugins" / "workspace-tools"
PLUGIN_ID = "workspace-tools"
SOCKET = "/run/rush-gvisor/seccheck.sock"
sys.path[:0] = [str(NANOAGENT / "examples" / "uploaded_benchmark"), str(NANOAGENT / "examples" / "benchmark")]

if TYPE_CHECKING:
    from mockllm import RunHandle

import step2_submit_run  # noqa: E402
import step3_trace  # noqa: E402


def scripted_source(destination: Path, steps: list[dict[str, Any]], *, root: bool = True) -> Path:
    """The scripted harness with ``steps`` as its script.json; `submit` stamps its manifest."""
    shutil.copytree(SCRIPTED, destination)
    (destination / "script.json").write_text(json.dumps({"root": root, "steps": steps}))
    return destination


def sdk_source(destination: Path) -> Path:
    """The Anthropic SDK harness as it is (it has no script)."""
    shutil.copytree(ANTHROPIC_SDK, destination)
    return destination


def note_plugin(destination: Path) -> Path:
    """The workspace-tools plugin with the `note` task given every tool the gates call but its reference tool `expected_note` (and
    `read_fixture`), which an agent must never be given."""
    shutil.copytree(PLUGIN, destination, ignore=shutil.ignore_patterns(".venv", "__pycache__", "*.egg-info", ".ruff_cache", ".pytest_cache"))
    manifest = destination / "nanoagent.yaml"
    text = manifest.read_text()
    assert "    tools: [write_note]\n" in text
    # A tool task has exactly one tool: the gates need an agent task over several.
    manifest.write_text(text.replace("    tools: [write_note]\n", "    tools: [write_note, copy_fixture, inspect_sandbox]\n").replace("    runner: tool\n", "    runner: agent\n"))
    return destination


def publish_note_benchmark(cli: Cli, run_dir: Path, name: str, note: str, text: str, context: str = "", *, endpoint: str = "mock", key: str | None = None) -> str:
    """Step 1: a one-case benchmark of the note task served by endpoint ``endpoint``; returns its name.

    ``context`` is part of every coding prompt and the task instructions end with ``<<key>>`` (the name unless given), so a scripted
    upstream serving several benchmarks at once can tell their requests apart.
    """
    cases = run_dir / f"{name}-cases.json"
    cases.write_text(
        json.dumps(
            {
                "_": "step2_single_run.Cases",
                "plugin": PLUGIN_ID,
                "task": "note",
                "context": f"Write the note the input names into the workspace, then answer with its path and size. {context}".strip(),
                "answer": [{"name": note, "text": text}],
                "refuse": [],
            }
        )
    )
    instructions = f"Write the note the input names into the workspace, then answer with its path and size. <<{key or name}>>"
    cli.step("1", "publish_benchmark", run_dir / f"step1-{name}", *support.publish_args(name=name, cases=cases, endpoint=endpoint, instructions=instructions))
    return name


def submit(cli: Cli, run_dir: Path, folder: Path, benchmark: str, key: str, *, follow: bool = True, dialects: str = "chat_completions") -> Any:
    """Step 2 under the task tools policy, with the benchmark's one case: the run's report. The harness declares ``dialects``."""
    home = run_dir / f"step2-{key}"
    support.stamp(folder, dialects=dialects.split(","))
    cli.step("2", "submit_run", home, *support.submit_args(benchmark, plugin=PLUGIN_ID, key=key, source=folder, follow=follow))
    return load_layout(home, step2_submit_run.RunLayout).run


def read_trace(cli: Cli, attempt: str, home: Path, *payloads: str) -> Any:
    cli.step("3", "trace", home, f"attempt_id={attempt}", *([f"payloads=[{','.join(payloads)}]"] if payloads else []))
    return load_layout(home, step3_trace.TraceLayout).trace


def fetch_payloads(cli: Cli, attempt: str, digests: list[str], folder: Path) -> dict[str, bytes]:
    """The payloads with these digests through step 3 (a few per process: an override must stay a short argument)."""
    found: dict[str, bytes] = {}
    for number in range(0, len(digests), 3):
        batch = digests[number : number + 3]
        home = folder / f"batch{number // 3}"
        read_trace(cli, attempt, home, *batch)
        found |= {digest: (home / "payloads" / digest).read_bytes() for digest in batch}
    return found


def report_digest(trace: Any) -> str:
    """The digest of the payload holding the harness's report: what every service answered each step."""
    logs = [e for e in trace.events if e["kind"] == "harness.event" and e["data"]["event"] == "log"]
    return logs[-1]["data"]["event_sha256"]  # the harness sends its report last, after every step (a step may send logs of its own)


def observations(trace: Any, payloads: dict[str, bytes]) -> list[dict[str, Any]]:
    """The scripted harness's observations, in script order (parallel steps in the order they finished)."""
    return json.loads(json.loads(payloads[report_digest(trace)])["message"])


def start_worker(
    name: str, rush_url: str, cli: Cli, run_dir: Path, *, upstream: str, index: int, label: str = "mock", entry: tuple[str, ...] | None = None, env: dict[str, str] | None = None
) -> VmWorker:
    """The real worker in the VM; only its YAML (upstream, label) differs between workers."""
    config = run_dir / f"{name}.yaml"
    options: dict[str, Any] = {} if entry is None else {"entry": entry}
    worker = VmWorker(name, config, cli.logs / f"{name}-worker.log", env=env, **options)
    text = support.worker_yaml(
        base_url=f"http://{support.HOST}:{rush_url.rsplit(':', 1)[1]}",
        upstream=upstream.replace("127.0.0.1", support.HOST),
        index=f"http://{support.HOST}:{index}/simple",
        socket=SOCKET,
        scratch=f"{worker.vm_home}/scratch",
    )
    assert "  label: mock\n" in text
    config.write_text(text.replace("  label: mock\n", f"  label: {label}\n", 1))
    worker.start()
    return worker


@dataclass
class Evidence:
    run: Any  # step 2's RunReport
    attempt_id: str
    trace: Any  # step 3's Trace
    payloads: dict[str, bytes]
    handle: RunHandle | None

    @property
    def attempt(self) -> Any:
        return self.run.attempts[0]

    def events(self, kind: str) -> list[dict[str, Any]]:
        return [event for event in self.trace.events if event["kind"] == kind]

    def payload(self, digest: str) -> Any:
        return json.loads(self.payloads[digest])

    @property
    def observed(self) -> list[dict[str, Any]]:
        return observations(self.trace, self.payloads)

    def where(self, **fields: Any) -> list[dict[str, Any]]:
        return [o for o in self.observed if all(o.get(key) == value for key, value in fields.items())]

    def rejected(self, kind: str) -> list[str]:
        """The codes of the rejection events of ``kind`` in the order they were recorded."""
        return [event["data"]["code"] for event in self.events(kind)]

    def inspected(self) -> list[dict[str, Any]]:
        """What each `inspect_sandbox` call reported from inside the tool sandbox."""
        return [
            self.payload(event["data"]["output_sha256"])
            for event in self.events("tool.completed")
            if event["data"]["tool"] == "inspect_sandbox" and event["data"]["ok"]
        ]




def collect(cli: Cli, run_dir: Path, run: Any, handle: RunHandle | None, name: str, *extra: str) -> Evidence:
    """A sealed attempt's trace and the payloads the gates assert on: the harness's report, every tool output and ``extra`` digests."""
    attempt = run.attempts[0].attempt_id
    trace = read_trace(cli, attempt, run_dir / f"trace-{name}")
    digests = {*extra}
    if any(e["kind"] == "harness.event" and e["data"]["event"] == "log" for e in trace.events):  # the SDK harness sends no events
        digests.add(report_digest(trace))
    digests |= {e["data"]["output_sha256"] for e in trace.events if e["kind"] == "tool.completed" and e["data"].get("output_sha256")}
    payloads = fetch_payloads(cli, attempt, sorted(digests), run_dir / f"payloads-{name}")
    return Evidence(run, attempt, trace, payloads, handle)
