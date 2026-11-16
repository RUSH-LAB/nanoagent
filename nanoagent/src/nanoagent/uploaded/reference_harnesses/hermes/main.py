"""Hermes Agent's one-shot mode (`hermes -z`) in the workspace, the model reached through the gateway's chat completions dialect on Hermes's openrouter route."""

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
sys.argv = ["hermes", "-z", request["prompt"]["user"], "--provider", "openrouter", "--model", request["openrouter"]["model"]]

importlib.import_module("hermes_cli.main").main()
