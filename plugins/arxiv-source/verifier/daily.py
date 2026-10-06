"""list_daily_papers (the daily-digest reference) and the daily-digest task's outcome check."""

import json
import re
from pathlib import Path

from .checks import result
from .naming import raw_folder_name

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NEW_ID = re.compile(r"^\d{4}\.\d{5}$")


def verify_input(value):
    people = value.get("people")
    if not isinstance(people, list) or not people or len(set(people)) != len(people):
        return result(False, "people must be a non-empty list of distinct names")
    if not isinstance(value.get("date"), str) or not DATE.fullmatch(value["date"]):
        return result(False, "date must be YYYY-MM-DD")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    if output_value.get("date") != input_value["date"]:
        return result(False, "listing is for another date")
    if [person["name"] for person in output_value.get("people", [])] != input_value["people"]:
        return result(False, "listing does not cover exactly the requested people, in order")
    for person in output_value["people"]:
        for paper in person["papers"]:
            if not NEW_ID.fullmatch(paper["arxiv_id"]) or not paper["published"].startswith(input_value["date"]):
                return result(False, f"{paper['arxiv_id']} is not a YYMM.NNNNN paper first submitted on the date")
    return result(True, "listing is well formed")


def _expected(reference):
    """Every paper the pinned listing shows, by id (a paper by several people appears once)."""
    papers = {}
    for person in reference["people"]:
        for paper in person["papers"]:
            papers[paper["arxiv_id"]] = paper
    return papers


def _entry_problems(entry, record, link):
    problems = []
    if entry.get("title") != record["title"]:
        problems.append("title differs from the arXiv record")
    if entry.get("authors") != record["authors"]:
        problems.append("authors differ from the arXiv record")
    lines = entry.get("summary", "").split("\n") if isinstance(entry.get("summary"), str) else []
    if len(lines) != 2 or not all(line.strip() for line in lines):
        problems.append("summary is not exactly two lines")
    if entry.get("link") != link:
        problems.append(f"link is not {link}")
    return problems


def verify_task(arguments, reference, workspace):
    """Approve the digest only when every paper the pinned arXiv listing shows for the monitored
    people on the date is an exact entry and has its source saved under docs/raw/."""
    date = arguments["date"]
    expected = _expected(reference)
    path = Path(workspace) / "docs" / f"digest-{date}.json"
    if not path.is_file():
        return result(False, f"no digest at docs/digest-{date}.json", score=0.0, expected=sorted(expected))
    entries = json.loads(path.read_text(encoding="utf-8")).get("entries")
    if not isinstance(entries, list):
        return result(False, "digest has no entries list", score=0.0)

    problems = {}
    listed = set()
    for entry in entries:
        paper = entry.get("arxiv_id") if isinstance(entry, dict) else None
        if not isinstance(paper, str) or not NEW_ID.fullmatch(paper):
            problems.setdefault(str(paper), []).append("id is not of the form YYMM.NNNNN")
        elif paper in listed:
            problems.setdefault(paper, []).append("listed twice")
        elif paper not in expected:
            problems.setdefault(paper, []).append(f"not a paper arXiv shows for these people on {date}")
        else:
            listed.add(paper)
            found = _entry_problems(entry, expected[paper], f"https://arxiv.org/abs/{paper}")
            if found:
                problems.setdefault(paper, []).extend(found)
    for paper, record in expected.items():
        if paper not in listed:
            problems.setdefault(paper, []).append("published but missing from the digest")
        folder = Path(workspace) / "docs" / "raw" / raw_folder_name(record["title"], record["authors"], paper, date)
        if not folder.is_dir() or not any(child.is_file() for child in folder.rglob("*")):
            problems.setdefault(paper, []).append(f"no saved source in docs/raw/{folder.name}")

    correct = [paper for paper in expected if paper not in problems]
    score = len(correct) / len(expected) if expected else float(not problems)
    if problems:
        return result(False, f"{len(problems)} paper(s) fail the digest check", score=score, problems=problems)
    return result(True, f"all {len(expected)} paper(s) are in the digest and saved", score=score, papers=sorted(expected))
