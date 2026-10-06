from .checks import result
from .meals import NUTRIENTS, ROUNDING, load, path_problem, per_serving


def verify_input(value):
    problem = path_problem(value.get("ingredients"), "ingredients") or path_problem(value.get("recipes"), "recipes")
    if problem:
        return result(False, problem)
    if not isinstance(value.get("recipe"), str) or not value["recipe"].strip():
        return result(False, "recipe must be a recipe name")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    recipes = load(workspace, input_value["recipes"])
    name = input_value["recipe"]
    if output_value.get("recipe") != name or name not in recipes:
        return result(False, "the output is not the requested recipe")
    if output_value.get("ingredients") != recipes[name]["ingredients"]:
        return result(False, "the ingredients differ from the recipes file")
    expected = per_serving(recipes[name], load(workspace, input_value["ingredients"]))
    given = output_value.get("per_serving", {})
    if any(abs(given[nutrient] - expected[nutrient]) > ROUNDING for nutrient in NUTRIENTS):
        return result(False, "the nutrition per serving differs from the input files")
    return result(True, "the nutrition is the input files'")
