"""`rush <command> [<args>…]` in the RUSH terminal, a prefix like `time`: it runs the command in the foreground on a terminal of its
own (a pty the member's keys and screen pass through, so interactive CLIs work) as one recorded run, named by its program
(program_of, as the Dashboard names its chip). The worker (`/runs/…`, the runner's `_rush_run`) ties the run to this process, and the
command's credentials name the run (`<token>.<run>`, inherited by every process it starts), so its model calls are its own even while
another run goes on in another terminal; it gives the run its title: a one-shot run's prompt argument, or the first line the member
types into an interactive one. When it ends, one line says what it took (summary_line). A run given the plugin task's exact prompt
(an argument holding "$RUSH_PROMPT", which bashrc pins the first time a command names it, `rush.py prompt`) is scored by the plugin's
verifier on the answer.json it leaves: right or wrong, on its line and its Dashboard row. `rush help` says what the terminal holds.

And `rush.py cli <name>`, which bin/'s wrappers run: where the worker installed the CLI <name> (nanoagent.uploaded.clis), installed
there the first time, with its progress on the terminal. And `rush.py nanoagent|mgen [<args>]`, which bin/nanoagent and bin/mgen run:
NanoAgent's own CLI (its chat, or `mgen`), the one agent here given the plugin's task tools.
"""

import fcntl
import json
import os
import re
import select
import shutil
import signal
import sys
import termios
import time
import tty
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path

HERE = Path(__file__).resolve().parent
INSTALLED = ".rush/clis"  # in the workspace: each CLI the session ran, by name, holding its install's key
PYTHON = re.compile(r"^python[0-9.]*$")
TITLE_CHARS = 120  # as the Dashboard trims a title
HELP = """\
agents          nanoagent, claude, codex, pi, hermes and dsh install the first time you type them. dsh runs headless: dsh "<task>".
                Run any other agent as rush <command> so it is recorded: rush aider, rush aider --message "…".
nanoagent       NanoAgent's chat with this plugin's tools (only NanoAgent has them); mgen -p "<request>" asks it once.
model           $RUSH_MODEL, through RUSH's gateway, which records every call. These are set for any SDK:
                OPENAI_BASE_URL, OPENAI_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY.
packages        pip install and npm install -g put packages in .rush/.
exit            (or Ctrl-D) ends the session; its model calls and commands are kept with it.
rush <command>  runs <command> as one recorded run, shown on the Dashboard under its program, and says its time, tokens and cost.
rush <command> "$RUSH_PROMPT"
                given this plugin's task prompt, the run is also scored right or wrong by the plugin's verifier."""


def fail(message: str) -> None:
    sys.exit(f"rush: {message}")


def service(path: str, body: dict, timeout: float = 600) -> dict:
    """The attempt services' answer to ``body`` at ``path`` (`/runs/…`), or the end of rush with why they refused it."""
    request = json.loads(Path(os.environ["RUSH_REQUEST"]).read_text(encoding="utf-8"))
    sent = urllib.request.Request(request["exec_url"].removesuffix("/exec") + path, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {os.environ['RUSH_ATTEMPT_TOKEN']}",
    })  # fmt: skip
    try:
        with urllib.request.urlopen(sent, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        said = error.read().decode(errors="replace")
        try:
            said = json.loads(said)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            pass
        fail(said)
    except OSError as error:
        fail(f"RUSH Lab could not be reached: {error}")


def program_of(argv: list[str]) -> str:
    """The program a command runs, as the Dashboard names its chip: argv[0]'s name (aider), a module run with `python -m` by that
    module, and a package run with `npx` by that package's command (`npx @scope/tool@1` is tool)."""
    name = os.path.basename(argv[0])
    if PYTHON.match(name) and "-m" in argv[1:-1]:
        return argv[argv.index("-m") + 1]
    if name == "npx":
        package = next((arg for arg in argv[1:] if not arg.startswith("-")), None)
        if package is not None:
            return os.path.basename(re.sub(r"(.)@[^/]*$", r"\1", package))
    return name


def is_scored(argv: list[str], prompt: str | None) -> bool:
    """Whether a command was given the plugin task's exact prompt (as "$RUSH_PROMPT" expands to) in one of its arguments."""
    return bool(prompt) and any(prompt in arg for arg in argv[1:])


def trimmed(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= TITLE_CHARS else f"{text[: TITLE_CHARS - 1]}…"


def prompt_argument(argv: list[str]) -> str | None:
    """A one-shot run's title: its prompt argument (the longest argument holding a space), or None for a command given none (an
    interactive run, titled by the first line the member types)."""
    spoken = [arg for arg in argv[1:] if " " in arg.strip()]
    return trimmed(max(spoken, key=len)) if spoken else None


def thousands(count: int) -> str:
    return f"{count / 1000:.1f}k" if count >= 1000 else str(count)


def summary_line(program: str, seconds: float, ran: dict) -> str:
    """`rush · <program> · <time> · <in>/<out> tokens · $<cost>`, a scored run's verdict (right or wrong) after its program. A cost
    the gateway does not know yet (a call not settled) reads $—. Calls the gateway refused for naming another model than the
    session's end it: `2 calls rejected: asked for claude-sonnet-4-5`."""
    cost = "$—" if ran["cost_usd"] is None else f"${ran['cost_usd']:.4f}"
    verdict = [] if ran.get("verdict") is None else [ran["verdict"]]
    tokens = f"{thousands(ran['input_tokens'])}/{thousands(ran['output_tokens'])} tokens"
    rejected = ran.get("rejected") or []
    refused = [f"{len(rejected)} call{'s' * (len(rejected) != 1)} rejected: asked for {', '.join(sorted(set(rejected)))}"] if rejected else []
    return " · ".join(["rush", program, *verdict, f"{seconds:.0f} s", tokens, cost, *refused])


class FirstLine:
    """The first line the member types into an interactive run, from the keys passed to it: printable characters up to Enter, with
    Backspace applied and escape sequences (arrows and the like) left out."""

    def __init__(self) -> None:
        self.text = ""
        self.escape = False
        self.line: str | None = None

    def feed(self, data: bytes) -> str | None:
        """The line, once, when ``data`` ends it; None before and after."""
        if self.line is not None:
            return None
        for char in data.decode(errors="ignore"):
            if self.escape:
                self.escape = not (char.isalpha() or char == "~")
            elif char == "\x1b":
                self.escape = True
            elif char in "\r\n" and self.text.strip():
                self.line = trimmed(self.text)
                return self.line
            elif char in "\x7f\b":
                self.text = self.text[:-1]
            elif char.isprintable():
                self.text += char
        return None


def interact(argv: list[str], heard: Callable[[bytes], None]) -> int:
    """Runs ``argv`` on a pty of its own, passing the member's keys (each also given to ``heard``) and its output through, its window
    the terminal's as it changes; its exit code (128 + the signal that killed it)."""
    pid, master = os.forkpty()
    if pid == 0:
        os.execvp(argv[0], argv)
    saved = None
    if os.isatty(0):

        def resize(*_: object) -> None:
            fcntl.ioctl(master, termios.TIOCSWINSZ, fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))

        resize()
        signal.signal(signal.SIGWINCH, resize)
        saved = termios.tcgetattr(0)
        tty.setraw(0)
    try:
        inputs = [master, 0]
        while True:
            ready = select.select(inputs, [], [])[0]
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:  # EIO: the program and all it started closed the pty
                    data = b""
                if not data:
                    break
                os.write(1, data)
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:
                    inputs.remove(0)
                    continue
                heard(data)
                while data:
                    data = data[os.write(master, data) :]
    finally:
        if saved is not None:
            termios.tcsetattr(0, termios.TCSAFLUSH, saved)
    code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
    return 128 - code if code < 0 else code


def run(argv: list[str]) -> None:
    """`rush <command>`: the run, then its line; rush exits as the command did."""
    if not argv:
        fail("usage: rush <command> [<args>…], or rush help")
    if argv == ["help"]:
        print(HELP)
        return
    if shutil.which(argv[0]) is None:
        fail(f"{argv[0]}: command not found")
    prompt = os.environ.get("RUSH_PROMPT")
    program, scored, title = program_of(argv), is_scored(argv, prompt), prompt_argument(argv)
    started = service("/runs/start", {"pid": os.getpid(), "title": title})
    held = os.environ["RUSH_ATTEMPT_TOKEN"]
    key = f"{held.partition('.')[0]}.{started['run']}"
    for name, value in list(os.environ.items()):
        if value == held:  # RUSH_ATTEMPT_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY: the command's model calls name this run
            os.environ[name] = key
    first = FirstLine()

    def heard(data: bytes) -> None:
        if title is None and (line := first.feed(data)) is not None:
            service("/runs/title", {"run": started["run"], "title": line})

    began = time.monotonic()
    code = interact(argv, heard)
    seconds = time.monotonic() - began
    if scored:
        print(f"rush: scoring {program} on this plugin's task…", file=sys.stderr, flush=True)
    ran = service("/runs/end", {"run": started["run"], "exit_code": code, "scored": scored})
    print(summary_line(program, seconds, ran))
    if ran.get("explanation"):
        print(f"  {ran['explanation']}")
    sys.exit(code)


def installed(name: str) -> str:
    """Where the CLI ``name`` is installed, installing it first if it is not yet (its progress on stderr, the terminal)."""
    request = json.loads(Path(os.environ["RUSH_REQUEST"]).read_text(encoding="utf-8"))
    sent = urllib.request.Request(request["exec_url"].removesuffix("/exec") + "/cli", data=json.dumps({"name": name}).encode(), method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {os.environ['RUSH_ATTEMPT_TOKEN']}",
    })  # fmt: skip
    label = name
    try:
        with urllib.request.urlopen(sent, timeout=3600) as response:
            for line in response:
                event = json.loads(line)
                if "error" in event:
                    fail(event["error"])
                if "installing" in event:
                    label = f"{event['installing']} {event['version']}"
                    print(f"installing {label}…", end="", file=sys.stderr, flush=True)
                elif "bytes" in event and "installed" not in event:
                    print(f"\rinstalling {label}… {event['bytes'] / 1e6:.0f} MB downloaded", end="", file=sys.stderr, flush=True)
                elif "installed" in event:
                    print(f"\rinstalled {label} ({event['bytes'] / 1e6:.0f} MB) in {event['seconds']} s", file=sys.stderr, flush=True)
                elif "path" in event:
                    kept = Path(request["workspace"]) / INSTALLED
                    kept.mkdir(parents=True, exist_ok=True)
                    (kept / name).write_text(event["key"], encoding="utf-8")
                    return event["path"]
    except urllib.error.HTTPError as error:
        fail(f"RUSH Lab did not install {label}: {error.code} {error.read().decode(errors='replace')}")
    except OSError as error:
        fail(f"installing {label} stopped: {error}")
    fail(f"installing {label} ended without saying where it is")


def nanoagent(entry: str, argv: list[str]) -> None:
    """NanoAgent's own CLI, `nanoagent` its chat and `mgen` its one-shot (`-p`) and Claude Code-grammar CLI, with ``argv`` after: given
    the plugin's task tools alone, which the worker starts for this process the first time (`/tools/start`: the plugin's first task, its
    tool VM beside this one) and serves to the token only this process holds, the task's instructions its system prompt, and the
    session's model through the gateway. Every model call (the gateway) and every tool call (the broker) is recorded. It replaces this
    process, so the Dashboard names its model calls nanoagent."""
    request = json.loads(Path(os.environ["RUSH_REQUEST"]).read_text(encoding="utf-8"))
    install = installed("nanoagent")
    print("starting this plugin's tools…", end="", file=sys.stderr, flush=True)
    sent = urllib.request.Request(request["exec_url"].removesuffix("/exec") + "/tools/start", data=b"{}", method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {os.environ['RUSH_ATTEMPT_TOKEN']}",
    })  # fmt: skip
    try:
        with urllib.request.urlopen(sent, timeout=3600) as response:
            started = json.loads(response.read())
    except urllib.error.HTTPError as error:
        print(file=sys.stderr)
        fail(f"this plugin's tools did not start: {json.loads(error.read())['error']['message']}")
    print(f"\rstarted this plugin's tools: {', '.join(tool['name'] for tool in started['tools'])}", file=sys.stderr, flush=True)
    home = Path(request["workspace"]) / ".rush" / "nanoagent"  # its sessions too, kept to resume as the other CLIs' homes are
    home.mkdir(parents=True, exist_ok=True)
    (home / "tools.json").write_text(json.dumps({"url": request["tools"]["url"], "tools": started["tools"]}), encoding="utf-8")
    (home / "tools.yaml").write_text(json.dumps({"code": str(HERE / "nanoagent_tools.py")}), encoding="utf-8")  # a NanoAgent tool config
    # Over NanoAgent's own mgen.yaml, as JSON (which YAML reads): the gateway, the plugin's tools alone, its instructions, no confirming.
    (home / "config.yaml").write_text(json.dumps({
        "_ > nanoagent.runtime.config.InteractiveConfig": None,
        "model > nanoagent.runtime.config.ModelConfig": {
            "model": os.environ["RUSH_MODEL"], "provider": "openrouter", "base_url": os.environ["OPENAI_BASE_URL"], "api_key": None,
            "max_tokens": int(os.environ["RUSH_MAX_OUTPUT_TOKENS"]),
        },
        "agent > nanoagent.runtime.config.AgentConfig": {"system_prompt": started["system"], "context_files": []},
        "tools": [str(home / "tools.yaml")], "output": str(home), "yolo": True,
    }), encoding="utf-8")  # fmt: skip
    config = f"{install}/nanoagent/configs/mgen.yaml"
    command = ["-m", "nanoagent.cli.mgen", "--config", config, "--set", f"rush_cfg={home / 'config.yaml'}"] if entry == "mgen" else [
        "-m", "nanoagent.cli.repl.app", f"mgen_cfg={config}", f"rush_cfg={home / 'config.yaml'}",
    ]  # fmt: skip
    env = {
        **os.environ, "PYTHONPATH": os.pathsep.join([f"{install}/site", install]), "OPENROUTER_API_KEY": os.environ["RUSH_ATTEMPT_TOKEN"],
        "RUSH_TOOLS": str(home / "tools.json"), "RUSH_TOOLS_TOKEN": started["token"],
    }  # fmt: skip
    os.execvpe(sys.executable, [sys.executable, *command, *argv], env)


def main(argv: list[str]) -> None:
    if len(argv) == 2 and argv[0] == "cli":
        print(installed(argv[1]))
        return
    if argv[:1] in (["nanoagent"], ["mgen"]):
        nanoagent(argv[0], argv[1:])
        return
    if argv == ["prompt"]:  # bashrc's RUSH_PROMPT: the plugin task's prompt, its case pinned now (RUSH fills it from the task)
        print("rush: pinning this plugin's task…", file=sys.stderr, flush=True)
        print(service("/runs/prompt", {})["prompt"], end="")
        return
    if argv[:1] != ["run"]:
        fail(f"rush.py takes run, prompt, cli, nanoagent or mgen, not {argv[:1]}")
    run(argv[1:])


if __name__ == "__main__":
    main(sys.argv[1:])
