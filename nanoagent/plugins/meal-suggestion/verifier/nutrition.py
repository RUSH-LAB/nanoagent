from .checks import result
from .meals import load_recipes, nutrition_problem, per_serving


def verify_input(value):
    if not value.recipe.strip():
        return result(False, "recipe must be a recipe name")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    recipes = load_recipes()
    name = input_value.recipe
    if output_value.recipe != name or name not in recipes:
        return result(False, "the output is not the requested recipe")
    if output_value.ingredients != recipes[name]["ingredients"]:
        return result(False, "the ingredients differ from the recipes file")
    if nutrition_problem(output_value.per_serving, per_serving(recipes[name])):
        return result(False, "the nutrition per serving differs from the recipes file")
    return result(True, "the nutrition is the recipes file's")
