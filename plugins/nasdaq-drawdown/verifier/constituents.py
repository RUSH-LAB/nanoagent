from . import pin
from .checks import DATE, result, week_problem


def verify_input(value):
    return pin.verify_input(value)


def verify_output(input_value, output_value, workspace):
    problem = week_problem(input_value, output_value)
    if problem:
        return result(False, problem)
    sessions = output_value.get("sessions", [])
    if len(sessions) != 6 or sessions != sorted(set(sessions)) or not all(DATE.fullmatch(day) for day in sessions):
        return result(False, "sessions are not the week's 6 distinct dates, oldest first")
    if sessions[0] != output_value["start"] or sessions[-1] != input_value["as_of"]:
        return result(False, "sessions do not run from start to as_of")
    return result(True, "constituents and week are well formed", constituents=len(output_value["constituents"]))
