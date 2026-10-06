from pathlib import Path

from .checks import ARXIV_ID, destination_problem, files_problem, result


def verify_input(value):
    paper = value.get("arxiv_id")
    if not isinstance(paper, str) or not ARXIV_ID.fullmatch(paper.strip()):
        return result(False, "invalid arXiv id")
    problem = destination_problem(value.get("destination"))
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    expected = Path(workspace) / input_value["destination"]
    folder = Path(output_value.get("folder", ""))
    if folder != expected or not folder.is_dir():
        return result(False, "output folder is missing or is not the requested destination in the workspace")
    problem = files_problem(folder, output_value.get("files"))
    if problem:
        return result(False, problem.pop("message"), **problem)
    return result(True, "downloaded source is present", files=len(output_value["files"]))
