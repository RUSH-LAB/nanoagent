"""The deterministic verifier: each tool's checks live in its own module, on contract instances."""

from contract import Task, Tool

from . import day, nutrition, recipes, solve

TOOLS = {
    Tool.SOLVE: solve,
    Tool.LIST_RECIPES: recipes,
    Tool.NUTRITION: nutrition,
    Tool.SOLVE_DAY: day,
}
# task -> its outcome check, verify_task(arguments, output, reference, workspace)
TASKS = {
    Task.SUGGEST_MEAL: solve.verify_task,
    Task.PLAN_DAY: day.verify_task,
    Task.RECOMMEND_MEAL: solve.verify_recommendation,
}


def verify_input(tool, value):
    return TOOLS[Tool(tool)].verify_input(value)


def verify_output(tool, input_value, output_value, workspace):
    return TOOLS[Tool(tool)].verify_output(input_value, output_value, workspace)


def verify_task(task, arguments, output, reference, workspace):
    return TASKS[Task(task)](arguments, output, reference, workspace)
