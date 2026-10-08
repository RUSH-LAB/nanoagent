import re
from pathlib import Path

from .checks import files_problem, result
from .daily import DATE
from .naming import raw_folder_name

RAW_ID = re.compile(r"^\d{4}\.\d{5}(v\d+)?$")


def verify_input(value):
    if not RAW_ID.fullmatch(value.arxiv_id):
        return result(False, "arxiv_id must be YYMM.NNNNN, optionally with a version")
    if not DATE.fullmatch(value.date):
        return result(False, "date must be YYYY-MM-DD")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    paper = re.sub(r"v\d+$", "", input_value.arxiv_id)
    if output_value.arxiv_id != paper or not output_value.authors:
        return result(False, "output is for another paper, or has no authors")
    name = raw_folder_name(output_value.title, output_value.authors, paper, input_value.date)
    folder = Path(workspace) / "docs" / "raw" / name
    if Path(output_value.folder) != folder or not folder.is_dir():
        return result(False, f"source is not saved in docs/raw/{name}")
    problem = files_problem(folder, output_value.files)
    if problem:
        return result(False, problem.pop("message"), **problem)
    return result(True, f"source saved in docs/raw/{name}", files=len(output_value.files))
