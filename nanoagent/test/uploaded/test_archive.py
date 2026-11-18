"""Link-safe tar extraction."""

from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest

from nanoagent.uploaded.archive import extract_tar


@pytest.mark.parametrize("raw_name, escaped", [(b"\xff.txt", "\\udcff.txt"), (b"\xc3\xa9\xff.txt", "é\\udcff.txt")])
def test_a_name_that_is_not_utf8_is_skipped_not_extracted(tmp_path: Path, raw_name: bytes, escaped: str) -> None:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT, encoding="utf-8", errors="surrogateescape") as archive:
        for name, data in (("workspace/answer.json", b"{}"), ((b"workspace/" + raw_name).decode("utf-8", "surrogateescape"), b"x")):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    extracted = extract_tar(buffer.getvalue(), tmp_path / "out", root_name="workspace", max_files=10, max_bytes=1 << 20)
    assert list(extracted.files) == ["answer.json"]
    assert extracted.skipped == {escaped: "invalid_name"}
    assert [p.name for p in (tmp_path / "out").iterdir()] == ["answer.json"]
