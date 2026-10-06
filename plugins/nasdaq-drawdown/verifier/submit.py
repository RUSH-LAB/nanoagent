import json
from pathlib import Path

from .checks import result, tickers_problem

ANSWER = "tickers.json"


def verify_input(value):
    problem = tickers_problem(value.get("tickers"))
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    path = Path(workspace) / ANSWER
    if Path(output_value.get("path", "")) != path or not path.is_file():
        return result(False, f"the answer is not at {ANSWER}")
    if json.loads(path.read_text(encoding="utf-8")) != {"tickers": input_value["tickers"]}:
        return result(False, "the saved answer differs from the submitted tickers")
    return result(True, "answer is saved", tickers=len(input_value["tickers"]))
