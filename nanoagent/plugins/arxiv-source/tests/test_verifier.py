from __future__ import annotations

import json
from pathlib import Path

import pytest
from slimconfig import build_output

import plugin.naming
import verifier
import verifier.naming
from contract import TOOLS, DailyInput, DailyOutput, Tool

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


# The verifier gets contract instances, as NanoAgent's sandbox builds them from JSON.
def verify_input(tool: str, value: dict) -> dict:
    return verifier.verify_input(tool, build_output(value, TOOLS[Tool(tool)][0]))


def verify_task(arguments: dict, reference: dict, workspace: Path) -> dict:
    return verifier.verify_task(
        "daily-digest", build_output(arguments, DailyInput), build_output(reference, DailyOutput), str(workspace)
    )


def entry(**changes):
    value = {
        "arxiv_id": PAPER["arxiv_id"],
        "title": PAPER["title"],
        "authors": PAPER["authors"],
        "summary": "Argues safety work must start now.\nCalls for binding commitments.",
        "link": "https://arxiv.org/abs/2609.10630",
    }
    return value | changes


def workspace(tmp_path: Path, entries: list[dict], *, saved: bool = True) -> Path:
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / f"digest-{DATE}.json").write_text(json.dumps({"date": DATE, "entries": entries}))
    if saved:
        folder = docs / "raw" / "bengio-ai-safety-not-optional-2609.10630-2026-09-09"
        folder.mkdir(parents=True)
        (folder / "main.tex").write_text("x")
    return tmp_path


def test_the_verifier_and_the_plugin_name_folders_alike() -> None:
    args = (PAPER["title"], PAPER["authors"], PAPER["arxiv_id"], DATE)
    assert verifier.naming.raw_folder_name(*args) == plugin.naming.raw_folder_name(*args)


def test_approves_a_complete_digest(tmp_path: Path) -> None:
    verdict = verify_task(ARGUMENTS, REFERENCE, workspace(tmp_path, [entry()]))
    assert verdict["valid"] is True and verdict["score"] == 1.0


@pytest.mark.parametrize(
    ("entries", "saved", "problem"),
    [
        ([], True, "published but missing from the digest"),
        ([entry()], False, "no saved source in docs/raw/bengio-ai-safety-not-optional-2609.10630-2026-09-09"),
        ([entry(title="AI Safety")], True, "title differs from the arXiv record"),
        ([entry(summary="One line only.")], True, "summary is not exactly two lines"),
        ([entry(), entry(arxiv_id="2609.99999")], True, "not a paper arXiv shows for these people on 2026-09-09"),
        ([entry(arxiv_id="2609.10630v1")], True, "id is not of the form YYMM.NNNNN"),
    ],
)
def test_refuses_an_incomplete_or_wrong_digest(tmp_path: Path, entries: list[dict], saved: bool, problem: str) -> None:
    verdict = verify_task(ARGUMENTS, REFERENCE, workspace(tmp_path, entries, saved=saved))
    assert verdict["valid"] is False
    assert any(problem in found for found_list in verdict["details"]["problems"].values() for found in found_list)


def test_checks_what_the_types_cannot_say() -> None:
    assert verify_input("list_daily_papers", ARGUMENTS)["valid"] is True
    assert verify_input("list_daily_papers", ARGUMENTS | {"people": ["Yoshua Bengio", " "]})["valid"] is False
    assert verify_input("list_daily_papers", ARGUMENTS | {"date": "9 Sep 2026"})["valid"] is False
    assert verify_input("write_digest", {"date": DATE, "entries": [entry()]})["valid"] is True
    assert verify_input("write_digest", {"date": DATE, "entries": [entry(arxiv_id="2609.10630v1")]})["valid"] is False
    assert verify_input("search_papers", {"query": "ti:x", "max_results": 51})["valid"] is False
    blank = {"query": " ", "max_results": 1, "destination": "papers"}
    assert verify_input("save_search_results", blank)["valid"] is False
