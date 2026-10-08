"""The deterministic verifier: each tool's checks live in its own module, on contract instances."""

from contract import Task, Tool

from . import day, nutrition, recipes, solve, submit, submit_day
from .checks import result

TOOLS = {
    Tool.SOLVE: solve,
    Tool.LIST_RECIPES: recipes,
    Tool.NUTRITION: nutrition,
    Tool.SUBMIT_MEAL: submit,
    Tool.SOLVE_DAY: day,
    Tool.SUBMIT_DAY: submit_day,
}


def _per_call(arguments, reference, workspace):
    """A task whose outcome is its tool call's output, already checked by verify_output."""
    return result(True, "the tool call was verified")


# task -> its outcome check, verify_task(arguments, reference, workspace)
TASKS = {Task.SUGGEST_MEAL: solve.verify_task, Task.PLAN_DAY: day.verify_task, Task.RECOMMEND_MEAL: _per_call}


def verify_input(tool, value):
    return TOOLS[Tool(tool)].verify_input(value)


def verify_output(tool, input_value, output_value, workspace):
    return TOOLS[Tool(tool)].verify_output(input_value, output_value, workspace)


def verify_task(task, arguments, reference, workspace):
    return TASKS[Task(task)](arguments, reference, workspace)
