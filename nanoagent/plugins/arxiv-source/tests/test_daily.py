from __future__ import annotations

from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from fakes import FakeArxiv

from contract import DailyInput, RawInput
from plugin.daily import list_daily_papers, save_raw_paper
from plugin.naming import raw_folder_name


def test_lists_each_persons_papers_first_submitted_on_the_date(tmp_path: Path) -> None:
    arxiv = FakeArxiv("2609.10630v2")
    given = DailyInput(people=["Yoshua Bengio", "Ashish Vaswani"], date="2026-09-09")
    listing = list_daily_papers(given, tmp_path, opener=arxiv, pause=0)
    assert [person.name for person in listing.people] == ["Yoshua Bengio", "Ashish Vaswani"]
    assert listing.people[0].papers[0].arxiv_id == "2609.10630"
    query = parse_qs(urlparse(arxiv.urls[0]).query)["search_query"][0]
    assert query == 'au:"Yoshua Bengio" AND submittedDate:[202609090000 TO 202609092359]'


@pytest.mark.parametrize("people", [[], ["A", "A"], ['Say "hi"']])
def test_rejects_bad_people(tmp_path: Path, people: list[str]) -> None:
    with pytest.raises(ValueError):
        list_daily_papers(DailyInput(people=people, date="2026-09-09"), tmp_path, opener=FakeArxiv(), pause=0)


def test_saves_a_paper_under_its_raw_folder_name(tmp_path: Path) -> None:
    saved = save_raw_paper(RawInput(arxiv_id="2609.10630v1", date="2026-09-09"), tmp_path, opener=FakeArxiv(), pause=0)
    name = "vaswani-paper-2609-10630-wrapped-2609.10630-2026-09-09"
    assert saved.folder == str(tmp_path / "docs" / "raw" / name)
    assert (tmp_path / "docs" / "raw" / name / "main.tex").read_text() == "2609.10630"


def test_rejects_old_style_ids(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="YYMM.NNNNN"):
        save_raw_paper(RawInput(arxiv_id="hep-th/9901001", date="2026-09-09"), tmp_path, opener=FakeArxiv(), pause=0)


def test_raw_folder_name_uses_last_name_and_four_title_words() -> None:
    name = raw_folder_name("Attention Is All You Need", ["Łukasz Kaiser"], "1706.03762", "2017-06-12")
    assert name == "kaiser-attention-is-all-you-1706.03762-2017-06-12"
