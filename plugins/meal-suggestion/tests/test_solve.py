from __future__ import annotations

import itertools
from pathlib import Path

import pytest
from conftest import INGREDIENTS, RECIPES

from plugin.meals import NUTRIENTS, load_ingredients, load_recipes, matches, per_serving
from plugin.solve import solve

DINNER = {
    "ingredients": INGREDIENTS,
    "recipes": RECIPES,
    "meal": "dinner",
    "constraints": {"protein": {"min": 50}, "kcal": {"max": 1000}, "fiber": {"min": 10}},
    "preference": {"require": ["vegetarian"], "exclude": []},
    "objective": {"sense": "maximize", "nutrient": "protein"},
    "max_servings": 2,
}


def exhaustive(workspace: Path, arguments: dict) -> float:
    """The optimum over every combination of servings, by enumeration."""
    foods = load_ingredients(workspace, INGREDIENTS)
    recipes = load_recipes(workspace, RECIPES, foods)
    nutrition = [
        per_serving(recipe, foods)
        for recipe in recipes.values()
        if matches(recipe, arguments["meal"], arguments["preference"])
    ]
    values = []
    for servings in itertools.product(range(arguments["max_servings"] + 1), repeat=len(nutrition)):
        totals = {n: sum(count * dish[n] for count, dish in zip(servings, nutrition)) for n in NUTRIENTS}
        if sum(servings) and all(
            bound.get("min", 0) <= totals[n] <= bound.get("max", float("inf"))
            for n, bound in arguments["constraints"].items()
        ):
            values.append(totals[arguments["objective"]["nutrient"]])
    best = max if arguments["objective"]["sense"] == "maximize" else min
    return best(values)


def test_pins_the_optimal_vegetarian_dinner(workspace: Path) -> None:
    found = solve(**DINNER, workspace=workspace)
    assert found["plan"] == [{"recipe": "lentil soup", "servings": 1}, {"recipe": "tofu broccoli stir-fry", "servings": 1}]
    assert found["objective"] == pytest.approx(66.8)
    assert found["totals"]["kcal"] == pytest.approx(966.6)
    assert sorted(found["recipes"]) == [
        "black bean burrito bowl",
        "chickpea quinoa salad",
        "lentil soup",
        "tofu broccoli stir-fry",
        "whole wheat pasta with lentil marinara",
    ]


@pytest.mark.parametrize(
    "changes",
    [
        {},
        {"objective": {"sense": "minimize", "nutrient": "kcal"}},
        {"meal": "breakfast", "constraints": {"protein": {"min": 30}}, "objective": {"sense": "minimize", "nutrient": "fat"}},
        {"meal": "lunch", "preference": {"require": [], "exclude": ["dairy"]}, "max_servings": 3},
        {"constraints": {"fiber": {"min": 40, "max": 45}}, "objective": {"sense": "maximize", "nutrient": "carbs"}},
    ],
)
def test_matches_exhaustive_search(workspace: Path, changes: dict) -> None:
    arguments = DINNER | changes
    assert solve(**arguments, workspace=workspace)["objective"] == pytest.approx(exhaustive(workspace, arguments))


def test_fails_clearly_when_no_meal_fits(workspace: Path) -> None:
    with pytest.raises(ValueError, match="no dinner of whole servings meets every constraint"):
        solve(**DINNER | {"constraints": {"protein": {"min": 200}, "kcal": {"max": 1000}}}, workspace=workspace)
    with pytest.raises(ValueError, match="no dinner recipe meets the preference"):
        solve(**DINNER | {"preference": {"require": ["vegan"], "exclude": ["vegetarian"]}}, workspace=workspace)
    with pytest.raises(ValueError, match="min is above its max"):
        solve(**DINNER | {"constraints": {"kcal": {"min": 900, "max": 800}}}, workspace=workspace)
