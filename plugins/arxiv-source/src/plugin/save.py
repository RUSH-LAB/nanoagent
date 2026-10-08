from __future__ import annotations

import time
import urllib.request
from dataclasses import asdict
from pathlib import Path

from contract import DownloadInput, SavedPaper, SaveInput, SaveOutput, SearchInput
from plugin.download import download_source, resolve_destination
from plugin.search import search_papers

MAX_SAVED = 10
# arXiv asks API clients to wait 3 seconds between requests.
PAUSE = 3.0


def paper_folder(arxiv_id: str) -> str:
    """The folder name for one paper: legacy IDs (`hep-th/9901001`) contain a slash."""
    return arxiv_id.replace("/", "_")


def save_search_results(
    given: SaveInput, workspace: Path, *, opener=urllib.request.urlopen, pause: float = PAUSE
) -> SaveOutput:
    """Search arXiv, then download and unpack every result's source into `destination/<arxiv id>/`."""
    if not 1 <= given.max_results <= MAX_SAVED:
        raise ValueError(f"max_results must be between 1 and {MAX_SAVED}")
    folder = resolve_destination(workspace, given.destination)
    if folder.exists():
        raise FileExistsError(f"destination already exists: {given.destination}")
    found = search_papers(SearchInput(query=given.query, max_results=given.max_results), workspace, opener=opener)
    folder.mkdir(parents=True)
    papers = []
    for paper in found.papers:
        time.sleep(pause)
        destination = str(Path(given.destination) / paper_folder(paper.arxiv_id))
        given_paper = DownloadInput(arxiv_id=paper.arxiv_id, destination=destination)
        saved = download_source(given_paper, workspace, opener=opener)
        papers.append(SavedPaper(**asdict(paper), source_url=saved.source_url, folder=saved.folder, files=saved.files))
    return SaveOutput(query=found.query, folder=str(folder), papers=papers)
