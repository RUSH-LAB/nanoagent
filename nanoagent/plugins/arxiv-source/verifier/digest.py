import json
from dataclasses import asdict
from pathlib import Path

from .checks import result
from .daily import DATE, NEW_ID


def verify_input(value):
    if not DATE.fullmatch(value.date):
        return result(False, "date must be YYYY-MM-DD")
    for entry in value.entries:
        if not NEW_ID.fullmatch(entry.arxiv_id):
            return result(False, f"entry id {entry.arxiv_id!r} is not of the form YYMM.NNNNN")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    path = Path(workspace) / "docs" / f"digest-{input_value.date}.json"
    if Path(output_value.path) != path or not path.is_file():
        return result(False, "digest is not at docs/digest-<date>.json")
    if json.loads(path.read_text(encoding="utf-8")) != asdict(input_value):
        return result(False, "the saved digest differs from the submitted entries")
    return result(True, "digest is saved", entries=len(input_value.entries))
