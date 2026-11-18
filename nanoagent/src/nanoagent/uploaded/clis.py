"""The agent CLIs a RUSH terminal installs the first time a member types one (reference harness `shell`, its bin/ wrappers).

Each is its reference harness, built by the worker as any harness is: the reference's own lockfile staged with every
artifact's integrity or sha256 checked, in a build VM with no network. The install is kept on the member's computer under
the worker's scratch, keyed by that lockfile, and mounted read-only into every case VM at `CLIS_DIR`, so a second session,
and a harness saved from the first, runs the same install at once.
"""

from __future__ import annotations

import hashlib
import json
import platform
import re
from dataclasses import dataclass

from nanoagent.uploaded.contract import parse_manifest
from nanoagent.uploaded.reference import FOLDER, MANIFEST


@dataclass(frozen=True)
class Cli:
    name: str  # what the member types
    reference: str  # the reference harness that installs it
    label: str
    package: str  # its package in the reference's lock (npm or PyPI)

    def version(self) -> str:
        """The version the reference's lock pins."""
        folder = FOLDER / self.reference
        if (folder / "package.json").is_file():
            return json.loads((folder / "package.json").read_text(encoding="utf-8"))["dependencies"][self.package]
        pin = re.search(rf"^{re.escape(self.package)}==(\S+)", (folder / "requirements.in").read_text(encoding="utf-8"), re.MULTILINE)
        assert pin is not None, f"{self.reference}/requirements.in pins no {self.package}"
        return pin[1]

    def key(self, build_image: str) -> str:
        """The install's key: the reference's lockfiles, the image they build in and this machine's architecture."""
        folder = FOLDER / self.reference
        digest = hashlib.sha256(f"{self.reference}\0{build_image}\0{platform.machine()}".encode())
        for lockfile in parse_manifest((folder / MANIFEST).read_bytes()).lockfiles:
            digest.update(b"\0" + lockfile.encode() + b"\0" + hashlib.sha256((folder / lockfile).read_bytes()).digest())
        return digest.hexdigest()[:32]


CLIS = {
    cli.name: cli
    for cli in (
        Cli("claude", "claude-code", "Claude Code", "@anthropic-ai/claude-code"),
        Cli("codex", "codex", "Codex", "@openai/codex"),
        Cli("pi", "pi", "PI", "@earendil-works/pi-coding-agent"),
        Cli("dsh", "dsh", "DeepSeek Harness", "@deepseek-ai/dsh"),
        Cli("hermes", "hermes", "Hermes Agent", "hermes-agent"),
    )
}
