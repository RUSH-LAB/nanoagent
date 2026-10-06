"""The deterministic verifier: each tool's checks live in its own module."""

from . import daily, digest, download, raw, save, search
from .checks import result

TOOLS = {
    "download_source": download,
    "search_papers": search,
    "save_search_results": save,
    "list_daily_papers": daily,
    "save_raw_paper": raw,
    "write_digest": digest,
}


def _per_call(arguments, reference, workspace):
    """A task whose outcome is its tool calls' outputs, each already checked by verify_output."""
    return result(True, "every tool call was verified")


# task id -> its outcome check, verify_task(arguments, reference, workspace)
TASKS = {
    "search-papers": _per_call,
    "save-paper-source": _per_call,
    "save-search-results": _per_call,
    "find-and-save-paper": _per_call,
    "daily-digest": daily.verify_task,
}


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
