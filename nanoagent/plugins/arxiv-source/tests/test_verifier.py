from __future__ import annotations

from pathlib import Path

import pytest
from fakes import FakeArxiv
from slimconfig import build_output, plain_output

import plugin.naming
import verifier
import verifier.naming
from contract import TASKS, TOOLS, DailyOutput, DownloadInput, SavedPaperOutput, SearchInput, Task, Tool
from plugin import download_source, search_papers

DATE = "2026-09-09"
PAPER = {
    "arxiv_id": "2609.10630",
    "title": "AI Safety: Not Optional, Not Later",
    "authors": ["Yoshua Bengio", "Ada Lovelace"],
    "published": "2026-09-09T06:36:05Z",
    "abs_url": "http://arxiv.org/abs/2609.10630v1",
}
REFERENCE = {"date": DATE, "people": [{"name": "Yoshua Bengio", "papers": [PAPER]}]}
ARGUMENTS = {"people": ["Yoshua Bengio"], "date": DATE}
RAW = "bengio-ai-safety-not-optional-2609.10630-2026-09-09"


# The verifier gets contract instances, as NanoAgent's sandbox builds them from JSON.
def verify_input(tool: str, value: dict) -> dict:
    return verifier.verify_input(tool, build_output(value, TOOLS[Tool(tool)][0]))


def verify_task(task: str, arguments: dict, output: dict, workspace: Path, reference=None) -> dict:
    given, made = TASKS[Task(task)]
    return verifier.verify_task(
        task, build_output(arguments, given), build_output(output, made), reference, str(workspace)
    )


def verify_digest(entries: list[dict], workspace: Path, *, date: str = DATE) -> dict:
    reference = build_output(REFERENCE, DailyOutput)
    return verify_task("write-daily-digest", ARGUMENTS, {"date": date, "entries": entries}, workspace, reference)


def entry(workspace: Path, **changes):
    value = {
        "arxiv_id": PAPER["arxiv_id"],
        "title": PAPER["title"],
        "authors": PAPER["authors"],
        "summary": "Argues safety work must start now.\nCalls for binding commitments.",
        "link": "https://arxiv.org/abs/2609.10630",
        "folder": str(workspace / "docs" / "raw" / RAW),
    }
    return value | changes


def save(workspace: Path) -> Path:
    folder = workspace / "docs" / "raw" / RAW
    folder.mkdir(parents=True)
    (folder / "main.tex").write_text("x")
    return workspace


def test_the_verifier_and_the_plugin_name_folders_alike() -> None:
    args = (PAPER["title"], PAPER["authors"], PAPER["arxiv_id"], DATE)
    assert verifier.naming.raw_folder_name(*args) == plugin.naming.raw_folder_name(*args)


def test_approves_a_complete_digest(tmp_path: Path) -> None:
    verdict = verify_digest([entry(tmp_path)], save(tmp_path))
    assert verdict["valid"] is True and verdict["score"] == 1.0


@pytest.mark.parametrize(
    ("changes", "saved", "problem"),
    [
        (None, True, "published but missing from the digest"),
        ({}, False, f"no saved source in docs/raw/{RAW}"),
        ({"title": "AI Safety"}, True, "title differs from the arXiv record"),
        ({"summary": "One line only."}, True, "summary is not exactly two lines"),
        ({"folder": "docs/raw/elsewhere"}, True, f"folder is not docs/raw/{RAW}"),
        ({"arxiv_id": "2609.10630v1"}, True, "id is not of the form YYMM.NNNNN"),
    ],
)
def test_refuses_an_incomplete_or_wrong_digest(tmp_path: Path, changes: dict | None, saved: bool, problem: str) -> None:
    entries = [] if changes is None else [entry(tmp_path, **changes)]
    verdict = verify_digest(entries, save(tmp_path) if saved else tmp_path)
    assert verdict["valid"] is False
    assert any(problem in found for found_list in verdict["details"]["problems"].values() for found in found_list)


def test_refuses_a_digest_with_an_unlisted_paper_or_for_another_date(tmp_path: Path) -> None:
    save(tmp_path)
    verdict = verify_digest([entry(tmp_path), entry(tmp_path, arxiv_id="2609.99999")], tmp_path)
    assert verdict["details"]["problems"]["2609.99999"] == [f"not a paper arXiv shows for these people on {DATE}"]
    assert verify_digest([entry(tmp_path)], tmp_path, date="2026-09-10")["valid"] is False


def test_tool_tasks_judge_their_output_as_their_tool_does(tmp_path: Path) -> None:
    query = {"query": "ti:attention", "max_results": 2}
    found = plain_output(search_papers(SearchInput(**query), tmp_path, opener=FakeArxiv("1706.03762v7")))
    assert verify_task("search-papers", query, found, tmp_path)["valid"] is True
    assert verify_task("search-papers", query | {"query": "ti:other"}, found, tmp_path)["valid"] is False
    given = {"arxiv_id": "1706.03762", "destination": "attention"}
    saved = plain_output(download_source(DownloadInput(**given), tmp_path, opener=FakeArxiv()))
    assert verify_task("save-paper-source", given, saved, tmp_path)["valid"] is True
    assert verify_task("save-paper-source", given | {"destination": "other"}, saved, tmp_path)["valid"] is False


def found_and_saved(workspace: Path) -> dict:
    found = search_papers(SearchInput(query="ti:attention", max_results=1), workspace, opener=FakeArxiv("1706.03762v7"))
    saved = download_source(
        DownloadInput(arxiv_id="1706.03762v7", destination="attention"), workspace, opener=FakeArxiv()
    )
    return plain_output(
        SavedPaperOutput(
            **plain_output(found.papers[0]), source_url=saved.source_url, folder=saved.folder, files=saved.files
        )
    )


def test_approves_the_found_paper_saved_in_the_destination(tmp_path: Path) -> None:
    request = {"request": "the transformer paper", "destination": "attention"}
    verdict = verify_task("find-and-save-paper", request, found_and_saved(tmp_path), tmp_path)
    assert verdict["valid"] is True


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"files": ["main.tex", "extra.tex"]}, "declared files differ"),
        ({"source_url": "https://export.arxiv.org/e-print/1706.99999"}, "e-print"),
        ({"abs_url": "http://arxiv.org/abs/1706.99999v1"}, "abs_url"),
        ({"arxiv_id": "not an id"}, "not an arXiv id"),
    ],
)
def test_refuses_a_found_paper_that_is_not_the_saved_one(tmp_path: Path, changes: dict, message: str) -> None:
    request = {"request": "the transformer paper", "destination": "attention"}
    verdict = verify_task("find-and-save-paper", request, found_and_saved(tmp_path) | changes, tmp_path)
    assert verdict["valid"] is False and message in verdict["message"]
    other = request | {"destination": "elsewhere"}
    assert verify_task("find-and-save-paper", other, found_and_saved(tmp_path / "w"), tmp_path / "w")["valid"] is False


def test_checks_what_the_types_cannot_say() -> None:
    assert verify_input("list_daily_papers", ARGUMENTS)["valid"] is True
    assert verify_input("list_daily_papers", ARGUMENTS | {"people": ["Yoshua Bengio", " "]})["valid"] is False
    assert verify_input("list_daily_papers", ARGUMENTS | {"date": "9 Sep 2026"})["valid"] is False
    assert verify_input("search_papers", {"query": "ti:x", "max_results": 51})["valid"] is False
    blank = {"query": " ", "max_results": 1, "destination": "papers"}
    assert verify_input("save_search_results", blank)["valid"] is False
