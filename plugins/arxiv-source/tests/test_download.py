from __future__ import annotations

import gzip
from pathlib import Path

import pytest
from fakes import Response, tar_bytes

from contract import DownloadInput
from plugin.download import download_source, unpack_source


def test_unpacks_tar_archive(tmp_path: Path) -> None:
    destination = tmp_path / "paper"
    destination.mkdir()
    files = unpack_source(tar_bytes({"main.tex": b"hello", "figures/a.txt": b"a"}), destination)
    assert files == ["figures/a.txt", "main.tex"]
    assert (destination / "main.tex").read_text() == "hello"


def test_unpacks_single_gzip_file(tmp_path: Path) -> None:
    destination = tmp_path / "paper"
    destination.mkdir()
    assert unpack_source(gzip.compress(b"\\documentclass{article}"), destination) == ["main.tex"]


def test_rejects_path_traversal(tmp_path: Path) -> None:
    destination = tmp_path / "paper"
    destination.mkdir()
    with pytest.raises(ValueError, match="unsafe archive path"):
        unpack_source(tar_bytes({"../outside.tex": b"bad"}), destination)


def test_downloads_from_arxiv_eprint_endpoint(tmp_path: Path) -> None:
    result = download_source(
        DownloadInput(arxiv_id="1706.03762v7", destination="attention"),
        tmp_path,
        opener=lambda request: Response(tar_bytes({"main.tex": b"attention"})),
    )
    assert result.source_url.endswith("/1706.03762v7")
    assert result.files == ["main.tex"]


def test_rejects_invalid_id_and_existing_destination(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="invalid"):
        download_source(DownloadInput(arxiv_id="../../secret", destination="bad"), tmp_path)
    existing = tmp_path / "existing"
    existing.mkdir()
    with pytest.raises(FileExistsError):
        download_source(DownloadInput(arxiv_id="1706.03762", destination="existing"), tmp_path)

    with pytest.raises(ValueError, match="workspace"):
        download_source(DownloadInput(arxiv_id="1706.03762", destination="../outside"), tmp_path)
