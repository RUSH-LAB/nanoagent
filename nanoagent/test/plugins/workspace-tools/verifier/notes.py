"""write_note's check reads the file it claims to have written; read_fixture's output is checked by the case."""

from pathlib import Path

from .checks import result


def inside(name):
    return not name.startswith("/") and ".." not in name.split("/")


def verify_input(tool, value):
    if tool in ("write_note", "copy_fixture") and not inside(value.name):
        return result(False, "name must stay inside the workspace")
    return result(True, "input is valid")


def verify_output(tool, input_value, output_value, workspace):
    if tool == "copy_fixture":
        copied = Path(workspace) / output_value.path
        if not copied.is_file() or copied.stat().st_size != output_value.bytes:
            return result(False, "the workspace does not hold the copied fixture")
        return result(True, "the fixture is in the workspace")
    if tool != "write_note":
        return result(True, "nothing to check")
    written = Path(workspace) / output_value.path
    if not written.is_file() or written.read_text() != input_value.text:
        return result(False, "the workspace does not hold the note as written")
    return result(True, "the note is in the workspace")


def verify_task(arguments, output, reference, workspace):
    written = None if workspace is None or not inside(output.path) else Path(workspace) / output.path
    valid = written is not None and written.is_file()
    # A benchmark case also pins the note's text (the case's input) and the reference tool's path and size.
    if valid and arguments is not None:
        valid = written.read_text() == arguments.text
    if valid and reference is not None:
        valid = (output.path, output.bytes) == (reference.path, reference.bytes)
    return result(valid, "the note exists" if valid else "the note is missing or differs from the case")
