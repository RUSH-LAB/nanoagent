"""The member's own terminal in the case's VM: bash in the case workspace, which holds prompt.md (the rendered coding prompt) and
request.json (the case's input), with every model SDK pointed at the attempt's gateway. They install and run any agent there,
and once they exit, the answer.json it left is scored as a coding harness's is.

Given a command (a harness `rush save` made), it runs that command instead, once, in the same workspace and environment, after
putting back the files the member built (``workspace/``) and with the Python packages they installed (``site/``).
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
if command is None and not request["interactive"]:
    sys.exit("the Terminal is a shell someone works in: start it with someone at it")

if (HERE / "workspace").is_dir():
    shutil.copytree(HERE / "workspace", workspace, dirs_exist_ok=True)
    for path in (HERE / "executables").read_text(encoding="utf-8").splitlines():
        (workspace / path).chmod(0o755)
(workspace / "prompt.md").write_text(request["prompt"]["user"], encoding="utf-8")
(workspace / "request.json").write_text(json.dumps(request["case"]["arguments"], indent=2) + "\n", encoding="utf-8")

gateway = request["openrouter"]["base_url"]  # .../api/v1: what the OpenAI SDK takes; the Anthropic SDK adds /v1 itself
token = os.environ["RUSH_ATTEMPT_TOKEN"]
user_base = workspace / ".rush" / "python"  # where `pip install` puts packages, the system's being read-only; rush save locks them
path = [str(user_base / "bin")]
env = {
    **os.environ,
    "OPENAI_BASE_URL": gateway, "OPENAI_API_KEY": token,
    "ANTHROPIC_BASE_URL": gateway.removesuffix("/v1"), "ANTHROPIC_API_KEY": token,
    "RUSH_MODEL": request["openrouter"]["model"], "RUSH_PROMPT": request["prompt"]["user"],
    "PYTHONUSERBASE": str(user_base),
}  # fmt: skip
if (HERE / "site").is_dir():
    env["PYTHONPATH"] = str(HERE / "site")
    path.append(str(HERE / "site" / "bin"))
env["PATH"] = os.pathsep.join([*path, os.environ["PATH"]])
os.chdir(workspace)

if command is not None:
    os.execvpe("bash", ["bash", "-c", command], env)

print(
    f"\x1b[1mRUSH terminal\x1b[0m · {request['openrouter']['model']} · {workspace}\r\n"
    "prompt.md is the task and request.json its input. Write answer.json here, then exit: it is scored like any harness's.\r\n"
    "OPENAI_BASE_URL/OPENAI_API_KEY and ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY reach the model through RUSH's gateway, which records\r\n"
    "every call. Use model $RUSH_MODEL; until one call has finished, each must carry $RUSH_PROMPT as a user message.\r\n"
    "`rush save <name> [-- <command>]` saves what you built here as a harness that runs <command> (by default your last one).\r\n",
    end="",
    flush=True,
)
shell = subprocess.Popen(["bash", "--rcfile", str(HERE / "bashrc"), "-i"], env=env)
signal.signal(signal.SIGINT, signal.SIG_IGN)  # after the start, so the shell and what it runs keep Ctrl-C
shell.wait()
# The member ends the session by leaving the shell; its exit status is their last command's, not the harness's.
sys.exit(0)
