from __future__ import annotations

from pathlib import Path

import pytest
from fakes import FakeArxiv

from plugin.save import save_search_results


def test_saves_every_result_in_its_own_folder(tmp_path: Path) -> None:
    arxiv = FakeArxiv("1706.03762v7", "hep-th/9901001v1")
    result = save_search_results("ti:attention", 2, "papers", workspace=tmp_path, opener=arxiv, pause=0)
    assert result["folder"] == str(tmp_path / "papers")
    assert [paper["folder"] for paper in result["papers"]] == [
        str(tmp_path / "papers" / "1706.03762v7"),
        str(tmp_path / "papers" / "hep-th_9901001v1"),
    ]
    assert (tmp_path / "papers" / "hep-th_9901001v1" / "main.tex").read_text() == "hep-th/9901001v1"
    assert arxiv.urls[1:] == [
        "https://export.arxiv.org/e-print/1706.03762v7",
        "https://export.arxiv.org/e-print/hep-th/9901001v1",
    ]


def test_refuses_an_existing_destination_before_searching(tmp_path: Path) -> None:
    (tmp_path / "papers").mkdir()
    arxiv = FakeArxiv("1706.03762v7")
    with pytest.raises(FileExistsError):
        save_search_results("ti:attention", 1, "papers", workspace=tmp_path, opener=arxiv, pause=0)
    assert arxiv.urls == []


def test_rejects_more_than_ten_papers(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="between 1 and 10"):
        save_search_results("ti:attention", 11, "papers", workspace=tmp_path, opener=FakeArxiv(), pause=0)
