"""digest (the probe task's reference) and the probe task's output check."""

import hashlib

from .checks import result


def verify_input(value):
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    expected = hashlib.sha256(input_value.token.encode()).hexdigest()[:12]
    if output_value.digest != expected:
        return result(False, "digest is not the token's")
    return result(True, "digest is the token's")


def verify_task(arguments, output, reference, workspace):
    valid = output.digest == reference.digest
    return result(valid, "digest is right" if valid else f"digest {output.digest!r} is not {reference.digest!r}")
