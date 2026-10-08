"""The deterministic verifier: each tool's checks live in its own module, on contract instances."""

from contract import Task, Tool

from . import daily, digest, download, raw, save, search
from .checks import result

TOOLS = {
    Tool.DOWNLOAD_SOURCE: download,
    Tool.SEARCH_PAPERS: search,
    Tool.SAVE_SEARCH_RESULTS: save,
    Tool.LIST_DAILY_PAPERS: daily,
    Tool.SAVE_RAW_PAPER: raw,
    Tool.WRITE_DIGEST: digest,
}


def _per_call(arguments, reference, workspace):
    """A task whose outcome is its tool calls' outputs, each already checked by verify_output."""
    return result(True, "every tool call was verified")


# task -> its outcome check, verify_task(arguments, reference, workspace)
TASKS = {
    Task.SEARCH_PAPERS: _per_call,
    Task.SAVE_PAPER_SOURCE: _per_call,
    Task.SAVE_SEARCH_RESULTS: _per_call,
    Task.FIND_AND_SAVE_PAPER: _per_call,
    Task.DAILY_DIGEST: daily.verify_task,
}


def verify_input(tool, value):
    return TOOLS[Tool(tool)].verify_input(value)


def verify_output(tool, input_value, output_value, workspace):
    return TOOLS[Tool(tool)].verify_output(input_value, output_value, workspace)


def verify_task(task, arguments, reference, workspace):
    return TASKS[Task(task)](arguments, reference, workspace)
