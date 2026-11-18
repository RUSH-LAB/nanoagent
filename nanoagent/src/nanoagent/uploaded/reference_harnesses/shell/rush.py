"""`rush save <name> [-- <command>]`, in the RUSH terminal: what the member built there, saved in RUSH as a harness of theirs.

The snapshot is the case workspace as it is: every file in it but the case's own (prompt.md, request.json, answer.json) and
.rush/, the terminal's own folder. A link in it fails the save, as a source holds none. The Python packages the member installed
(`pip install`, which lands in .rush/python) are saved as a hashed requirements.txt for this VM's platform, which the harness's
build installs from the worker's verified wheels, never from the network. The harness runs <command>, as typed after `--`, or
the last command typed before `rush save`, in a workspace holding the saved files and the next case's prompt.md and
request.json, with the same environment. It is sent to RUSH through the attempt's services, which check it as any source is
checked, and becomes the member's harness <name>, at a version of its content.
"""

import hashlib
import io
import json
import os
import platform
import re
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")  # the harness contract's HarnessName
CASE_FILES = {"prompt.md", "request.json", "answer.json", ".rush"}
UV = "/opt/rush-tools/uv"
USAGE = "usage: rush save <name> [-- <command>]"


def fail(message: str) -> None:
    sys.exit(f"rush: {message}")


def command_of(argv: list[str]) -> str:
    """What the saved harness runs: the text after `--` on the `rush save` line as typed, or the command typed before it."""
    if "--" in argv:
        line = os.environ["RUSH_LINE"]
        if " -- " not in line:
            fail("write the command after ` -- ` on the rush save line")
        command = line.split(" -- ", 1)[1].strip()
    else:
        command = os.environ["RUSH_LAST"].strip()
    if not command:
        fail("no command to save: run your agent first, or give its command after --")
    return command


def workspace_files(workspace: Path) -> tuple[dict[str, bytes], list[str]]:
    """The snapshot's files by their path in the workspace, and the executable ones."""
    files: dict[str, bytes] = {}
    executables: list[str] = []
    links: list[str] = []
    for root, directories, names in os.walk(workspace):
        here = Path(root)
        if here == workspace:
            directories[:] = [name for name in directories if name not in CASE_FILES]
            names = [name for name in names if name not in CASE_FILES]
        for name in [*directories, *names]:
            if (here / name).is_symlink():
                links.append((here / name).relative_to(workspace).as_posix())
        directories[:] = [name for name in directories if not (here / name).is_symlink()]
        for name in names:
            entry = here / name
            mode = entry.lstat().st_mode
            if stat.S_ISLNK(mode):
                continue
            relative = entry.relative_to(workspace).as_posix()
            if not stat.S_ISREG(mode):
                fail(f"{relative} is not a regular file")
            files[relative] = entry.read_bytes()
            if mode & stat.S_IXUSR:
                executables.append(relative)
    if links:
        fail(f"a harness holds no links; remove or replace: {', '.join(sorted(links))}")
    return files, sorted(executables)


def requirements() -> bytes | None:
    """The member's installed packages, pinned and hashed for this platform's wheels, or None when they installed none."""
    frozen = subprocess.run([sys.executable, "-m", "pip", "freeze", "--user", "--exclude-editable"], capture_output=True, text=True, check=True).stdout
    if not frozen.strip():
        return None
    with tempfile.TemporaryDirectory() as scratch:
        (Path(scratch) / "requirements.in").write_text(frozen, encoding="utf-8")
        target = f"{platform.machine()}-unknown-linux-gnu"
        version = f"{sys.version_info.major}.{sys.version_info.minor}"
        done = subprocess.run(
            [UV, "pip", "compile", "requirements.in", "--generate-hashes", "--only-binary", ":all:", "--python-platform", target,
             "--python-version", version, "--no-header", "--quiet", "-o", "requirements.txt"],
            cwd=scratch, env={**os.environ, "UV_CACHE_DIR": f"{scratch}/cache"}, capture_output=True, text=True,
        )  # fmt: skip
        if done.returncode:
            fail(f"your packages cannot be locked to wheels for {target}:\n{done.stderr.strip()}")
        return (Path(scratch) / "requirements.txt").read_bytes()


def manifest(name: str, version: str, command: str, locked: bool) -> str:
    copy = "cp -R shell.py executables workspace /build-out/"
    install = " && python -m pip install --quiet --no-index --find-links /deps --require-hashes --target /build-out/site -r requirements.txt"
    outputs = ["shell.py", "executables", "workspace", *(["site"] if locked else [])]
    return "\n".join([
        "protocol: rush.harness.v1",
        f"name: {name}",
        f"version: {json.dumps(version)}",
        "dialects: [chat_completions, responses, anthropic_messages]",
        "toolchain: python-3",
        f"lockfiles: {json.dumps(['requirements.txt'] if locked else [])}",
        "# Saved by `rush save` in the RUSH terminal: the files built there (workspace/) and the packages installed (requirements.txt).",
        "build:",
        f"  argv: {json.dumps(['sh', '-c', copy + (install if locked else '')])}",
        f"  outputs: {json.dumps(outputs)}",
        "run:",
        f"  argv: {json.dumps(['python', '/harness/shell.py', command])}",
        "",
    ])  # fmt: skip


def save(name: str, command: str) -> None:
    request = json.loads(Path(os.environ["RUSH_REQUEST"]).read_text(encoding="utf-8"))
    files, executables = workspace_files(Path(request["workspace"]))
    locked = requirements()
    parts = {f"workspace/{path}": data for path, data in files.items()}
    parts |= {"shell.py": (HERE / "shell.py").read_bytes(), "executables": "".join(f"{path}\n" for path in executables).encode()}
    if locked is not None:
        parts["requirements.txt"] = locked
    digest = hashlib.sha256(command.encode())
    for path in sorted(parts):
        digest.update(b"\0" + path.encode() + b"\0" + hashlib.sha256(parts[path]).digest())
    version = digest.hexdigest()[:12]
    parts["harness.yaml"] = manifest(name, version, command, locked is not None).encode()
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as out:
        out.writestr(zipfile.ZipInfo("workspace/"), b"")
        for path in sorted(parts):
            out.writestr(path, parts[path])
    url = request["exec_url"].removesuffix("/exec") + "/harness"
    sent = urllib.request.Request(url, data=archive.getvalue(), method="POST", headers={
        "Content-Type": "application/zip", "Authorization": f"Bearer {os.environ['RUSH_ATTEMPT_TOKEN']}",
    })  # fmt: skip
    try:
        with urllib.request.urlopen(sent, timeout=300) as response:
            saved = json.loads(response.read())
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")
        try:
            body = json.loads(body)["error"]["message"]  # the attempt services' refusal, RUSH's passed on
        except (ValueError, KeyError, TypeError):
            pass
        fail(f"RUSH did not save it: {error.code} {body}")
    packages = 0 if locked is None else sum(1 for line in locked.decode().splitlines() if "==" in line)
    print(f"saved {saved['harness']['name']}@{saved['harness']['version']}: {len(files)} files, {packages} packages, runs: {command}")
    print(f"run it again with `nanoagent harness plugin=<plugin> harness={name}`, or pick {name} in the Harness tab")


def main(argv: list[str]) -> None:
    if len(argv) < 2 or argv[0] != "save" or (len(argv) > 2 and argv[2] != "--"):
        fail(USAGE)
    if not NAME.match(argv[1]):
        fail(f"{argv[1]!r} is not a harness name: lowercase letters, digits, '.', '_' and '-', starting with a letter or digit")
    save(argv[1], command_of(argv))


if __name__ == "__main__":
    main(sys.argv[1:])
