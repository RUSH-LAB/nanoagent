from __future__ import annotations

import json
from pathlib import Path

import pytest

import plugin.naming
import verifier
import verifier.naming

DATE = "2026-09-09"
PAPER = {
    "arxiv_id": "2609.10630",
    "title": "AI Safety: Not Optional, Not Later",
    "authors": ["Yoshua Bengio", "Ada Lovelace"],
    "published": "2026-09-09T06:36:05Z",
    "abs_url": "http://arxiv.org/abs/2609.10630v1",
}
REFERENCE = {"ok": True, "date": DATE, "people": [{"name": "Yoshua Bengio", "papers": [PAPER]}]}
ARGUMENTS = {"people": ["Yoshua Bengio"], "date": DATE}


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
    verdict = verifier.verify_task("daily-digest", ARGUMENTS, REFERENCE, str(workspace(tmp_path, [entry()])))
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
    verdict = verifier.verify_task("daily-digest", ARGUMENTS, REFERENCE, str(workspace(tmp_path, entries, saved=saved)))
    assert verdict["valid"] is False
    assert any(problem in found for found_list in verdict["details"]["problems"].values() for found in found_list)
