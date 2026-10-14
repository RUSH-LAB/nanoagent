"""The deterministic verifier: each tool's checks live in its own module, on contract instances."""

from contract import Task, Tool

from . import closes, constituents, pin

TOOLS = {Tool.PIN_WEEK: pin, Tool.LIST_CONSTITUENTS: constituents, Tool.GET_CLOSES: closes}
# task -> its output's check, verify_task(arguments, output, reference, workspace)
TASKS = {Task.LIST_WEEKLY_FALLERS: pin.verify_task}


def verify_input(tool, value):
    return TOOLS[Tool(tool)].verify_input(value)


def verify_output(tool, input_value, output_value, workspace):
    return TOOLS[Tool(tool)].verify_output(input_value, output_value, workspace)


def verify_task(task, arguments, output, reference, workspace):
    return TASKS[Task(task)](arguments, output, reference, workspace)
