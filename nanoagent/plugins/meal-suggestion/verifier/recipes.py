from .checks import result
from .meals import (
    ROUNDING,
    eligible,
    liked,
    likes_problem,
    load_recipes,
    nutrition_problem,
    per_serving,
    score,
)


def verify_input(value):
    problem = likes_problem(value.likes)
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    recipes = load_recipes()
    listed = output_value.recipes
    if [recipe.name for recipe in listed] != eligible(recipes, input_value.meal, input_value.restrictions):
        return result(False, "the list is not exactly the meal's recipes that meet the restrictions, by name")
    if any(recipe.tags != recipes[recipe.name]["tags"] for recipe in listed):
        return result(False, "a recipe's tags differ from the recipes file")
    if any(recipe.url != recipes[recipe.name]["url"] for recipe in listed):
        return result(False, "a recipe's url differs from the recipes file")
    if any(nutrition_problem(recipe.per_serving, per_serving(recipes[recipe.name])) for recipe in listed):
        return result(False, "a recipe's nutrition per serving differs from the recipes file")
    likes = input_value.likes
    for recipe in listed:
        if recipe.liked != liked(recipes[recipe.name], likes):
            return result(False, f"the likes {recipe.name} matches are not the ones its ingredients and tags match")
        if abs(recipe.score - score(recipes[recipe.name], likes)) > ROUNDING:
            return result(False, f"the preference score of {recipe.name} is not the sum of its likes' weights")
    return result(True, "the recipes are listed", recipes=len(listed))
