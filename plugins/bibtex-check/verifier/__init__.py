"""The deterministic verifier: each tool's checks live in its own module."""

from . import parse, read, verdicts
from .checks import result

TOOLS = {"parse_bibtex": parse, "read_bibtex": read, "submit_verdicts": verdicts}
# task id -> its outcome check, verify_task(arguments, reference, workspace)
TASKS = {"check-bibtex": parse.verify_task}


def verify_input(tool, value):
    if tool not in TOOLS:
        return result(False, f"unknown tool {tool!r}")
    return TOOLS[tool].verify_input(value)


def verify_output(tool, input_value, output_value, workspace):
    if tool not in TOOLS:
        return result(False, f"unknown tool {tool!r}")
    if output_value.get("ok") is not True:
        return result(True, "plugin returned a structured failure", score=0.0)
    return TOOLS[tool].verify_output(input_value, output_value, workspace)


def verify_task(task, arguments, reference, workspace):
    if task not in TASKS:
        return result(False, f"unknown task {task!r}")
    return TASKS[task](arguments, reference, workspace)
