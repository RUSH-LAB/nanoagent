"""Hermes Agent in the workspace as a person runs it on a terminal, the model reached through the gateway's chat completions dialect on
Hermes's openrouter route: its interactive chat screen when someone is at the terminal (`interactive`), the case's prompt its first
message, and otherwise its one-shot mode (`hermes -z`)."""

import importlib
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE / "site"), str(HERE)]

request = json.loads(Path(os.environ["RUSH_REQUEST"]).read_text(encoding="utf-8"))
# Hermes's shell and file tools start from TERMINAL_CWD; its own home and cache live only for the run.
os.chdir(request["workspace"])
os.environ.update(
    HERMES_HOME=tempfile.mkdtemp(prefix="hermes-home-"),
    TERMINAL_CWD=request["workspace"],
    # As `hermes -z` sets itself up: no one approves anything.
    HERMES_YOLO_MODE="1",
    HERMES_ACCEPT_HOOKS="1",
    # Hermes's openrouter route reads its endpoint and key from these.
    OPENROUTER_BASE_URL=request["openrouter"]["base_url"],
    OPENROUTER_API_KEY=os.environ["RUSH_ATTEMPT_TOKEN"],
)
route = ["--provider", "openrouter", "--model", request["openrouter"]["model"]]
if request["interactive"]:
    # `hermes chat` takes no first message, so the prompt goes on its input queue, where what the person types goes; they end it with /exit.
    cli = importlib.import_module("cli")
    init = cli.HermesCLI.__init__

    def started(self, *args, **kwargs):
        init(self, *args, **kwargs)
        self._pending_input.put(request["prompt"]["user"])

    cli.HermesCLI.__init__ = started
    sys.argv = ["hermes", "chat", *route]
else:
    sys.argv = ["hermes", "-z", request["prompt"]["user"], *route]

importlib.import_module("hermes_cli.main").main()
