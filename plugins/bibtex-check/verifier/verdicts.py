import json
from pathlib import Path

from .checks import result

VERDICTS = "verdicts.json"
LABELS = ("real", "hallucinated")


def verify_input(value):
    verdicts = value.get("verdicts")
    if not isinstance(verdicts, dict) or any(label not in LABELS for label in verdicts.values()):
        return result(False, "verdicts must map each raw entry key to real or hallucinated")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    path = Path(workspace) / VERDICTS
    if Path(output_value.get("path", "")) != path or not path.is_file():
        return result(False, f"verdicts are not at {VERDICTS}")
    if json.loads(path.read_text(encoding="utf-8")) != input_value["verdicts"]:
        return result(False, "the saved verdicts differ from the submitted ones")
    return result(True, "verdicts are saved", verdicts=len(input_value["verdicts"]))
