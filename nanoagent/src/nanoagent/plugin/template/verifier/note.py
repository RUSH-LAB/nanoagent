from pathlib import Path

from .checks import destination_problem, result


def verify_input(value):
    problem = destination_problem(value.destination)
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    path = Path(workspace) / input_value.destination
    if Path(output_value.path) != path or not path.is_file():
        return result(False, "output path is not the requested destination in the workspace")
    if path.read_text(encoding="utf-8") != input_value.text:
        return result(False, "the file does not hold the requested text")
    return result(True, "note is written", bytes=output_value.bytes)


def verify_task(arguments, output, reference, workspace):
    path = Path(workspace) / arguments.destination
    if Path(output.path) != path or not path.is_file() or path.read_text(encoding="utf-8") != arguments.text:
        return result(False, "the note is not saved at the destination")
    return result(True, "the note is saved")
