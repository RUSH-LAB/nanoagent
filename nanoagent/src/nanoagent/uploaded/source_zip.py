"""The deterministic ZIP of a harness source folder."""

from __future__ import annotations

import io
import stat
import zipfile
from pathlib import Path

FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def zip_folder(root: Path) -> bytes:
    """The ZIP of folder ``root``, byte for byte the same whenever its files are: sorted entries, fixed
    timestamps and modes, no links."""
    entries = sorted(root.rglob("*"), key=lambda entry: entry.relative_to(root).as_posix())
    for entry in entries:
        if entry.is_symlink():
            raise ValueError(f"{entry} is a symlink; a source holds none")
    files = [entry for entry in entries if entry.is_file()]
    if not files:
        raise ValueError(f"{root} holds no files")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for entry in files:
            info = zipfile.ZipInfo(entry.relative_to(root).as_posix(), FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            executable = entry.stat().st_mode & stat.S_IXUSR
            info.external_attr = (0o100755 if executable else 0o100644) << 16
            archive.writestr(info, entry.read_bytes())
    return buffer.getvalue()
