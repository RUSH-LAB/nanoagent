"""The live board's tools: opening it, screenshotting it, and working its mouse."""

from .checks import RECORD, fen_problem, point_problem, record, record_problem, result


def verify_open_input(value):
    problem = fen_problem(value.get("fen"))
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_screenshot_input(value):
    if value:
        return result(False, "screenshot takes no input")
    return result(True, "input is valid")


def verify_drag_input(value):
    for name in ("from_xy", "to_xy"):
        problem = point_problem(name, value.get(name))
        if problem:
            return result(False, problem)
    if value["from_xy"] == value["to_xy"]:
        return result(False, "a drag that ends where it started moves nothing")
    return result(True, "input is valid")


def verify_click_input(value):
    problem = point_problem("xy", value.get("xy"))
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_shot_output(input_value, output_value, workspace):
    images = output_value.get("images")
    if not isinstance(images, list) or len(images) != 1:
        return result(False, "a screenshot is exactly one image")
    image = images[0]
    if image.get("media_type") != "image/png" or not image.get("data"):
        return result(False, "the image must be a PNG, base64 in `data`")
    if not all(isinstance(output_value.get(side), int) and output_value[side] > 0 for side in ("width", "height")):
        return result(False, "the screenshot must say how many pixels wide and high the board is")
    return result(True, f"the board is {output_value['width']}x{output_value['height']} pixels")


def verify_opened_output(input_value, output_value, workspace):
    """Opening the board both shows it and starts its record, on the position that was asked for."""
    shot = verify_shot_output(input_value, output_value, workspace)
    if not shot["valid"]:
        return shot
    acted = verify_acted_output(input_value, output_value, workspace)
    if not acted["valid"]:
        return acted
    if record(workspace)["fen"] != input_value["fen"]:
        return result(False, f"{RECORD} records another starting position")
    return shot


def verify_acted_output(input_value, output_value, workspace):
    """The board's record after an action: every action leaves it well formed."""
    game = record(workspace)
    if game is None:
        return result(False, f"the action recorded no game in {RECORD}")
    problem = record_problem(game)
    if problem:
        return result(False, problem)
    return result(True, f"{RECORD} records {len(game['moves'])} move(s)")
