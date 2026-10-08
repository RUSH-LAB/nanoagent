import json
from pathlib import Path

from contract import Label

from .checks import result

VERDICTS = "verdicts.json"
LABELS = tuple(label.value for label in Label)


def verify_input(value):
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    path = Path(workspace) / VERDICTS
    if Path(output_value.path) != path or not path.is_file():
        return result(False, f"verdicts are not at {VERDICTS}")
    submitted = {key: label.value for key, label in input_value.verdicts.items()}
    if json.loads(path.read_text(encoding="utf-8")) != submitted:
        return result(False, "the saved verdicts differ from the submitted ones")
    return result(True, "verdicts are saved", verdicts=len(submitted))
