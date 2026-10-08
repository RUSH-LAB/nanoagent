"""The daily digest: who published what on a date, each paper saved under `docs/raw/`, and the digest."""

from __future__ import annotations

import json
import re
import time
import urllib.request
from datetime import date as Date
from pathlib import Path

from slimconfig import plain_output

from contract import (
    DailyInput,
    DailyOutput,
    DailyPaper,
    DigestInput,
    DigestOutput,
    DownloadInput,
    Person,
    RawInput,
    RawOutput,
    SearchInput,
)
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


def list_daily_papers(
    given: DailyInput, workspace: Path, *, opener=urllib.request.urlopen, pause: float = PAUSE
) -> DailyOutput:
    """For each person, the papers arXiv lists with them as an author, first submitted on the date."""
    people = given.people
    if not people or len(set(people)) != len(people) or any('"' in person or not person.strip() for person in people):
        raise ValueError("people must be distinct, non-empty names without quotes")
    clause = submitted_on(given.date)
    listing = []
    for index, person in enumerate(people):
        if index:
            time.sleep(pause)
        query = SearchInput(query=f'au:"{person.strip()}" AND {clause}', max_results=MAX_RESULTS)
        found = search_papers(query, workspace, opener=opener)
        if len(found.papers) == MAX_RESULTS:
            raise ValueError(
                f"{person} has {MAX_RESULTS} or more papers on {given.date}: the listing would be cut short"
            )
        papers = [
            DailyPaper(
                arxiv_id=base_id(paper.arxiv_id),
                title=paper.title,
                authors=paper.authors,
                published=paper.published,
                abs_url=paper.abs_url,
            )
            for paper in found.papers
        ]
        listing.append(Person(name=person, papers=papers))
    return DailyOutput(date=given.date, people=listing)


def save_raw_paper(
    given: RawInput, workspace: Path, *, opener=urllib.request.urlopen, pause: float = PAUSE
) -> RawOutput:
    """Save a paper's source under `docs/raw/{first_author_name}-{paper_short_name}-{arxiv_id}-{date}`."""
    paper_id = base_id(given.arxiv_id)
    Date.fromisoformat(given.date)
    record = fetch_paper(paper_id, opener=opener)
    folder = f"docs/raw/{raw_folder_name(record.title, record.authors, paper_id, given.date)}"
    time.sleep(pause)
    saved = download_source(DownloadInput(arxiv_id=paper_id, destination=folder), workspace, opener=opener)
    return RawOutput(
        arxiv_id=paper_id, title=record.title, authors=record.authors, folder=saved.folder, files=saved.files
    )


def write_digest(given: DigestInput, workspace: Path) -> DigestOutput:
    """Write the digest as `docs/digest-{date}.json` and a readable `docs/digest-{date}.md`, replacing
    an earlier draft."""
    Date.fromisoformat(given.date)
    docs = workspace.resolve() / "docs"
    docs.mkdir(parents=True, exist_ok=True)
    path = docs / f"digest-{given.date}.json"
    path.write_text(json.dumps(plain_output(given), indent=2) + "\n", encoding="utf-8")
    lines = [f"# arXiv digest, {given.date}", ""]
    for entry in given.entries:
        lines += [f"## [{entry.title}]({entry.link})", "", ", ".join(entry.authors), "", entry.summary, ""]
    markdown = docs / f"digest-{given.date}.md"
    markdown.write_text("\n".join(lines), encoding="utf-8")
    return DigestOutput(path=str(path), markdown=str(markdown), entries=len(given.entries))
