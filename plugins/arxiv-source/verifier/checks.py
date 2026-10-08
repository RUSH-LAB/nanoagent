"""Checks shared by the tool verifiers. Pure functions of their arguments and the files on disk."""

import re
from pathlib import Path

ARXIV_ID = re.compile(r"^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?$", re.IGNORECASE)


def result(valid, message, *, score=None, **details):
    return {
        "valid": valid,
        "score": float(valid) if score is None else score,
        "message": message,
        "details": details,
    }


def destination_problem(destination):
    path = Path(destination)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        return "destination must stay inside the plugin workspace"
    return None


def query_problem(value, most):
    """``value``: a contract SearchInput or SaveInput."""
    if not value.query.strip():
        return "query must not be blank"
    if not 1 <= value.max_results <= most:
        return f"max_results must be between 1 and {most}"
    return None


def papers_problem(papers, input_value):
    """What is wrong with a list of returned contract papers, or None."""
    ids = [paper.arxiv_id for paper in papers]
    if len(papers) > input_value.max_results:
        return "more papers than max_results"
    if len(set(ids)) != len(ids):
        return "a paper is returned twice"
    for paper in papers:
        if not ARXIV_ID.fullmatch(paper.arxiv_id):
            return f"invalid arXiv id {paper.arxiv_id!r}"
        if not paper.title or not paper.abs_url.endswith("/abs/" + paper.arxiv_id):
            return f"paper {paper.arxiv_id} has no title or a mismatched abs_url"
    return None


def files_problem(folder, declared):
    """Details of how the files under ``folder`` differ from ``declared``, or None when they match."""
    if not declared:
        return {"message": "output must declare at least one extracted file"}
    present = sorted(path.relative_to(folder).as_posix() for path in folder.rglob("*") if path.is_file())
    if sorted(declared) == present:
        return None
    return {
        "message": f"declared files differ from the files on disk in {folder.name}",
        "missing": sorted(set(declared) - set(present)),
        "undeclared": sorted(set(present) - set(declared)),
    }
