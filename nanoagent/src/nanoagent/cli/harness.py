"""`nanoagent harness`: the plugin page's Harness tab in a terminal. A plugin's task is worked once by one reference harness on
the member's own worker, and the run folder gets its result and recording.

    nanoagent harness plugin=city-weather harness=claude-code                         # interactive: the CLI's own screen here
    nanoagent harness plugin=city-weather harness=codex prompt="Which cities had …"   # one-shot, for scripts
    nanoagent harness plugin=city-weather harness=shell                               # a plain terminal: bring your own agent

`harness=shell` is bash in the workspace with the gateway preset, a free-form session: no request and no case, nothing scored, its
model calls and commands recorded; `rush save <name>` there makes what the member built a harness of theirs, which `harness=<name>`
runs again, scored and recorded the same way.

It goes through the RUSH that RUSH Lab on this computer is connected to, as the tab does (POST /api/benchmark/sessions,
docs/contracts/rush-benchmark-api.md): RUSH queues the run at once and pins the case on the member's computer meanwhile, and RUSH
Lab's worker claims it and runs the harness in microsandbox with its gateway, strace and the plugin's verifier, on the OpenRouter
key RUSH Lab keeps. This command signs in with RUSH Lab's connection (its `site` and `runner-credentials.json`) and never reads the
key. Without `prompt`, the first line typed is the request (but for the shell, which takes none) and the terminal is then the
harness's, raw, until it exits: the command reaches it as the tab does, over the worker's token-guarded link on this computer
(GET attempts/{id}/terminal-link, nanoagent.uploaded.terminal), never through RUSH. A one-shot run nobody is at prints its
terminal from its recording once it is over.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import select
import shutil
import signal
import socket
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
from nanoagent.uploaded.session_result import summary_line, verdict

DEFAULT_CONFIG = str(PACKAGED_CONFIGS / "harness.yaml")
# The command's names of the reference harnesses, each the one RUSH builds; rush is NanoAgent's own. Any other name is one the
# member saved from a shell session (`rush save`), which RUSH looks up.
HARNESSES = {"rush": "nanoagent", "claude-code": "claude-code", "codex": "codex", "pi": "pi", "dsh": "dsh", "hermes": "hermes", "shell": "shell"}
# The data folders of RUSH Lab and RUSH Lab Dev (helpinghands/desktop/config.yaml's labels).
LABELS = ("lab.mochi.lab", "lab.mochi.lab.dev")
# RUSH queues the session once the member's computer has read the plugin's task and built the reference harness, and pins the
# case while the harness starts (helpinghands/src/server/routes/benchmark.js).
START_TIMEOUT_S = 960.0
RETRY_S = 1.5


@dataclass
class HarnessCommandConfig(Config):
    # The id of a plugin installed in one of the member's workspaces.
    plugin: str = MISSING
    # rush, claude-code, codex, pi, dsh, hermes, shell (a terminal of your own), or a harness you saved with `rush save`.
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
    # RUSH Lab's data folder, which holds its one connection; null: whichever of RUSH Lab's and RUSH Lab Dev's is signed in.
    lab: str | None = MISSING


def app_data() -> Path:
    """Where this OS keeps an app's data folder, as RUSH Lab's (Tauri's app data dir)."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    if sys.platform == "win32":
        return Path(os.environ["LOCALAPPDATA"])
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")


def signed_in(lab: Path) -> bool:
    return any((lab / "connections").glob("*/runner-credentials.json"))


def find_lab(root: Path) -> Path:
    """The one RUSH Lab data folder under ``root`` with a signed-in connection: RUSH Lab's or RUSH Lab Dev's."""
    labs = [root / label for label in LABELS if signed_in(root / label)]
    if len(labs) > 1:
        raise SystemExit(f"harness: both {labs[0]} and {labs[1]} are signed in; pass lab=<one of them>")
    if not labs:
        raise SystemExit(
            f"harness: neither {root / LABELS[0]} nor {root / LABELS[1]} holds a signed-in RUSH Lab connection. Open RUSH Lab and sign in."
        )
    return labs[0]


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


def sealed(rush: httpx.Client, attempt_path: str) -> dict[str, Any]:
    """The attempt at ``attempt_path`` once it is sealed."""
    while not (attempt := checked(rush.get(attempt_path))["attempt"])["sealed"]:
        time.sleep(RETRY_S)
    return attempt


def link_of(rush: httpx.Client, attempt_path: str) -> dict[str, Any] | None:
    """Where the session's worker serves its terminals on this computer, ``{port, token}``, once it has started them; None when the
    session ended first. RUSH holds each read until the link is there, or answers 204 after a while."""
    while True:
        response = rush.get(f"{attempt_path}/terminal-link")
        if response.status_code == 404:
            raise SystemExit("harness: the session's attempt is gone")
        if response.status_code == 204:
            if checked(rush.get(attempt_path))["attempt"]["sealed"]:
                return None
            continue
        return checked(response)


class Link:
    """The session's terminals over the worker's link on this computer (nanoagent.uploaded.terminal): one JSON object a line each way,
    the first the link's token. What terminal 0, the harness's, writes goes to ``write`` as it comes; what is typed goes back."""

    def __init__(self, port: int, token: str, write) -> None:
        self._socket = socket.create_connection(("127.0.0.1", port))
        self._lock = threading.Lock()
        self._write = write
        self.error: str | None = None
        self.send({"token": token})

    def send(self, line: dict[str, Any]) -> None:
        with self._lock:
            self._socket.sendall(json.dumps(line).encode() + b"\n")

    def follow(self) -> bytes:
        """Terminal 0's output, each chunk to ``write``, until the worker ends the link (the session is over): all of it."""
        screen = bytearray()
        with self._socket, self._socket.makefile("rb") as lines:
            for raw in lines:
                line = json.loads(raw)
                if "error" in line:
                    self.error = f"the session's terminals refused this command: {line['error']}"
                elif line.get("terminal") == 0 and "data" in line:
                    chunk = base64.b64decode(line["data"])
                    screen += chunk
                    self._write(chunk)
        return bytes(screen)


class Keyboard:
    """The member's terminal, raw, as the harness's: what is typed and each new size go over the link to its PTY in order."""

    def __init__(self, link: Link) -> None:
        self._link = link
        self._fd = sys.stdin.fileno()
        self._saved = termios.tcgetattr(self._fd)
        self._sends: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._done = threading.Event()

    def _size(self, *_: Any) -> None:
        size = shutil.get_terminal_size()
        self._sends.put({"terminal": 0, "rows": size.lines, "cols": size.columns})

    def _read(self) -> None:
        while not self._done.is_set():
            if select.select([self._fd], [], [], 0.2)[0]:
                data = os.read(self._fd, 4096)
                if not data:
                    return
                self._sends.put({"terminal": 0, "data": base64.b64encode(data).decode("ascii")})

    def _send(self) -> None:
        while (body := self._sends.get()) is not None:
            try:
                self._link.send(body)
            except OSError:
                return  # the session ended: what is typed has nowhere to go

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


def answer_of(recording: list[dict[str, Any]]) -> Any:
    """The harness's answer as the worker read it (its `result.read` record), or null when it gave none."""
    reads = [event["data"]["outcome"] for event in recording if event["kind"] == "result.read"]
    return reads[-1].get("answer") if reads else None


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    cfg = load_config_args(HarnessCommandConfig, [f"harness_cfg={DEFAULT_CONFIG}", *argv])
    interactive = cfg.prompt is None
    if interactive and not sys.stdin.isatty():
        raise SystemExit("harness: without prompt= the session is interactive and needs a terminal")
    if cfg.harness == "shell" and not interactive:
        raise SystemExit("harness: the shell is a terminal you work in; drop prompt=")
    folder, site, token = connection(find_lab(app_data()) if cfg.lab is None else Path(cfg.lab))
    with httpx.Client(base_url=site, headers={"Authorization": f"Bearer {token}", "Origin": site}, timeout=60.0) as rush:
        prefix, app = find_plugin(rush, cfg.plugin, cfg.workspace)
        free = cfg.harness == "shell"  # a free-form terminal: no task, request or case; the plugin only labels it
        if free and cfg.task is not None:
            raise SystemExit("harness: the shell is an empty terminal that works no task; drop task=")
        task = None
        if not free:
            tasks = [task["id"] for task in app["tasks"]]
            task = tasks[0] if cfg.task is None else cfg.task
            if task not in tasks:
                raise SystemExit(f"harness: {cfg.plugin}'s tasks are {', '.join(tasks)}, not {task!r}")
        text = None if free else cfg.prompt if cfg.prompt is not None else input(f"{cfg.harness} · {cfg.plugin} · ask: ").strip()
        if not free and not text:
            raise SystemExit("harness: the request is empty")
        home = Path(cfg.home) if cfg.home else folder / "runs" / cfg.plugin / f"{datetime.now():%Y_%m_%d_%H%M%S}_{cfg.harness}"
        print(f"{cfg.harness} · {cfg.plugin} · starting: the first session of a harness builds it", file=sys.stderr, flush=True)
        body = {"plugin_id": cfg.plugin, "harness": HARNESSES.get(cfg.harness, cfg.harness), "interactive": interactive} | ({} if free else {"task_id": task, "text": text})
        started = checked(rush.post(f"{prefix}/benchmark/sessions", json=body | ({} if cfg.model is None else {"model": cfg.model}),
                                    timeout=START_TIMEOUT_S))  # fmt: skip
        run, attempt_id = started["run"], started["attempt_id"]
        attempt_path = f"{prefix}/benchmark/attempts/{attempt_id}"

        def write(chunk: bytes) -> None:
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()

        try:
            screen = b""
            if interactive:
                if (found := link_of(rush, attempt_path)) is not None:
                    link = Link(found["port"], found["token"], write)
                    with Keyboard(link):
                        screen = link.follow()
                    if link.error:
                        print(f"harness: {link.error}", file=sys.stderr)
                attempt = sealed(rush, attempt_path)
            else:
                attempt = sealed(rush, attempt_path)
                recording = checked(rush.get(f"{attempt_path}/recording"))
                screen = b"".join(base64.b64decode(each["data"]) for each in recording["terminals"] if each["terminal"] == 0)
                write(screen)
        except KeyboardInterrupt:  # one-shot only: in raw mode Ctrl-C is the harness's
            checked(rush.post(f"{prefix}/benchmark/runs/{run['run_id']}/cancel"))
            raise
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
