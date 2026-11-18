from .checks import result


def verify_input(value):
    if value.name.startswith("/") or ".." in value.name.split("/"):
        return result(False, "name must stay inside the workspace")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    return result(True, "nothing to check")
