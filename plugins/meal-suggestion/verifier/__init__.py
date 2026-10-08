"""The deterministic verifier: each tool's checks live in its own module, on contract instances."""

from contract import Task, Tool

from . import day, nutrition, recipes, solve, submit, submit_day

TOOLS = {
    Tool.SOLVE: solve,
    Tool.LIST_RECIPES: recipes,
    Tool.NUTRITION: nutrition,
    Tool.SUBMIT_MEAL: submit,
    Tool.SOLVE_DAY: day,
    Tool.SUBMIT_DAY: submit_day,
}
# task -> its outcome check, verify_task(arguments, reference, workspace)
TASKS = {Task.SUGGEST_MEAL: solve.verify_task, Task.PLAN_DAY: day.verify_task}


def verify_input(tool, value):
    return TOOLS[Tool(tool)].verify_input(value)


def verify_output(tool, input_value, output_value, workspace):
    return TOOLS[Tool(tool)].verify_output(input_value, output_value, workspace)


def verify_task(task, arguments, reference, workspace):
    return TASKS[Task(task)](arguments, reference, workspace)
