from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest
from fakes import FEED, FakeArxiv, Response

from plugin.search import search_papers


def test_returns_papers_best_match_first() -> None:
    arxiv = FakeArxiv("1706.03762v7", "hep-th/9901001v1")
    result = search_papers(' ti:"attention" ', 2, opener=arxiv)
    assert result["query"] == 'ti:"attention"'
    assert [paper["arxiv_id"] for paper in result["papers"]] == ["1706.03762v7", "hep-th/9901001v1"]
    first = result["papers"][0]
    assert first["title"] == "Paper 1706.03762v7 Wrapped"
    assert first["authors"] == ["Ashish Vaswani", "Noam Shazeer"]
    assert first["summary"] == "An abstract."
    assert first["abs_url"] == "http://arxiv.org/abs/1706.03762v7"
    query = parse_qs(urlparse(arxiv.urls[0]).query)
    assert query == {"search_query": ['ti:"attention"'], "start": ["0"], "max_results": ["2"]}


def test_reports_a_rejected_query() -> None:
    error = FEED.format(
        entries="<entry><id>https://arxiv.org/api/errors</id><summary>Invalid query string: '('</summary></entry>"
    )
    with pytest.raises(ValueError, match="Invalid query string"):
        search_papers("ti:(", 1, opener=lambda request: Response(error.encode()))


@pytest.mark.parametrize(("query", "count"), [("  ", 1), ("ti:x", 0), ("ti:x", 51)])
def test_rejects_bad_input(query: str, count: int) -> None:
    with pytest.raises(ValueError):
        search_papers(query, count, opener=FakeArxiv())
