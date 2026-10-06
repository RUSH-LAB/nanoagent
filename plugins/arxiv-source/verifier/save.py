from pathlib import Path

from .checks import destination_problem, files_problem, papers_problem, query_problem, result

MAX_RESULTS = 10


def verify_input(value):
    problem = query_problem(value, MAX_RESULTS) or destination_problem(value.get("destination"))
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    folder = Path(workspace) / input_value["destination"]
    if Path(output_value.get("folder", "")) != folder or not folder.is_dir():
        return result(False, "output folder is missing or is not the requested destination in the workspace")
    papers = output_value.get("papers", [])
    problem = papers_problem(papers, input_value)
    if problem:
        return result(False, problem)
    # One folder per paper, named by its id with `/` (legacy ids) as `_`, and nothing else.
    expected = {paper["arxiv_id"].replace("/", "_"): paper for paper in papers}
    present = sorted(path.name for path in folder.iterdir())
    if present != sorted(expected):
        return result(False, "destination holds other folders than one per saved paper", present=present)
    for name, paper in expected.items():
        if Path(paper["folder"]) != folder / name:
            return result(False, f"paper {paper['arxiv_id']} is not saved in {name}/")
        problem = files_problem(folder / name, paper["files"])
        if problem:
            return result(False, problem.pop("message"), **problem)
    return result(True, "every searched paper's source is saved", papers=len(papers))
