from .checks import entries_problem, result, text_problem


def verify_input(value):
    problem = text_problem("bibtex", value.bibtex)
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    problem = entries_problem(output_value.entries)
    if problem:
        return result(False, problem)
    return result(True, "entries are well formed", entries=len(output_value.entries))
