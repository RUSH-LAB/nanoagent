"""The deterministic verifier: the reference tool's checks, the live board's, and the task's."""

from . import board, pin, play
from .checks import result

# tool -> (verify_input, verify_output)
TOOLS = {
    "pin_moves": (pin.verify_input, pin.verify_output),
    "open_board": (board.verify_open_input, board.verify_opened_output),
    "screenshot": (board.verify_screenshot_input, board.verify_shot_output),
    "drag": (board.verify_drag_input, board.verify_acted_output),
    "click": (board.verify_click_input, board.verify_acted_output),
}
# task id -> its outcome check, verify_task(arguments, reference, workspace)
TASKS = {"play-move": play.verify_task}


def verify_input(tool, value):
    if tool not in TOOLS:
        return result(False, f"unknown tool {tool!r}")
    return TOOLS[tool][0](value)


def verify_output(tool, input_value, output_value, workspace):
    if tool not in TOOLS:
        return result(False, f"unknown tool {tool!r}")
    if output_value.get("ok") is not True:
        return result(True, "plugin returned a structured failure", score=0.0)
    return TOOLS[tool][1](input_value, output_value, workspace)


def verify_task(task, arguments, reference, workspace):
    if task not in TASKS:
        return result(False, f"unknown task {task!r}")
    return TASKS[task](arguments, reference, workspace)
