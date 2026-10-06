from __future__ import annotations

import urllib.parse
import urllib.request
from xml.etree import ElementTree

from plugin.download import HEADERS, read_limited

API = "https://export.arxiv.org/api/query"
ATOM = "{http://www.w3.org/2005/Atom}"
MAX_RESULTS = 50
MAX_FEED = 10 * 1024 * 1024


def _text(entry: ElementTree.Element, tag: str) -> str:
    """The element's text with its whitespace collapsed (arXiv wraps titles and abstracts)."""
    return " ".join((entry.findtext(f"{ATOM}{tag}") or "").split())


def _paper(entry: ElementTree.Element) -> dict:
    abs_url = _text(entry, "id")
    return {
        "arxiv_id": abs_url.rsplit("/abs/", 1)[-1],
        "title": _text(entry, "title"),
        "authors": [" ".join(name.text.split()) for name in entry.findall(f"{ATOM}author/{ATOM}name") if name.text],
        "summary": _text(entry, "summary"),
        "published": _text(entry, "published"),
        "abs_url": abs_url,
    }


def query_api(params: dict, *, opener=urllib.request.urlopen) -> tuple[str, list[dict]]:
    """Ask the arXiv API; return the request URL and the papers it lists, best match first."""
    url = f"{API}?{urllib.parse.urlencode(params)}"
    with opener(urllib.request.Request(url, headers=HEADERS)) as response:
        feed = ElementTree.fromstring(read_limited(response, MAX_FEED))
    entries = feed.findall(f"{ATOM}entry")
    # A rejected query comes back as a single entry whose id is arXiv's error page.
    if len(entries) == 1 and "/api/errors" in _text(entries[0], "id"):
        raise ValueError(f"arXiv rejected the query: {_text(entries[0], 'summary')}")
    return url, [_paper(entry) for entry in entries]


def search_papers(query: str, max_results: int, *, opener=urllib.request.urlopen) -> dict:
    """Search arXiv with its query syntax (e.g. `ti:"attention is all you need"`), best match first."""
    text = query.strip()
    if not text:
        raise ValueError("query must not be empty")
    if not 1 <= max_results <= MAX_RESULTS:
        raise ValueError(f"max_results must be between 1 and {MAX_RESULTS}")
    url, papers = query_api({"search_query": text, "start": 0, "max_results": max_results}, opener=opener)
    return {"ok": True, "query": text, "source_url": url, "papers": papers}


def fetch_paper(arxiv_id: str, *, opener=urllib.request.urlopen) -> dict:
    """The arXiv record of one paper."""
    _, papers = query_api({"id_list": arxiv_id, "max_results": 1}, opener=opener)
    if len(papers) != 1 or not papers[0]["title"]:
        raise ValueError(f"arXiv has no paper {arxiv_id}")
    return papers[0]
