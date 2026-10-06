"""The daily digest: who published what on a date, each paper saved under `docs/raw/`, and the digest."""

from __future__ import annotations

import json
import re
import time
import urllib.request
from datetime import date as Date
from pathlib import Path

from plugin.download import download_source
from plugin.naming import raw_folder_name
from plugin.search import MAX_RESULTS, fetch_paper, search_papers

# arXiv asks API clients to wait 3 seconds between requests.
PAUSE = 3.0
NEW_ID = re.compile(r"^\d{4}\.\d{5}$")
VERSION = re.compile(r"v\d+$")


def submitted_on(date: str) -> str:
    """The search clause for papers first submitted on ``date`` (YYYY-MM-DD, UTC)."""
    day = Date.fromisoformat(date).strftime("%Y%m%d")
    return f"submittedDate:[{day}0000 TO {day}2359]"


def base_id(arxiv_id: str) -> str:
    """The id without its version, which must be the `YYMM.NNNNN` form."""
    paper = VERSION.sub("", arxiv_id.strip())
    if not NEW_ID.fullmatch(paper):
        raise ValueError(f"{arxiv_id!r} is not an arXiv id of the form YYMM.NNNNN")
    return paper


def list_daily_papers(people: list[str], date: str, *, opener=urllib.request.urlopen, pause: float = PAUSE) -> dict:
    """For each person, the papers arXiv lists with them as an author, first submitted on ``date``."""
    if not people or len(set(people)) != len(people) or any('"' in person or not person.strip() for person in people):
        raise ValueError("people must be distinct, non-empty names without quotes")
    clause = submitted_on(date)
    listing = []
    for index, person in enumerate(people):
        if index:
            time.sleep(pause)
        found = search_papers(f'au:"{person.strip()}" AND {clause}', MAX_RESULTS, opener=opener)
        if len(found["papers"]) == MAX_RESULTS:
            raise ValueError(f"{person} has {MAX_RESULTS} or more papers on {date}: the listing would be cut short")
        papers = [
            {key: paper[key] for key in ("title", "authors", "published", "abs_url")} | {"arxiv_id": base_id(paper["arxiv_id"])}
            for paper in found["papers"]
        ]
        listing.append({"name": person, "papers": papers})
    return {"ok": True, "date": date, "people": listing}


def save_raw_paper(
    arxiv_id: str, date: str, *, workspace: Path, opener=urllib.request.urlopen, pause: float = PAUSE
) -> dict:
    """Save a paper's source under `docs/raw/{first_author_name}-{paper_short_name}-{arxiv_id}-{date}`."""
    paper_id = base_id(arxiv_id)
    Date.fromisoformat(date)
    record = fetch_paper(paper_id, opener=opener)
    folder = f"docs/raw/{raw_folder_name(record['title'], record['authors'], paper_id, date)}"
    time.sleep(pause)
    saved = download_source(paper_id, folder, workspace=workspace, opener=opener)
    return {
        "ok": True,
        "arxiv_id": paper_id,
        "title": record["title"],
        "authors": record["authors"],
        "folder": saved["folder"],
        "files": saved["files"],
    }


def write_digest(date: str, entries: list[dict], *, workspace: Path) -> dict:
    """Write the digest as `docs/digest-{date}.json` and a readable `docs/digest-{date}.md`, replacing
    an earlier draft."""
    Date.fromisoformat(date)
    docs = workspace.resolve() / "docs"
    docs.mkdir(parents=True, exist_ok=True)
    path = docs / f"digest-{date}.json"
    path.write_text(json.dumps({"date": date, "entries": entries}, indent=2) + "\n", encoding="utf-8")
    lines = [f"# arXiv digest, {date}", ""]
    for entry in entries:
        lines += [f"## [{entry['title']}]({entry['link']})", "", ", ".join(entry["authors"]), "", entry["summary"], ""]
    markdown = docs / f"digest-{date}.md"
    markdown.write_text("\n".join(lines), encoding="utf-8")
    return {"ok": True, "path": str(path), "markdown": str(markdown), "entries": len(entries)}
