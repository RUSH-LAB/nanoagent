"""Variants of the acceptance-probe plugin for the prompt and scoring gates, generated from the fixture at test time (the
fixture itself is never edited) and the real marketplace publish and prune for a new version of one.

A variant changes only what a gate needs: the plugin id (and so its package), the version, the manifest's instructions, and
a task without a reference tool, a decide task, declared egress hosts, a verifier that raises for one token (a verifier failure) or one that fails every answer (to show a retained run keeps the verifier it was pinned with).
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

HELPINGHANDS = Path(__file__).resolve().parents[4] / "helpinghands"
PROBE = Path(__file__).resolve().parents[2] / "plugins" / "acceptance-probe"
PUBLISH = Path(__file__).with_name("publish_version.js")
IGNORED = shutil.ignore_patterns(".venv", "__pycache__", "*.egg-info", ".ruff_cache", ".pytest_cache")

CRASH_TOKEN = "verifier-crash"
# What the verifier's exception says: a private diagnostic that must never reach a member.
CRASH_DETAIL = "private-verifier-diagnostic-4f9c1e"


def variant(
    destination: Path,
    *,
    plugin_id: str = "acceptance-probe",
    version: str = "0.1.0",
    instructions: str | None = None,
    crash_token: bool = False,
    fail_every_answer: bool = False,
    no_reference: bool = False,
    decide: bool = False,
    hosts: tuple[str, ...] = (),
) -> Path:
    """A copy of the probe plugin at ``destination`` as plugin ``plugin_id`` at ``version``.

    ``no_reference`` drops the task's reference tool: its verifier judges an answer from the case's input alone (the probe's
    digest of the token). ``decide`` makes the task a decide task over the `wait` tool, again with no reference tool, whose
    right output is the token itself (the one string a decider can copy). ``hosts`` are the HTTPS hosts the plugin declares."""
    shutil.copytree(PROBE, destination, ignore=IGNORED)

    def edit(name: str, change) -> None:
        path = destination / name
        path.write_text(change(path.read_text()))

    def replaced(text: str, old: str, new: str, count: int = 1) -> str:
        assert text.count(old) >= 1, old
        return text.replace(old, new, count)

    edit(
        "nanoagent.yaml",
        lambda text: replaced(replaced(text, "id: acceptance-probe\n", f"id: {plugin_id}\n"), "version: 0.1.0\n", f"version: {version}\n"),
    )
    edit(
        "pyproject.toml",
        lambda text: replaced(
            replaced(text, 'name = "nanoagent-acceptance-probe"', f'name = "nanoagent-{plugin_id}"'), 'version = "0.1.0"', f'version = "{version}"'
        ),
    )
    edit(
        "uv.lock",
        lambda text: re.sub(
            r'name = "nanoagent-acceptance-probe"\nversion = "0.1.0"', f'name = "nanoagent-{plugin_id}"\nversion = "{version}"', text, count=1
        ),
    )
    if instructions is not None:
        indented = "\n".join(f"      {line}" for line in instructions.splitlines())
        edit("nanoagent.yaml", lambda text: re.sub(r"    instructions: \|-\n(?:      .*\n?)+", f"    instructions: |-\n{indented}\n", text))
    if hosts:
        edit("nanoagent.yaml", lambda text: replaced(text, "    hosts: []", "    hosts: [" + ", ".join(hosts) + "]"))
    if no_reference or decide:
        edit("nanoagent.yaml", lambda text: replaced(text, "    reference: digest\n", "    reference: null\n"))
        expected = "arguments.token" if decide else "hashlib.sha256(arguments.token.encode()).hexdigest()[:12]"
        edit(
            "verifier/digest.py",
            lambda text: replaced(text, "    valid = output.digest == reference.digest\n", f"    valid = output.digest == {expected}\n").replace(
                'f"digest {output.digest!r} is not {reference.digest!r}"', '"digest is wrong"'
            ),
        )
    if decide:
        edit("nanoagent.yaml", lambda text: replaced(text, "    runner: agent\n", "    runner: decide\n"))
    if crash_token:
        edit(
            "verifier/digest.py",
            lambda text: replaced(
                text,
                "def verify_task(arguments, output, reference, workspace):\n",
                "def verify_task(arguments, output, reference, workspace):\n"
                f"    if arguments.token == {CRASH_TOKEN!r}:\n"
                f"        raise RuntimeError({CRASH_DETAIL!r} + ' ' + repr(reference))\n",
            ),
        )
    if fail_every_answer:
        edit("verifier/digest.py", lambda text: replaced(text, "    valid = output.digest ==", "    valid = False and output.digest =="))
    return destination


def publish_version(database: str, owner_id: str, package: Path, entry_json: Path) -> None:
    """Publish ``package`` as a new version of the owner's plugin with the real marketplace code, which prunes the versions no
    member stays on (helpinghands/src/server/postgres/market.js ``publish``), exactly as the owner's publish does."""
    done = subprocess.run(
        ["node", str(PUBLISH), database, owner_id, str(package), str(entry_json)],
        cwd=HELPINGHANDS,
        capture_output=True,
        text=True,
    )
    assert done.returncode == 0, done.stdout + done.stderr
