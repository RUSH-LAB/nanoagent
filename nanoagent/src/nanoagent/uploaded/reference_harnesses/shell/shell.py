"""The member's own terminal in the attempt's VM: bash in the workspace, with every model SDK pointed at the attempt's gateway and
the reference CLIs (bin/: nanoagent and mgen, claude, codex, pi, hermes, dsh) set up for it, NanoAgent alone given the plugin's
tools. The session is free-form: the member installs and runs any agent there (pip and npm install into .rush/) and prompts it
themselves; its model calls and commands are recorded, and only a `rush <command>` given the task's prompt is scored (rush.py).

Started again for another terminal the member opens (``RUSH_TERMINAL`` 1, 2, ...), it is one more bash in the same workspace, with the
environment the first terminal's shell set up (TERMINAL_ENV).
"""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
TERMINAL_ENV = Path("/tmp/rush-terminal-env.json")  # the first terminal's shell environment, which every other terminal starts with
SHELL = ["bash", "--rcfile", str(HERE / "bashrc"), "-i"]


def said(workspace: Path) -> dict[str, str]:
    """What this terminal says after the banner and runs at its first prompt (bashrc), as the worker left it (nanoagent.uploaded.resume:
    a resumed session's, a session started under an agent, a chat reopened in a new terminal), or nothing."""
    resume = workspace / ".rush" / f"resume-{os.environ['RUSH_TERMINAL']}.json"
    if not resume.is_file():
        return {}
    told = json.loads(resume.read_text(encoding="utf-8"))
    resume.unlink()
    return {"RUSH_RESUME_LINE": told.get("line", ""), "RUSH_RESUME_RUN": told.get("run", ""), "RUSH_RESUME_TYPE": told.get("type", "")}


if os.environ["RUSH_TERMINAL"] != "0":
    while not TERMINAL_ENV.is_file():  # written as the first terminal's shell starts, which a terminal opened at once may beat
        time.sleep(0.005)
    env = {**json.loads(TERMINAL_ENV.read_text(encoding="utf-8")), "RUSH_TERMINAL": os.environ["RUSH_TERMINAL"]}
    os.chdir(env["RUSH_WORKSPACE"])
    os.execvpe("bash", SHELL, env | said(Path(env["RUSH_WORKSPACE"])))
request = json.loads(Path(os.environ["RUSH_REQUEST"]).read_text(encoding="utf-8"))
if request.get("wait_go"):
    # A warm terminal, started before any session had it: the session it is handed to writes its request and its attempt's token
    # (go.json, last) beside it, and the shell starts then, at once.
    go = Path(os.environ["RUSH_RESULT"]).parent / "go.json"
    while not go.is_file():
        time.sleep(0.005)
    os.environ["RUSH_ATTEMPT_TOKEN"] = json.loads(go.read_text(encoding="utf-8"))["token"]
    os.environ["RUSH_REQUEST"] = str(go.parent / "request.json")
    request = json.loads(Path(os.environ["RUSH_REQUEST"]).read_text(encoding="utf-8"))
workspace = Path(request["workspace"])
if not request["free_form"]:
    sys.exit("the Terminal is a free-form shell someone works in: start it with someone at it")

gateway = request["openrouter"]["base_url"]  # .../api/v1: what the OpenAI SDK takes; the Anthropic SDK adds /v1 itself
token = os.environ["RUSH_ATTEMPT_TOKEN"]
user_base = workspace / ".rush" / "python"  # where `pip install` puts packages, the system's being read-only
npm_prefix = workspace / ".rush" / "npm"  # where `npm install -g` puts packages, for the same reason
path = [str(HERE / "bin"), str(user_base / "bin"), str(npm_prefix / "bin")]
env = {
    **os.environ,
    "OPENAI_BASE_URL": gateway, "OPENAI_API_KEY": token,
    "ANTHROPIC_BASE_URL": gateway.removesuffix("/v1"), "ANTHROPIC_API_KEY": token,
    "RUSH_MODEL": request["openrouter"]["model"], "RUSH_MAX_OUTPUT_TOKENS": str(request["limits"]["max_output_tokens_per_call"]),
    "PYTHONUSERBASE": str(user_base), "NPM_CONFIG_PREFIX": str(npm_prefix),
}  # fmt: skip
env["PATH"] = os.pathsep.join([*path, os.environ["PATH"]])
os.chdir(workspace)

staged = TERMINAL_ENV.with_suffix(".tmp")
staged.write_text(json.dumps(env), encoding="utf-8")
staged.rename(TERMINAL_ENV)  # whole: another terminal reads it the moment it appears
# A session that resumes another (nanoagent.uploaded.resume): its first terminal says from when and with which agent after the
# banner, then runs that agent's resume command or says what to type (bashrc). One started under an agent runs its CLI, saying nothing.
shell = subprocess.Popen(SHELL, env=env | said(workspace))
signal.signal(signal.SIGINT, signal.SIG_IGN)  # after the start, so the shell and what it runs keep Ctrl-C
shell.wait()
# The member ends the session by leaving the shell; its exit status is their last command's, not the harness's.
sys.exit(0)
