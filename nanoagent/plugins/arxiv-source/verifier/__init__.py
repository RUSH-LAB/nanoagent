"""The deterministic verifier: each tool's checks live in its own module, on contract instances."""

from contract import Task, Tool

from . import daily, download, find, raw, save, search

TOOLS = {
    Tool.DOWNLOAD_SOURCE: download,
    Tool.SEARCH_PAPERS: search,
    Tool.SAVE_SEARCH_RESULTS: save,
    Tool.LIST_DAILY_PAPERS: daily,
    Tool.SAVE_RAW_PAPER: raw,
}


def _tool_output(module):
    """A tool task's check: its output judged as its one tool's verify_output judges it."""
    return lambda arguments, output, reference, workspace: module.verify_output(arguments, output, workspace)


# task -> its output's check, verify_task(arguments, output, reference, workspace)
TASKS = {
    Task.SEARCH_PAPERS: _tool_output(search),
    Task.SAVE_PAPER_SOURCE: _tool_output(download),
    Task.SAVE_SEARCH_RESULTS: _tool_output(save),
    Task.FIND_AND_SAVE_PAPER: find.verify_task,
    Task.WRITE_DAILY_DIGEST: daily.verify_task,
}


def verify_input(tool, value):
    return TOOLS[Tool(tool)].verify_input(value)


def verify_output(tool, input_value, output_value, workspace):
    return TOOLS[Tool(tool)].verify_output(input_value, output_value, workspace)


def verify_task(task, arguments, output, reference, workspace):
    return TASKS[Task(task)](arguments, output, reference, workspace)
