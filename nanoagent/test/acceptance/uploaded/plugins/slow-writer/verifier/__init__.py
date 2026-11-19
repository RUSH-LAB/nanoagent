"""The deterministic verifier: each tool's checks live in its own module, on contract instances."""

from contract import Task, Tool

from . import benchmark, digest, slow_write, wait

TOOLS = {Tool.WAIT: wait, Tool.DIGEST: digest, Tool.SLOW_WRITE: slow_write}
# task -> its output's check, verify_task(arguments, output, reference, workspace)
TASKS = {Task.PROBE: digest.verify_task}


def verify_input(tool, value):
    return TOOLS[Tool(tool)].verify_input(value)


def verify_output(tool, input_value, output_value, workspace):
    return TOOLS[Tool(tool)].verify_output(input_value, output_value, workspace)


def verify_task(task, arguments, output, reference, workspace):
    return TASKS[Task(task)](arguments, output, reference, workspace)


def verify_benchmark_case(task, arguments, outcome, reference, workspace, suite):
    return benchmark.verify_case(TASKS[Task(task)], outcome, reference, suite)


def score_benchmark_suite(task, suite, cases):
    return benchmark.score_suite(suite, cases)
