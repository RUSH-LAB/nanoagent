"""The reference harnesses NanoAgent ships (``reference_harnesses/<name>/``), each built into the ZIP RUSH takes.

A reference's name is its folder's. Its version is derived from its content: the manifest's ``version`` is stamped with a short
sha256 of the folder's files (the NanoAgent reference's folder is the one `assemble.py` makes from the working tree), so the
same reference always builds to the same ZIP under the same version, and a changed one is a new version.
"""

from __future__ import annotations

import hashlib
import re
import shutil
import tempfile
from pathlib import Path

from nanoagent.uploaded.reference_harnesses.nanoagent.assemble import IGNORE, assemble
from nanoagent.uploaded.source_zip import zip_folder

FOLDER = Path(__file__).resolve().parent / "reference_harnesses"
NAMES = tuple(sorted(entry.name for entry in FOLDER.iterdir() if entry.is_dir() and entry.name != "__pycache__"))
MANIFEST = "harness.yaml"


def content_version(folder: Path) -> str:
    """A short sha256 of the files of ``folder``: their paths and bytes, in path order."""
    digest = hashlib.sha256()
    for entry in sorted(folder.rglob("*"), key=lambda entry: entry.relative_to(folder).as_posix()):
        if entry.is_file():
            digest.update(entry.relative_to(folder).as_posix().encode() + b"\0" + hashlib.sha256(entry.read_bytes()).digest())
    return digest.hexdigest()[:12]


def build_reference(name: str) -> bytes:
    """The ZIP of reference ``name``, its manifest's version the content's."""
    if name not in NAMES:
        raise ValueError(f"{name} is not a reference harness; they are {', '.join(NAMES)}")
    with tempfile.TemporaryDirectory() as scratch:
        folder = Path(scratch) / name
        if name == "nanoagent":
            assemble(folder)
        else:
            shutil.copytree(FOLDER / name, folder, ignore=IGNORE)
        manifest = folder / MANIFEST
        stamped, count = re.subn(r"^version:.*$", f'version: "{content_version(folder)}"', manifest.read_text(encoding="utf-8"), count=1, flags=re.MULTILINE)
        if not count:
            raise ValueError(f"{name}'s {MANIFEST} declares no version")
        manifest.write_text(stamped, encoding="utf-8")
        return zip_folder(folder)
