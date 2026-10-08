"""The deterministic verifier: each tool's checks live in its own module, on contract instances."""

from contract import Task, Tool

from . import parse, read, verdicts

TOOLS = {Tool.PARSE_BIBTEX: parse, Tool.READ_BIBTEX: read, Tool.SUBMIT_VERDICTS: verdicts}
# task -> its outcome check, verify_task(arguments, reference, workspace)
TASKS = {Task.CHECK_BIBTEX: parse.verify_task}


def verify_input(tool, value):
    return TOOLS[Tool(tool)].verify_input(value)


def verify_output(tool, input_value, output_value, workspace):
    return TOOLS[Tool(tool)].verify_output(input_value, output_value, workspace)


def verify_task(task, arguments, reference, workspace):
    return TASKS[Task(task)](arguments, reference, workspace)
