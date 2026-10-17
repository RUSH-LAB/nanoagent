"""The deterministic verifier: whether the runner's sandbox and limits held, from what each tool reported."""

from contract import Task, Tool

from . import probe

TASKS = {
    Task.PROBE: probe.verify_probe,
    Task.HOG: probe.verify_hog,
    Task.SWARM: probe.verify_swarm,
    Task.FORKS: probe.verify_forks,
}


def verify_input(tool, value):
    return probe.verify_input(Tool(tool), value)


def verify_output(tool, input_value, output_value, workspace):
    return probe.verify_output(Tool(tool), input_value, output_value, workspace)


def verify_task(task, arguments, output, reference, workspace):
    return TASKS[Task(task)](arguments, output, reference, workspace)
