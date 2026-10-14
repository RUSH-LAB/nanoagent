"""The deterministic verifier: each tool's checks live in its own module, on contract instances."""

from contract import Task, Tool

from . import parse, read

TOOLS = {Tool.PARSE_BIBTEX: parse, Tool.READ_BIBTEX: read}
# task -> its output check, verify_task(arguments, output, reference, workspace)
TASKS = {Task.CHECK_BIBTEX: parse.verify_task}


def verify_input(tool, value):
    return TOOLS[Tool(tool)].verify_input(value)


def verify_output(tool, input_value, output_value, workspace):
    return TOOLS[Tool(tool)].verify_output(input_value, output_value, workspace)


def verify_task(task, arguments, output, reference, workspace):
    return TASKS[Task(task)](arguments, output, reference, workspace)
