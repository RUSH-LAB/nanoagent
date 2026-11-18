"""`nanoagent harness`: the plugin page's Harness tab in a terminal. A plugin's task is worked once by one reference harness on
the member's own worker, and the run folder gets its result and recording.

    nanoagent harness plugin=city-weather harness=claude-code                         # interactive: the CLI's own screen here
    nanoagent harness plugin=city-weather harness=codex prompt="Which cities had …"   # one-shot, for scripts

It goes through the RUSH that RUSH Lab on this computer is connected to, as the tab does (POST /api/benchmark/sessions and the
attempt's terminal, docs/contracts/rush-benchmark-api.md): RUSH pins the case on the member's computer, queues the run, and RUSH
Lab's worker claims it and runs the harness in microsandbox with its gateway, strace and the plugin's verifier, on the OpenRouter
key RUSH Lab keeps. This command signs in with RUSH Lab's connection (its `site` and `runner-credentials.json`) and never reads the
key. Without `prompt`, the first line typed is the request and the terminal is then the harness's, raw, until it exits.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import select
import shutil
import signal
import sys
import termios
import threading
import time
import tty
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from omegaconf import MISSING
from slimconfig import Config

from nanoagent.extensions import PACKAGED_CONFIGS
from nanoagent.runtime.config import load_config_args

DEFAULT_CONFIG = str(PACKAGED_CONFIGS / "harness.yaml")
# The command's names of the reference harnesses, each the one RUSH builds; rush is NanoAgent's own.
HARNESSES = {"rush": "nanoagent", "claude-code": "claude-code", "codex": "codex", "pi": "pi", "dsh": "dsh", "hermes": "hermes"}
# RUSH waits this long for the member's computer to pin the case and build the harness (helpinghands/src/server/ai.js).
START_TIMEOUT_S = 960.0
RETRY_S = 1.5


@dataclass
class HarnessCommandConfig(Config):
    # The id of a plugin installed in one of the member's workspaces.
    plugin: str = MISSING
    # rush, claude-code, codex, pi, dsh or hermes.
    harness: str = MISSING
    # The request, for a one-shot run nobody is at; null: the first line typed, and the member works at the harness's terminal.
    prompt: str | None = MISSING
    # One of the plugin's tasks; null: its first, as the tab picks it.
    task: str | None = MISSING
    # The harness's OpenRouter model; null: the one every run uses, as the tab's.
    model: str | None = MISSING
    # The run folder; null: <lab>/connections/<id>/runs/<plugin>/<time>_<harness>.
    home: str | None = MISSING
    # The slug of the workspace whose plugin to run; null: the one workspace that has it installed.
    workspace: str | None = MISSING
    # RUSH Lab's data folder, which holds its one connection.
    lab: str = MISSING


def connection(lab: Path) -> tuple[Path, str, str]:
    """RUSH Lab's one connection in its data folder ``lab``: the folder, the site and the member's session token."""
    folders = sorted(path for path in (lab / "connections").glob("*") if (path / "runner-credentials.json").is_file())
    if len(folders) != 1:
        raise SystemExit(f"harness: {lab} must hold one signed-in RUSH Lab connection; it holds {len(folders)}. Open RUSH Lab and sign in.")
    folder = folders[0]
    return folder, (folder / "site").read_text().strip(), json.loads((folder / "runner-credentials.json").read_text())["token"]


def checked(response: httpx.Response) -> Any:
    if response.is_success:
        return response.json()
    try:
        message = response.json().get("error")
    except ValueError:
        message = response.text[:200]
    raise SystemExit(f"harness: {response.request.method} {response.request.url.path}: {response.status_code} {message}")


def find_plugin(rush: httpx.Client, plugin: str, workspace: str | None) -> tuple[str, dict[str, Any]]:
    """The API prefix of the workspace with ``plugin`` installed (the one named ``workspace``, or the only one), and the app."""
    found = []
    for each in checked(rush.get("/api/workspaces"))["workspaces"]:
        if workspace is not None and each["slug"] != workspace:
            continue
        prefix = f"/api/workspaces/{each['id']}"
        found += [(prefix, each["slug"], app) for app in checked(rush.get(f"{prefix}/apps"))["apps"] if app["id"] == plugin]
    if len(found) != 1:
        where = ", ".join(slug for _, slug, _ in found) or "none of your workspaces"
        raise SystemExit(f"harness: {plugin} must be installed in one workspace; it is in {where}. Name one with workspace=<slug>.")
    return found[0][0], found[0][2]


def follow(rush: httpx.Client, prefix: str, attempt_id: str, write) -> bytes:
    """The attempt's terminal output, each chunk given to ``write`` as it comes, until the attempt is sealed: all of it."""
    seen = bytearray()
    sealed = False
    while not sealed:
        try:
            with rush.stream("GET", f"{prefix}/benchmark/attempts/{attempt_id}/terminal", params={"from": len(seen)},
                             headers={"Accept": "text/event-stream"}, timeout=httpx.Timeout(30.0, read=None)) as response:  # fmt: skip
                if response.status_code == 404:
                    raise SystemExit("harness: the session's attempt is gone")
                if not response.is_success:
                    raise httpx.HTTPStatusError(str(response.status_code), request=response.request, response=response)
                event = None
                for line in response.iter_lines():
                    if line.startswith("event: "):
                        event = line[len("event: ") :]
                    elif line.startswith("data: ") and event == "sealed":
                        sealed = True
                    elif line.startswith("data: ") and event == "output":
                        frame = json.loads(line[len("data: ") :])
                        if frame["offset"] == len(seen):
                            chunk = base64.b64decode(frame["data"])
                            seen += chunk
                            write(chunk)
            continue  # a stream that ended before the seal opens again at once from where it reached
        except (httpx.TransportError, httpx.HTTPStatusError):
            time.sleep(RETRY_S)
    return bytes(seen)


class Keyboard:
    """The member's terminal, raw, as the harness's: what is typed and each new size go to the attempt's PTY in order."""

    def __init__(self, rush: httpx.Client, path: str) -> None:
        self._rush, self._path = rush, path
        self._fd = sys.stdin.fileno()
        self._saved = termios.tcgetattr(self._fd)
        self._sends: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._done = threading.Event()
        self.error: str | None = None

    def _size(self, *_: Any) -> None:
        size = shutil.get_terminal_size()
        self._sends.put({"rows": size.lines, "cols": size.columns})

    def _read(self) -> None:
        while not self._done.is_set():
            if select.select([self._fd], [], [], 0.2)[0]:
                data = os.read(self._fd, 4096)
                if not data:
                    return
                self._sends.put({"data": base64.b64encode(data).decode("ascii")})

    def _send(self) -> None:
        while (body := self._sends.get()) is not None:
            response = self._rush.post(self._path, json=body)
            # After the harness exits and before the attempt is sealed, what is typed has nowhere to go.
            if not response.is_success and response.status_code != 409 and self.error is None:
                self.error = f"the terminal refused input: {response.status_code} {response.text[:200]}"

    def __enter__(self) -> Keyboard:
        tty.setraw(self._fd)
        self._previous = signal.signal(signal.SIGWINCH, self._size)
        self._threads = [threading.Thread(target=self._read, daemon=True), threading.Thread(target=self._send, daemon=True)]
        for thread in self._threads:
            thread.start()
        self._size()
        return self

    def __exit__(self, *_: Any) -> None:
        self._done.set()
        self._sends.put(None)
        for thread in self._threads:
            thread.join(timeout=5)
        signal.signal(signal.SIGWINCH, self._previous)
        termios.tcsetattr(self._fd, termios.TCSADRAIN, self._saved)


def events(rush: httpx.Client, path: str) -> list[dict[str, Any]]:
    """Every event of the sealed attempt at ``path``, in cursor order: its recording (model calls, processes, the answer)."""
    kept: list[dict[str, Any]] = []
    while True:
        page = checked(rush.get(path, params={"after": kept[-1]["cursor"] if kept else 0, "limit": 1000}))
        kept += page["events"]
        if not page["has_more"]:
            return kept


def verdict(attempt: dict[str, Any]) -> str:
    """right or wrong by the plugin's verifier, or "no verdict" for an attempt it did not score."""
    return {"pass": "right", "fail": "wrong"}.get(attempt.get("verdict"), "no verdict")


def answer_of(recording: list[dict[str, Any]]) -> Any:
    """The harness's answer as the worker read it (its `result.read` record), or null when it gave none."""
    reads = [event["data"]["outcome"] for event in recording if event["kind"] == "result.read"]
    return reads[-1].get("answer") if reads else None


def thousands(count: int | None) -> str:
    return "—" if count is None else f"{count / 1000:.0f}k" if count >= 1000 else str(count)


def summary_line(result: dict[str, Any], path: Path) -> str:
    cost = "—" if result["cost_usd"] is None else f"${result['cost_usd']:.4f}"
    seconds = "—" if result["elapsed_s"] is None else f"{result['elapsed_s']:.0f} s"
    tokens = f"{thousands(result['input_tokens'])} in / {thousands(result['output_tokens'])} out"
    return " · ".join([result["harness"], result["plugin"], result["verdict"], seconds, tokens, cost, str(path)])


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    cfg = load_config_args(HarnessCommandConfig, [f"harness_cfg={DEFAULT_CONFIG}", *argv])
    if cfg.harness not in HARNESSES:
        raise SystemExit(f"harness: harness is one of {', '.join(HARNESSES)}, not {cfg.harness!r}")
    interactive = cfg.prompt is None
    if interactive and not sys.stdin.isatty():
        raise SystemExit("harness: without prompt= the session is interactive and needs a terminal")
    folder, site, token = connection(Path(cfg.lab))
    with httpx.Client(base_url=site, headers={"Authorization": f"Bearer {token}", "Origin": site}, timeout=60.0) as rush:
        prefix, app = find_plugin(rush, cfg.plugin, cfg.workspace)
        tasks = [task["id"] for task in app["tasks"]]
        task = tasks[0] if cfg.task is None else cfg.task
        if task not in tasks:
            raise SystemExit(f"harness: {cfg.plugin}'s tasks are {', '.join(tasks)}, not {task!r}")
        text = cfg.prompt if cfg.prompt is not None else input(f"{cfg.harness} · {cfg.plugin} · ask: ").strip()
        if not text:
            raise SystemExit("harness: the request is empty")
        home = Path(cfg.home) if cfg.home else folder / "runs" / cfg.plugin / f"{datetime.now():%Y_%m_%d_%H%M%S}_{cfg.harness}"
        print(f"{cfg.harness} · {cfg.plugin} · starting: the first session of a harness builds it", file=sys.stderr, flush=True)
        body = {"plugin_id": cfg.plugin, "task_id": task, "harness": HARNESSES[cfg.harness], "text": text, "interactive": interactive}
        run = checked(rush.post(f"{prefix}/benchmark/sessions", json=body | ({} if cfg.model is None else {"model": cfg.model}),
                                timeout=START_TIMEOUT_S))["run"]  # fmt: skip
        attempt_id = run["cases"][0]["attempts"][0]["attempt_id"]
        attempt_path = f"{prefix}/benchmark/attempts/{attempt_id}"

        def write(chunk: bytes) -> None:
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()

        try:
            if interactive:
                with Keyboard(rush, f"{attempt_path}/terminal") as keyboard:
                    screen = follow(rush, prefix, attempt_id, write)
                if keyboard.error:
                    print(f"harness: {keyboard.error}", file=sys.stderr)
            else:
                screen = follow(rush, prefix, attempt_id, write)
        except KeyboardInterrupt:  # one-shot only: in raw mode Ctrl-C is the harness's
            checked(rush.post(f"{prefix}/benchmark/runs/{run['run_id']}/cancel"))
            raise
        attempt = checked(rush.get(attempt_path))["attempt"]
        accounting = checked(rush.get(f"{attempt_path}/accounting"))
        recording = events(rush, f"{attempt_path}/events")
    metrics = attempt.get("metrics") or {}
    result = {
        "plugin": cfg.plugin, "task": task, "harness": cfg.harness, "model": run.get("model"), "request": text,
        "run_id": run["run_id"], "attempt_id": attempt_id,
        "status": attempt["execution"]["status"], "reason": attempt["execution"]["reason"], "answer": answer_of(recording),
        "verdict": verdict(attempt), "explanation": attempt.get("explanation"), "verifier_error": attempt.get("verifier_error"),
        "elapsed_s": None if metrics.get("elapsed_ms") is None else metrics["elapsed_ms"] / 1000,
        "input_tokens": metrics.get("input_tokens"), "output_tokens": metrics.get("output_tokens"),
        "cost_usd": accounting["totals"]["settled_usd"], "model_calls": accounting["totals"]["calls"],
    }  # fmt: skip
    home.mkdir(parents=True, exist_ok=True)
    (home / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    (home / "events.jsonl").write_text("".join(json.dumps(event) + "\n" for event in recording))
    (home / "accounting.json").write_text(json.dumps(accounting, indent=2) + "\n")
    (home / "terminal.log").write_bytes(screen)
    print(f"\r\n{summary_line(result, home / 'result.json')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
