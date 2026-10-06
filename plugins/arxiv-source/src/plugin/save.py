from __future__ import annotations

import time
import urllib.request
from pathlib import Path

from plugin.download import download_source, resolve_destination
from plugin.search import search_papers

MAX_SAVED = 10
# arXiv asks API clients to wait 3 seconds between requests.
PAUSE = 3.0


def paper_folder(arxiv_id: str) -> str:
    """The folder name for one paper: legacy IDs (`hep-th/9901001`) contain a slash."""
    return arxiv_id.replace("/", "_")


def save_search_results(
    query: str,
    max_results: int,
    destination: str,
    *,
    workspace: Path,
    opener=urllib.request.urlopen,
    pause: float = PAUSE,
) -> dict:
    """Search arXiv, then download and unpack every result's source into `destination/<arxiv id>/`."""
    if not 1 <= max_results <= MAX_SAVED:
        raise ValueError(f"max_results must be between 1 and {MAX_SAVED}")
    folder = resolve_destination(workspace, destination)
    if folder.exists():
        raise FileExistsError(f"destination already exists: {destination}")
    found = search_papers(query, max_results, opener=opener)
    folder.mkdir(parents=True)
    papers = []
    for paper in found["papers"]:
        time.sleep(pause)
        saved = download_source(
            paper["arxiv_id"],
            str(Path(destination) / paper_folder(paper["arxiv_id"])),
            workspace=workspace,
            opener=opener,
        )
        papers.append({**paper, "source_url": saved["source_url"], "folder": saved["folder"], "files": saved["files"]})
    return {"ok": True, "query": found["query"], "folder": str(folder), "papers": papers}
