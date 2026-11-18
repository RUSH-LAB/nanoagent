"""`rush save` in the RUSH terminal: the snapshot it takes, the manifest it writes, and the attempt services' route that checks
the ZIP as any source and hands it to RUSH."""

from __future__ import annotations

import importlib.util
import io
import zipfile
from pathlib import Path
from typing import Any

import pytest

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
        assert (manifest.name, manifest.version, manifest.toolchain) == ("my-agent", "0123456789ab", "python-3")
        assert manifest.run_argv == ("python", "/harness/shell.py", 'aider --message "$RUSH_PROMPT"')
        assert manifest.lockfiles == (("requirements.txt",) if locked else ())


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
