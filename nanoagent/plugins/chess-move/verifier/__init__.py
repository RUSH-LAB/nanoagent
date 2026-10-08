"""The deterministic verifier: the reference tool's checks, the live board's, and the task's, on contract instances."""

from contract import Task, Tool

from . import board, pin, play

# tool -> (verify_input, verify_output)
TOOLS = {
    Tool.PIN_MOVES: (pin.verify_input, pin.verify_output),
    Tool.OPEN_BOARD: (board.verify_open_input, board.verify_opened_output),
    Tool.SCREENSHOT: (board.verify_screenshot_input, board.verify_shot_output),
    Tool.DRAG: (board.verify_drag_input, board.verify_acted_output),
    Tool.CLICK: (board.verify_click_input, board.verify_acted_output),
}
# task -> its outcome check, verify_task(arguments, reference, workspace)
TASKS = {Task.PLAY_MOVE: play.verify_task}


def verify_input(tool, value):
    return TOOLS[Tool(tool)][0](value)


def verify_output(tool, input_value, output_value, workspace):
    return TOOLS[Tool(tool)][1](input_value, output_value, workspace)


def verify_task(task, arguments, reference, workspace):
    return TASKS[Task(task)](arguments, reference, workspace)
