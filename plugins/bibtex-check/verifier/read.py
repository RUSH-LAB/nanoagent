from .checks import entries_problem, path_problem, result


def verify_input(value):
    problem = path_problem("path", value.get("path"))
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    if output_value.get("path") != input_value["path"]:
        return result(False, "output is for another file")
    problem = entries_problem(output_value.get("entries"))
    if problem:
        return result(False, problem)
    return result(True, "entries are well formed", entries=len(output_value["entries"]))
