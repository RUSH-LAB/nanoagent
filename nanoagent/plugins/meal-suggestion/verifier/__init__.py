"""The deterministic verifier: each tool's checks live in its own module, on contract instances."""

from contract import Task, Tool

from . import day, nutrition, recipes, solve

TOOLS = {
    Tool.SOLVE_MEAL: solve,
    Tool.LIST_RECIPES: recipes,
    Tool.GET_NUTRITION: nutrition,
    Tool.SOLVE_DAY: day,
}
# task -> its output's check, verify_task(arguments, output, reference, workspace)
TASKS = {
    Task.RECOMMEND_MEAL: solve.verify_recommendation,
    Task.SUGGEST_MEAL: solve.verify_task,
    Task.PLAN_DAY: day.verify_task,
}


def verify_input(tool, value):
    return TOOLS[Tool(tool)].verify_input(value)


def verify_output(tool, input_value, output_value, workspace):
    return TOOLS[Tool(tool)].verify_output(input_value, output_value, workspace)


def verify_task(task, arguments, output, reference, workspace):
    return TASKS[Task(task)](arguments, output, reference, workspace)
