import json
from pathlib import Path

from .checks import result
from .meals import SUGGESTION


def verify_input(value):
    dishes = value.get("dishes")
    if not isinstance(dishes, list) or not dishes:
        return result(False, "dishes must name at least one recipe")
    names = [dish.get("recipe") for dish in dishes]
    if not all(isinstance(name, str) and name.strip() for name in names) or len(set(names)) != len(names):
        return result(False, "each dish must name a recipe, each recipe once")
    for dish in dishes:
        servings = dish.get("servings")
        if isinstance(servings, bool) or not isinstance(servings, int) or servings < 1:
            return result(False, f"{dish['recipe']}: servings must be a positive whole number")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    path = Path(workspace) / SUGGESTION
    if Path(output_value.get("path", "")) != path or not path.is_file():
        return result(False, f"the suggestion is not at {SUGGESTION} in the workspace")
    if json.loads(path.read_text(encoding="utf-8")) != {"dishes": input_value["dishes"]}:
        return result(False, f"{SUGGESTION} does not hold the submitted dishes")
    return result(True, "the suggestion is written", dishes=len(input_value["dishes"]))
