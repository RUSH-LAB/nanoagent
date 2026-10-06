"""The input files and each recipe's nutrition, recomputed as `src/plugin/meals.py` computes them."""

import json
from pathlib import Path

NUTRIENTS = ("kcal", "protein", "fat", "carbs", "fiber")
MEALS = ("breakfast", "lunch", "dinner")
SUGGESTION = "meal.json"
# Slack for float sums and for the 3-decimal rounding of tool outputs.
EPSILON = 1e-6
ROUNDING = 1e-3


def path_problem(path, name):
    if not isinstance(path, str) or not path.strip():
        return f"{name} must be a file path"
    relative = Path(path)
    if relative.is_absolute() or ".." in relative.parts:
        return f"{name} must stay inside the plugin workspace"
    return None


def preference_problem(preference):
    if not isinstance(preference, dict) or set(preference) != {"require", "exclude"}:
        return "preference must give exactly require and exclude"
    for key in ("require", "exclude"):
        tags = preference[key]
        if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
            return f"preference {key} must be a list of tags"
    return None


def load(workspace, path):
    return json.loads((Path(workspace) / path).read_text(encoding="utf-8"))


def per_serving(recipe, ingredients):
    return {
        nutrient: sum(grams / 100 * ingredients[name][nutrient] for name, grams in recipe["ingredients"].items())
        for nutrient in NUTRIENTS
    }


def matches(recipe, meal, preference):
    tags = set(recipe["tags"])
    return meal in recipe["meals"] and set(preference["require"]) <= tags and not tags & set(preference["exclude"])


def eligible(recipes, meal, preference):
    """The names of the recipes for ``meal`` that meet the preference, sorted."""
    return sorted(name for name, recipe in recipes.items() if matches(recipe, meal, preference))


def dish_problems(dishes, recipes, arguments):
    """What is wrong with the dishes of a meal for the task's arguments, beyond its totals."""
    if not isinstance(dishes, list) or not dishes:
        return ["the meal has no dishes"]
    allowed = eligible(recipes, arguments["meal"], arguments["preference"])
    problems = []
    seen = set()
    for dish in dishes:
        name = dish.get("recipe") if isinstance(dish, dict) else None
        servings = dish.get("servings") if isinstance(dish, dict) else None
        if name not in recipes:
            problems.append(f"{name!r} is not a recipe")
        elif name in seen:
            problems.append(f"{name} is listed twice")
        elif name not in allowed:
            problems.append(f"{name} is not a {arguments['meal']} recipe that meets the preference")
        if isinstance(servings, bool) or not isinstance(servings, int) or not 1 <= servings <= arguments["max_servings"]:
            problems.append(f"{name}: servings must be a whole number from 1 to {arguments['max_servings']}")
        seen.add(name)
    return problems


def totals(dishes, recipes, ingredients):
    """The meal's kcal and grams of each nutrient: servings x per serving, summed over the dishes."""
    nutrition = {dish["recipe"]: per_serving(recipes[dish["recipe"]], ingredients) for dish in dishes}
    return {
        nutrient: sum(dish["servings"] * nutrition[dish["recipe"]][nutrient] for dish in dishes) for nutrient in NUTRIENTS
    }


def constraint_problems(meal_totals, constraints):
    problems = []
    for nutrient, bound in constraints.items():
        total = meal_totals[nutrient]
        if "min" in bound and total < bound["min"] - EPSILON:
            problems.append(f"{nutrient} is {total:.2f}, below the minimum {bound['min']}")
        if "max" in bound and total > bound["max"] + EPSILON:
            problems.append(f"{nutrient} is {total:.2f}, above the maximum {bound['max']}")
    return problems


def rounded(values):
    return {key: round(value, 3) for key, value in values.items()}
