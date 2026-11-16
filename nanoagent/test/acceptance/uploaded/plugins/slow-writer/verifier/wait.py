from .checks import result


def verify_input(value):
    if value.wait_seconds < 0:
        return result(False, "wait_seconds must not be negative")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    if output_value.waited != input_value.wait_seconds:
        return result(False, "waited is not the seconds asked")
    return result(True, "waited as asked")
