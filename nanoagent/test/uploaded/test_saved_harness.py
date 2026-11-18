"""`rush save` in the RUSH terminal: the snapshot it takes, the manifest it writes, and the attempt services' route that checks
the ZIP as any source and hands it to RUSH."""

from __future__ import annotations

import importlib.util
import io
import json
import zipfile
from pathlib import Path
from typing import Any

import pytest

from nanoagent.uploaded.clis import CLIS
from nanoagent.uploaded.contract import parse_manifest
from nanoagent.uploaded.reference import FOLDER
from nanoagent.uploaded.rush_worker import RushError
from service_fakes import make_rig

spec = importlib.util.spec_from_file_location("rush_save", FOLDER / "shell" / "rush.py")
rush = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rush)


def test_the_snapshot_is_the_workspace_but_the_case_files_and_the_terminals_folder(tmp_path: Path) -> None:
    for path, text in {"prompt.md": "p", "request.json": "{}", "answer.json": "{}", ".rush/python/x.py": "", "agent.py": "a", "lib/util.py": "u"}.items():
        (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / path).write_text(text)
    (tmp_path / "run.sh").write_text("python agent.py")
    (tmp_path / "run.sh").chmod(0o755)
    files, executables = rush.workspace_files(tmp_path)
    assert set(files) == {"agent.py", "lib/util.py", "run.sh"} and executables == ["run.sh"]
    (tmp_path / "lib" / "link").symlink_to("util.py")
    with pytest.raises(SystemExit, match="no links; remove or replace: lib/link"):
        rush.workspace_files(tmp_path)


def test_the_command_is_the_text_after_the_dashes_as_typed_or_the_last_one(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RUSH_LINE", 'rush save me -- aider --message "$RUSH_PROMPT"')
    monkeypatch.setenv("RUSH_LAST", "python agent.py")
    assert rush.command_of(["save", "me", "--", "aider", "--message", "expanded"]) == 'aider --message "$RUSH_PROMPT"'
    assert rush.command_of(["save", "me"]) == "python agent.py"
    monkeypatch.setenv("RUSH_LAST", "")
    with pytest.raises(SystemExit, match="no command to save"):
        rush.command_of(["save", "me"])


def test_the_manifest_is_a_valid_harness_that_runs_the_command_through_the_shell() -> None:
    for locked in (False, True):
        manifest = parse_manifest(rush.manifest("my-agent", "0123456789ab", 'aider --message "$RUSH_PROMPT"', locked).encode())
        assert (manifest.name, manifest.version, manifest.toolchain) == ("my-agent", "0123456789ab", "shell-1")
        assert manifest.run_argv == ("python", "/harness/shell.py", 'aider --message "$RUSH_PROMPT"')
        assert manifest.lockfiles == (("requirements.txt",) if locked else ())
        assert manifest.build_argv == ("sh", "build.sh") and ("packages" in manifest.build_outputs) is locked


def saved_zip(**extra: bytes) -> bytes:
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as out:
        out.writestr("harness.yaml", rush.manifest("my-agent", "0123456789ab", "bash run.sh", False))
        for path, data in {"shell.py": b"print()", "executables": b"", "workspace/run.sh": b"echo", **extra}.items():
            out.writestr(path, data)
    return archive.getvalue()


async def test_the_services_check_a_saved_harness_as_a_source_and_hand_it_to_rush(tmp_path: Path) -> None:
    sent: list[bytes] = []

    async def save(data: bytes) -> dict[str, Any]:
        sent.append(data)
        if len(sent) == 3:
            raise RushError(400, "reserved_harness_name", "shell is a reference harness's name")
        return {"source_sha256": "a" * 64, "harness": {"name": "my-agent", "version": "0123456789ab"}}

    rig = make_rig(tmp_path, save_harness=save)
    async with rig.client() as client:
        saved = await client.post("/harness", content=saved_zip(), headers={"content-type": "application/zip"})
        assert saved.status_code == 200 and saved.json()["harness"]["name"] == "my-agent" and sent == [saved_zip()]
        built = await client.post("/harness", content=saved_zip(**{"workspace/a.so": b"\x7fELF"}))
        assert built.status_code == 422 and built.json()["error"]["code"] == "prebuilt_binary" and len(sent) == 1  # never reaches RUSH
        assert (await client.post("/harness", content=saved_zip())).status_code == 200
        refused = await client.post("/harness", content=saved_zip())
        assert (refused.status_code, refused.json()["error"]["code"]) == (400, "reserved_harness_name")
        assert (await client.post("/harness", content=saved_zip(), headers={"authorization": "Bearer nope"})).status_code == 401
    assert make_rig(tmp_path / "plain").services.app.routes[0].path != "/harness"


def test_a_harness_saved_after_installing_clis_records_those_installs() -> None:
    manifest = parse_manifest(rush.manifest("my-agent", "0123456789ab", "claude -p hi", False, True).encode())
    assert "clis.json" in manifest.build_outputs and manifest.lockfiles == ()


def test_each_terminal_cli_is_its_reference_harness_at_the_version_its_lock_pins() -> None:
    assert {name: (cli.reference, cli.version()) for name, cli in CLIS.items()} == {
        "claude": ("claude-code", "2.1.325"), "codex": ("codex", "0.167.0"), "pi": ("pi", "0.84.4"), "dsh": ("dsh", "0.2.2-rc.1"), "hermes": ("hermes", "0.19.0"),
    }  # fmt: skip
    claude = CLIS["claude"]
    assert claude.key("node@sha256:a") == claude.key("node@sha256:a") != claude.key("node@sha256:b")  # one install per lock, image and machine


async def test_the_services_stream_a_cli_install_one_json_line_per_event(tmp_path: Path) -> None:
    asked: list[tuple[str, str | None]] = []

    async def install(name: str, expect: str | None) -> Any:
        asked.append((name, expect))
        yield {"installing": "Claude Code", "version": "2.1.325"}
        yield {"path": "/opt/rush/clis/k/harness", "key": "k"}

    rig = make_rig(tmp_path, install_cli=install)
    async with rig.client() as client:
        answered = await client.post("/cli", json={"name": "claude", "expect": None})
        assert answered.status_code == 200 and [json.loads(line) for line in answered.text.splitlines()] == [
            {"installing": "Claude Code", "version": "2.1.325"}, {"path": "/opt/rush/clis/k/harness", "key": "k"},
        ]  # fmt: skip
        assert (await client.post("/cli", json={"name": 3})).status_code == 400
        assert (await client.post("/cli", json={"name": "claude"}, headers={"authorization": "Bearer nope"})).status_code == 401
    assert asked == [("claude", None)]
