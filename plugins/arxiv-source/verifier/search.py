from .checks import papers_problem, query_problem, result

MAX_RESULTS = 50


def verify_input(value):
    problem = query_problem(value, MAX_RESULTS)
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    if output_value.query != input_value.query.strip():
        return result(False, "output query differs from the requested query")
    problem = papers_problem(output_value.papers, input_value)
    if problem:
        return result(False, problem)
    return result(True, "search results are well formed", papers=len(output_value.papers))
