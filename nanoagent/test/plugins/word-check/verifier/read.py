from .checks import result, words_problem


def verify_input(value):
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    problem = words_problem(input_value.text, output_value.words)
    if problem:
        return result(False, problem)
    return result(True, "words are read", words=len(output_value.words))
