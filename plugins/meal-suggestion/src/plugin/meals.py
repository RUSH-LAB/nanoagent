"""The ingredient and recipe files, each recipe's nutrition per serving, and the agent's tools."""

from __future__ import annotations

import json
from pathlib import Path

NUTRIENTS = ("kcal", "protein", "fat", "carbs", "fiber")
MEALS = ("breakfast", "lunch", "dinner")
# The file submit_meal writes and the task's verifier reads, relative to the workspace.
SUGGESTION = "meal.json"


def _input_file(workspace: Path, path: str) -> dict:
    """The JSON object in the input file ``path``, which must stay inside ``workspace``."""
    relative = Path(path)
    root = workspace.resolve()
    file = (root / relative).resolve()
    if relative.is_absolute() or ".." in relative.parts or not file.is_relative_to(root):
        raise ValueError(f"{path} must stay inside the plugin workspace")
    if not file.is_file():
        raise FileNotFoundError(f"no input file at {path}")
    data = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not data:
        raise ValueError(f"{path} must hold a non-empty JSON object")
    return data


def load_ingredients(workspace: Path, path: str) -> dict[str, dict[str, float]]:
    """Each ingredient's kcal and grams of protein, fat, carbs and fiber per 100 g."""
    ingredients = _input_file(workspace, path)
    for name, values in ingredients.items():
        if not isinstance(values, dict) or set(values) != set(NUTRIENTS):
            raise ValueError(f"ingredient {name!r} must give exactly {', '.join(NUTRIENTS)} per 100 g")
        if any(isinstance(value, bool) or not isinstance(value, int | float) or value < 0 for value in values.values()):
            raise ValueError(f"ingredient {name!r} has a nutrient that is not a non-negative number")
    return ingredients


def load_recipes(workspace: Path, path: str, ingredients: dict | None = None) -> dict[str, dict]:
    """Each recipe's meals, tags and grams of each ingredient per serving; with ``ingredients``,
    every ingredient a recipe uses must be one of them."""
    recipes = _input_file(workspace, path)
    for name, recipe in recipes.items():
        if not isinstance(recipe, dict) or set(recipe) != {"meals", "tags", "ingredients"}:
            raise ValueError(f"recipe {name!r} must give exactly meals, tags and ingredients")
        if not recipe["meals"] or not set(recipe["meals"]) <= set(MEALS):
            raise ValueError(f"recipe {name!r} must be for one or more of {', '.join(MEALS)}")
        if not isinstance(recipe["tags"], list) or not all(isinstance(tag, str) for tag in recipe["tags"]):
            raise ValueError(f"recipe {name!r} tags must be a list of strings")
        uses = recipe["ingredients"]
        if not isinstance(uses, dict) or not uses:
            raise ValueError(f"recipe {name!r} must use at least one ingredient")
        for ingredient, grams in uses.items():
            if isinstance(grams, bool) or not isinstance(grams, int | float) or grams <= 0:
                raise ValueError(f"recipe {name!r} must use a positive number of grams of {ingredient!r}")
            if ingredients is not None and ingredient not in ingredients:
                raise ValueError(f"recipe {name!r} uses {ingredient!r}, which is not in the ingredients file")
    return recipes


def per_serving(recipe: dict, ingredients: dict) -> dict[str, float]:
    """One serving's kcal and grams of each nutrient: the sum over its ingredients of grams / 100 x per 100 g."""
    return {
        nutrient: sum(grams / 100 * ingredients[name][nutrient] for name, grams in recipe["ingredients"].items())
        for nutrient in NUTRIENTS
    }


def matches(recipe: dict, meal: str, preference: dict) -> bool:
    """Whether the recipe is for ``meal`` and has every required tag and no excluded one."""
    tags = set(recipe["tags"])
    return meal in recipe["meals"] and set(preference["require"]) <= tags and not tags & set(preference["exclude"])


def rounded(values: dict[str, float]) -> dict[str, float]:
    return {key: round(value, 3) for key, value in values.items()}


def list_recipes(recipes: str, meal: str, preference: dict, *, workspace: Path) -> dict:
    """The recipes for ``meal`` that meet the preference, by name."""
    found = load_recipes(workspace, recipes)
    return {
        "ok": True,
        "recipes": [
            {"name": name, "tags": recipe["tags"]}
            for name, recipe in sorted(found.items())
            if matches(recipe, meal, preference)
        ],
    }


def nutrition(ingredients: str, recipes: str, recipe: str, *, workspace: Path) -> dict:
    """One serving of ``recipe``: its ingredients' grams and its nutrition."""
    foods = load_ingredients(workspace, ingredients)
    found = load_recipes(workspace, recipes, foods)
    if recipe not in found:
        raise ValueError(f"no recipe named {recipe!r}")
    return {
        "ok": True,
        "recipe": recipe,
        "ingredients": found[recipe]["ingredients"],
        "per_serving": rounded(per_serving(found[recipe], foods)),
    }


def submit_meal(dishes: list[dict], *, workspace: Path) -> dict:
    """Write the suggestion, each dish's recipe and whole servings, to `meal.json`, replacing an
    earlier one."""
    names = [dish["recipe"] for dish in dishes]
    if not dishes or len(set(names)) != len(names):
        raise ValueError("dishes must name at least one recipe, each once")
    path = workspace.resolve() / SUGGESTION
    path.write_text(json.dumps({"dishes": dishes}, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "path": str(path), "dishes": len(dishes)}
