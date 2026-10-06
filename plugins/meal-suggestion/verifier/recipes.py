from .checks import result
from .meals import MEALS, eligible, load, path_problem, preference_problem


def verify_input(value):
    problem = path_problem(value.get("recipes"), "recipes") or preference_problem(value.get("preference"))
    if problem:
        return result(False, problem)
    if value.get("meal") not in MEALS:
        return result(False, f"meal must be one of {', '.join(MEALS)}")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    recipes = load(workspace, input_value["recipes"])
    listed = output_value.get("recipes", [])
    if [recipe["name"] for recipe in listed] != eligible(recipes, input_value["meal"], input_value["preference"]):
        return result(False, "the list is not exactly the meal's recipes that meet the preference, by name")
    if any(recipe["tags"] != recipes[recipe["name"]]["tags"] for recipe in listed):
        return result(False, "a recipe's tags differ from the recipes file")
    return result(True, "the recipes are listed", recipes=len(listed))
