"""The shell harness's table of agent CLIs (harnesses.yaml): every `bin/` CLI has a headless command, and a case
session runs the harness it names with the case's prompt as the command's last argument (shell.py)."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import subprocess
from pathlib import Path

import pytest

from nanoagent.uploaded.clis import CLIS
from nanoagent.uploaded.reference import FOLDER, LOCKS

SHELL = FOLDER / "shell"
TABLE = json.loads((SHELL / "harnesses.yaml").read_text())
BIN = sorted(entry.name for entry in (SHELL / "bin").iterdir())

spec = importlib.util.spec_from_file_location("shell_harness", SHELL / "shell.py")
shell = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shell)


def test_every_bin_cli_has_an_entry_with_a_headless_command() -> None:
    assert sorted(entry["name"] for entry in TABLE) == BIN
    for entry in TABLE:
        assert set(entry) == {"name", "headless"}
        argv = entry["headless"]
        assert argv and all(isinstance(argument, str) for argument in argv)
        assert (SHELL / "bin" / argv[0]).is_file(), f"{entry['name']}'s headless command {argv[0]} is not a bin/ wrapper"


def test_the_listed_harnesses_are_the_terminals_clis_and_each_has_its_lock_in_the_shell_harness() -> None:
    assert {entry["name"] for entry in TABLE if entry["name"] != "mgen"} == set(CLIS)
    for cli in CLIS.values():
        assert (LOCKS / cli.reference / "harness.yaml").is_file()
        assert cli.version()
    assert not any((FOLDER / name).exists() for name in ("claude-code", "codex", "pi", "dsh", "hermes", "nanoagent"))


def test_a_members_own_agent_runs_through_rush_with_its_arguments() -> None:
    argv = shell.agent_argv("rush aider --yes --message-file 'a b.txt'")
    assert argv == ["python", str(SHELL / "rush.py"), "run", "aider", "--yes", "--message-file", "a b.txt"]


def test_a_members_own_agents_mounted_packages_import_through_the_workspaces_user_site(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Its installation's site-packages, with the paths its own .pth files add (aider's has a namespace package's), import as they did in
    the Terminal it was installed in, from the read-only mount; the workspace's user site stays where `pip install` puts packages."""
    agent = tmp_path / "agent"
    version = f"python{os.sys.version_info.major}.{os.sys.version_info.minor}"
    site = agent / "python" / "lib" / version / "site-packages"
    (site / "agentpkg").mkdir(parents=True)
    (site / "agentpkg" / "__init__.py").write_text("NAME = 'agent'\n")
    extra = tmp_path / "extra"
    extra.mkdir()
    (extra / "fromdotpth.py").write_text("NAME = 'pth'\n")
    (site / "extra.pth").write_text(f"{extra}\n")
    monkeypatch.setattr(shell, "AGENT", agent)
    user_base = tmp_path / "workspace" / ".rush" / "python"
    shell.link_agent(user_base)
    # The user site of the VM's Python (Linux: <base>/lib/pythonX.Y/site-packages), processed as its startup does.
    user_site = user_base / "lib" / version / "site-packages"
    said = subprocess.check_output(
        [os.sys.executable, "-I", "-c", f"import site; site.addsitedir({str(user_site)!r}); import agentpkg, fromdotpth; print(agentpkg.NAME, fromdotpth.NAME)"],
        text=True,
    )
    assert said.split() == ["agent", "pth"]


def test_a_case_of_a_members_own_agent_without_its_installation_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shell, "AGENT", tmp_path / "missing")
    with pytest.raises(SystemExit, match=f"this case's agent has no installation at {tmp_path / 'missing'}"):
        shell.link_agent(tmp_path / "user")


def test_a_case_without_a_known_harness_is_refused() -> None:
    with pytest.raises(SystemExit, match="names the harness"):
        shell.agent_argv(None)
    with pytest.raises(SystemExit, match="nope is not a harness here"):
        shell.agent_argv("nope")


def test_a_headless_case_runs_the_command_with_the_prompt_and_exits_with_its_status(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    (workspace).mkdir()
    bin_folder = tmp_path / "bin"
    bin_folder.mkdir()
    (bin_folder / "claude").write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$RUSH_OUT"\necho "$RUSH_PROMPT" >> "$RUSH_OUT"\nexit 3\n')
    (bin_folder / "claude").chmod(0o755)
    request = {
        "free_form": False, "case": {"case_id": "p-01"}, "prompt": {"system": None, "user": "list  three ids\nplease", "sha256": ""}, "harness": "claude",
        "interactive": False, "workspace": str(workspace), "openrouter": {"base_url": "http://gateway/api/v1", "model": "m"}, "limits": {"max_output_tokens_per_call": 64},
    }  # fmt: skip
    (tmp_path / "request.json").write_text(json.dumps(request))
    # shell.py puts its own bin/ first on PATH, where the real claude wrapper is: run it with HERE's bin swapped for the stub's.
    original = (SHELL / "shell.py").read_text()
    source = original.replace('str(HERE / "bin")', repr(str(bin_folder)))
    assert source != original, 'shell.py no longer puts str(HERE / "bin") on PATH: this test would run the real claude wrapper'
    copy = tmp_path / "shell.py"
    copy.write_text(source)
    (tmp_path / "harnesses.yaml").write_text((SHELL / "harnesses.yaml").read_text())
    env = {**os.environ, "RUSH_REQUEST": str(tmp_path / "request.json"), "RUSH_TERMINAL": "0", "RUSH_ATTEMPT_TOKEN": "t", "RUSH_OUT": str(tmp_path / "out.txt")}
    done = subprocess.run(["python3", str(copy)], env=env, check=False)
    assert done.returncode == 3
    # The table's headless command, then the prompt as the last argument, byte for byte; and the same text in RUSH_PROMPT.
    assert (tmp_path / "out.txt").read_text().splitlines() == [
        "--permission-mode", "bypassPermissions", "-p", "list  three ids", "please", "list  three ids", "please",
    ]  # fmt: skip


rush_spec = importlib.util.spec_from_file_location("rush_cli", SHELL / "rush.py")
rush = importlib.util.module_from_spec(rush_spec)
rush_spec.loader.exec_module(rush)


def test_each_wrapper_installs_the_cli_its_table_entry_names() -> None:
    for entry in TABLE:
        text = (SHELL / "bin" / entry["name"]).read_text()
        installs = re.findall(r"rush\.py cli (\S+?)\)", text)
        if entry["name"] in ("nanoagent", "mgen"):
            assert installs == [] and f"rush.py {entry['name']}" in text  # NanoAgent's own, through `rush.py nanoagent|mgen`
        else:
            assert installs == [entry["name"]] and entry["name"] in CLIS, entry["name"]  # the CLIS key the worker installs


@pytest.mark.parametrize("cli", CLIS.values(), ids=lambda cli: cli.name)
def test_each_cli_has_the_real_files_of_its_lock_folder(cli) -> None:
    folder = LOCKS / cli.reference
    if cli.package == "nanoagent":
        assert (folder / "assemble.py").is_file() and (folder / "requirements.txt").is_file() and (folder / "uv.lock").is_file()
    elif (folder / "package.json").is_file():
        assert (folder / "package-lock.json").is_file() and (folder / "build.sh").is_file()
        assert cli.package in json.loads((folder / "package.json").read_text())["dependencies"]
    else:
        assert (folder / "requirements.txt").is_file() and cli.package in (folder / "requirements.in").read_text()


class Answer(io.BytesIO):
    def __enter__(self) -> "Answer":
        return self

    def __exit__(self, *exc: object) -> None:
        return None


@pytest.mark.parametrize("entry", ["nanoagent", "mgen"])
def test_nanoagent_and_mgen_install_nanoagent_ask_for_the_tools_and_exec_their_module(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, entry: str) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (tmp_path / "request.json").write_text(json.dumps({"exec_url": "http://gw/exec", "tools": {"url": "http://gw/tools"}, "workspace": str(workspace), "case": None}))
    for name, value in {"RUSH_REQUEST": str(tmp_path / "request.json"), "RUSH_ATTEMPT_TOKEN": "t", "RUSH_MODEL": "m", "OPENAI_BASE_URL": "http://gw/api/v1", "RUSH_MAX_OUTPUT_TOKENS": "64"}.items():
        monkeypatch.setenv(name, value)
    asked: list[tuple[str, dict]] = []

    def urlopen(sent, timeout: float) -> Answer:
        body = json.loads(sent.data)
        asked.append((sent.full_url, body))
        if sent.full_url.endswith("/cli"):
            return Answer(json.dumps({"path": "/clis/na", "key": "k"}).encode() + b"\n")
        return Answer(json.dumps({"token": "tt", "system": "sys", "tools": [{"name": "wait"}]}).encode())

    executed: list[list[str]] = []
    monkeypatch.setattr(rush.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(rush.os, "execvpe", lambda file, argv, env: executed.append(argv))
    rush.main([entry, "-p", "hi"])
    assert asked == [("http://gw/cli", {"name": "nanoagent"}), ("http://gw/tools/start", {})]  # the install is NanoAgent's, then its tools start
    [argv] = executed
    assert argv[1:3] == ["-m", "nanoagent.cli.mgen" if entry == "mgen" else "nanoagent.cli.repl.app"] and argv[-2:] == ["-p", "hi"]
