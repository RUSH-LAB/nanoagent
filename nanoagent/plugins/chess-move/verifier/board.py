"""The live board's tools: opening it, screenshotting it, and working its mouse."""

from .checks import RECORD, game_problem, lead_problem, point_problem, record, record_problem, result


def verify_open_input(value):
    problem = game_problem(value)
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_screenshot_input(value):
    return result(True, "input is valid")


def verify_drag_input(value):
    for name, point in (("from_xy", value.from_xy), ("to_xy", value.to_xy)):
        problem = point_problem(name, point)
        if problem:
            return result(False, problem)
    if value.from_xy == value.to_xy:
        return result(False, "a drag that ends where it started moves nothing")
    return result(True, "input is valid")


def verify_click_input(value):
    problem = point_problem("xy", value.xy)
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_shot_output(input_value, output_value, workspace):
    images = output_value.images
    if len(images) != 1:
        return result(False, "a screenshot is exactly one image")
    if not images[0].data:
        return result(False, "the image must be a PNG, base64 in `data`")
    if output_value.width < 1 or output_value.height < 1:
        return result(False, "the screenshot must say how many pixels wide and high the board is")
    return result(True, f"the board is {output_value.width}x{output_value.height} pixels")


def verify_opened_output(input_value, output_value, workspace):
    """Opening the board both shows it and starts its record, on the position that was asked for."""
    shot = verify_shot_output(input_value, output_value, workspace)
    if not shot["valid"]:
        return shot
    game, problem = recorded(workspace)
    if problem:
        return result(False, problem)
    problem = lead_problem(input_value, game["fen"])
    if problem:
        return result(False, f"{RECORD} records another starting position: {problem}")
    return shot


def verify_acted_output(input_value, output_value, workspace):
    """The board's record after an action: every action leaves it well formed, and returns what it records."""
    game, problem = recorded(workspace)
    if problem:
        return result(False, problem)
    now = game["positions"][-1] if game["moves"] else game["fen"]
    if output_value.moves != game["moves"] or output_value.position != now:
        return result(False, f"the action returned another game than {RECORD} records")
    return result(True, f"{RECORD} records {len(game['moves'])} move(s)")


def recorded(workspace):
    """The board's record and what is wrong with it, or None."""
    game = record(workspace)
    if game is None:
        return None, f"the action recorded no game in {RECORD}"
    return game, record_problem(game)
