import json
from pathlib import Path

from .checks import result
from .daily import DATE


def verify_input(value):
    if not isinstance(value.get("date"), str) or not DATE.fullmatch(value["date"]):
        return result(False, "date must be YYYY-MM-DD")
    if not isinstance(value.get("entries"), list):
        return result(False, "entries must be a list")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    path = Path(workspace) / "docs" / f"digest-{input_value['date']}.json"
    if Path(output_value.get("path", "")) != path or not path.is_file():
        return result(False, "digest is not at docs/digest-<date>.json")
    if json.loads(path.read_text(encoding="utf-8")) != {"date": input_value["date"], "entries": input_value["entries"]}:
        return result(False, "the saved digest differs from the submitted entries")
    return result(True, "digest is saved", entries=len(input_value["entries"]))
