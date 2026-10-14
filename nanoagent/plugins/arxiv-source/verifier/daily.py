"""list_daily_papers (the daily-digest reference) and the daily-digest task's outcome check."""

import re
from pathlib import Path

from .checks import result
from .naming import raw_folder_name

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NEW_ID = re.compile(r"^\d{4}\.\d{5}$")


def verify_input(value):
    people = value.people
    if not people or len(set(people)) != len(people) or not all(person.strip() for person in people):
        return result(False, "people must be a non-empty list of distinct, non-blank names")
    if not DATE.fullmatch(value.date):
        return result(False, "date must be YYYY-MM-DD")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    if output_value.date != input_value.date:
        return result(False, "listing is for another date")
    if [person.name for person in output_value.people] != input_value.people:
        return result(False, "listing does not cover exactly the requested people, in order")
    for person in output_value.people:
        for paper in person.papers:
            if not NEW_ID.fullmatch(paper.arxiv_id) or not paper.published.startswith(input_value.date):
                return result(False, f"{paper.arxiv_id} is not a YYMM.NNNNN paper first submitted on the date")
    return result(True, "listing is well formed")


def _expected(reference):
    """Every paper the pinned listing (a contract DailyOutput) shows, by id (a paper by several
    people appears once)."""
    papers = {}
    for person in reference.people:
        for paper in person.papers:
            papers[paper.arxiv_id] = paper
    return papers


def _entry_problems(entry, record, folder):
    """``entry``: a contract Entry; ``record``: a contract DailyPaper; ``folder``: its docs/raw/ folder."""
    problems = []
    if entry.title != record.title:
        problems.append("title differs from the arXiv record")
    if entry.authors != record.authors:
        problems.append("authors differ from the arXiv record")
    lines = entry.summary.split("\n")
    if len(lines) != 2 or not all(line.strip() for line in lines):
        problems.append("summary is not exactly two lines")
    link = f"https://arxiv.org/abs/{record.arxiv_id}"
    if entry.link != link:
        problems.append(f"link is not {link}")
    if Path(entry.folder) != folder:
        problems.append(f"folder is not docs/raw/{folder.name}")
    return problems


def verify_task(arguments, output, reference, workspace):
    """Approve the digest (a contract Digest) only when every paper the pinned arXiv listing shows
    for the monitored people on the date is an exact entry and has its source saved under docs/raw/."""
    date = arguments.date
    if output.date != date:
        return result(False, f"the digest is for {output.date}, not {date}", score=0.0)
    expected = _expected(reference)
    folders = {
        paper: Path(workspace) / "docs" / "raw" / raw_folder_name(record.title, record.authors, paper, date)
        for paper, record in expected.items()
    }

    problems = {}
    listed = set()
    for entry in output.entries:
        paper = entry.arxiv_id
        if not NEW_ID.fullmatch(paper):
            problems.setdefault(paper, []).append("id is not of the form YYMM.NNNNN")
        elif paper in listed:
            problems.setdefault(paper, []).append("listed twice")
        elif paper not in expected:
            problems.setdefault(paper, []).append(f"not a paper arXiv shows for these people on {date}")
        else:
            listed.add(paper)
            found = _entry_problems(entry, expected[paper], folders[paper])
            if found:
                problems.setdefault(paper, []).extend(found)
    for paper, folder in folders.items():
        if paper not in listed:
            problems.setdefault(paper, []).append("published but missing from the digest")
        if not folder.is_dir() or not any(child.is_file() for child in folder.rglob("*")):
            problems.setdefault(paper, []).append(f"no saved source in docs/raw/{folder.name}")

    correct = [paper for paper in expected if paper not in problems]
    score = len(correct) / len(expected) if expected else float(not problems)
    if problems:
        return result(False, f"{len(problems)} paper(s) fail the digest check", score=score, problems=problems)
    return result(
        True, f"all {len(expected)} paper(s) are in the digest and saved", score=score, papers=sorted(expected)
    )
