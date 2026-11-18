"""The member's own terminal in the attempt's VM: bash in the workspace, with every model SDK pointed at the attempt's gateway and
the reference CLIs (bin/: claude, codex, pi, hermes, dsh) set up for it. The session is free-form: the member installs and runs any
agent there (pip and npm install into .rush/) and prompts it themselves; its model calls and commands are recorded, and nothing scores it.

Given a command (a harness `rush save` made), it runs that command instead, once, in the same workspace and environment, after
putting back the files the member built (``workspace/``) and with the Python packages they installed (``packages/``).
"""

import json
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
request = json.loads(Path(os.environ["RUSH_REQUEST"]).read_text(encoding="utf-8"))
workspace = Path(request["workspace"])
command = sys.argv[1] if len(sys.argv) > 1 else None
if command is None and not request["free_form"]:
    sys.exit("the Terminal is a free-form shell someone works in: start it with someone at it")

if (HERE / "workspace").is_dir():
    shutil.copytree(HERE / "workspace", workspace, dirs_exist_ok=True)
    for path in (HERE / "executables").read_text(encoding="utf-8").splitlines():
        (workspace / path).chmod(0o755)
if command is not None:  # a saved harness works a case: prompt.md (the rendered coding prompt) and request.json (its input)
    (workspace / "prompt.md").write_text(request["prompt"]["user"], encoding="utf-8")
    (workspace / "request.json").write_text(json.dumps(request["case"]["arguments"], indent=2) + "\n", encoding="utf-8")

gateway = request["openrouter"]["base_url"]  # .../api/v1: what the OpenAI SDK takes; the Anthropic SDK adds /v1 itself
token = os.environ["RUSH_ATTEMPT_TOKEN"]
user_base = workspace / ".rush" / "python"  # where `pip install` puts packages, the system's being read-only; rush save locks them
npm_prefix = workspace / ".rush" / "npm"  # where `npm install -g` puts packages, for the same reason
path = [str(HERE / "bin"), str(user_base / "bin"), str(npm_prefix / "bin")]
env = {
    **os.environ,
    "OPENAI_BASE_URL": gateway, "OPENAI_API_KEY": token,
    "ANTHROPIC_BASE_URL": gateway.removesuffix("/v1"), "ANTHROPIC_API_KEY": token,
    "RUSH_MODEL": request["openrouter"]["model"], "RUSH_MAX_OUTPUT_TOKENS": str(request["limits"]["max_output_tokens_per_call"]),
    "PYTHONUSERBASE": str(user_base), "NPM_CONFIG_PREFIX": str(npm_prefix),
}  # fmt: skip
if command is not None:
    env["RUSH_PROMPT"] = request["prompt"]["user"]
if (HERE / "packages").is_dir():
    env["PYTHONPATH"] = str(HERE / "packages")
    path.append(str(HERE / "packages" / "bin"))
env["PATH"] = os.pathsep.join([*path, os.environ["PATH"]])
os.chdir(workspace)

if command is not None:
    os.execvpe("bash", ["bash", "-c", command], env)

print(
    f"\x1b[1m{request['task']['plugin_name']}\x1b[0m\r\nRun any CLI agent here (claude, codex, pi, hermes, dsh)\r\nModels and tracing are set up.\r\n",
    end="",
    flush=True,
)
shell = subprocess.Popen(["bash", "--rcfile", str(HERE / "bashrc"), "-i"], env=env)
signal.signal(signal.SIGINT, signal.SIG_IGN)  # after the start, so the shell and what it runs keep Ctrl-C
shell.wait()
# The member ends the session by leaving the shell; its exit status is their last command's, not the harness's.
sys.exit(0)
