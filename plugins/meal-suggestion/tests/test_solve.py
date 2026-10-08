from __future__ import annotations

import itertools
from pathlib import Path

import pytest
from conftest import RECIPES
from slimconfig import build_output, plain_output

from contract import Dish, SolveInput
from plugin.meals import NUTRIENTS, load_recipes, matches, per_serving, score
from plugin.solve import solve

LIKES = [
    {"name": "cheese", "words": ["cheese"], "ignore": [], "weight": 2},
    {"name": "beans", "words": ["bean", "chickpea"], "ignore": [], "weight": 1},
    {"name": "spinach", "words": ["spinach"], "ignore": [], "weight": -1},
]
# A solve input as JSON, the way a task's arguments arrive.
DINNER = {
    "recipes": RECIPES,
    "meal": "dinner",
    "constraints": {
        "protein": {"min": 30, "max": None},
        "kcal": {"min": None, "max": 1000},
        "fiber": {"min": 10, "max": None},
    },
    "restrictions": {"require": [], "exclude": ["Meat", "Poultry"]},
    "likes": LIKES,
    "max_servings": 2,
}


def solved(workspace: Path, arguments: dict = DINNER) -> dict:
    """solve's output for ``arguments``, as JSON."""
    return plain_output(solve(build_output(arguments, SolveInput), workspace))


def exhaustive(workspace: Path, arguments: dict) -> tuple[float, float]:
    """The best and the worst preference score over every combination of servings, by enumeration."""
    recipes = load_recipes(workspace, RECIPES)
    given = build_output(arguments, SolveInput)
    eligible = [recipe for recipe in recipes.values() if matches(recipe, given.meal, given.restrictions)]
    nutrition = [per_serving(recipe) for recipe in eligible]
    scores = [score(recipe, given.likes) for recipe in eligible]
    values = []
    for servings in itertools.product(range(arguments["max_servings"] + 1), repeat=len(eligible)):
        totals = {n: sum(count * dish[n] for count, dish in zip(servings, nutrition)) for n in NUTRIENTS}
        if sum(servings) and all(
            (bound["min"] or 0) <= totals[n] <= (float("inf") if bound["max"] is None else bound["max"])
            for n, bound in arguments["constraints"].items()
        ):
            values.append(sum(value for count, value in zip(servings, scores) if count))
    return max(values), min(values)


def test_scores_each_recipe_by_the_likes_it_matches(workspace: Path) -> None:
    found = solve(build_output(DINNER, SolveInput), workspace)
    assert found.scores == {
        "Baja Black Beans, Corn and Rice": 1,
        "Black Bean and Couscous Salad": 1,
        "Cheese Enchilada Stack": 2,
        "Chickpea Curry (Garbanzos)": 1,
        "Chickpeas With Spinach (Greek)": 0,
    }


def test_pins_the_best_liked_dinner_and_the_worst(workspace: Path) -> None:
    # Cheese (2) and beans (1) are the most a dinner within the limits can have: the enchilada stack
    # with a bean dish. Several such dinners tie; any is the best.
    found = solve(build_output(DINNER, SolveInput), workspace)
    assert (found.score, found.worst) == (3.0, 1.0)
    assert sum(found.scores[dish.recipe] for dish in found.plan) == 3.0
    assert "Cheese Enchilada Stack" in [dish.recipe for dish in found.plan]
    assert all(isinstance(dish, Dish) and 1 <= dish.servings <= 2 for dish in found.plan)


@pytest.mark.parametrize(
    "changes",
    [
        {},
        {"likes": [{"name": "rice", "words": ["rice"], "ignore": [], "weight": 3}, *LIKES]},
        {
            "meal": "breakfast",
            "constraints": {"protein": {"min": 30, "max": None}},
            "likes": [{"name": "eggs", "words": ["egg"], "ignore": [], "weight": 1}],
        },
        {"meal": "lunch", "restrictions": {"require": [], "exclude": ["Meat"]}, "max_servings": 3},
        {"constraints": {"fiber": {"min": 30, "max": 35}}},
        {"likes": []},
    ],
)
def test_matches_exhaustive_search(workspace: Path, changes: dict) -> None:
    arguments = DINNER | changes
    found = solved(workspace, arguments)
    assert (found["score"], found["worst"]) == pytest.approx(exhaustive(workspace, arguments))


def test_fails_clearly_when_no_meal_fits(workspace: Path) -> None:
    with pytest.raises(ValueError, match="no dinner of whole servings meets every constraint"):
        solved(
            workspace,
            DINNER | {"constraints": {"protein": {"min": 100, "max": None}, "kcal": {"min": None, "max": 1000}}},
        )
    with pytest.raises(ValueError, match="no dinner recipe meets the restrictions"):
        solved(workspace, DINNER | {"restrictions": {"require": ["Vegan"], "exclude": ["Beans"]}})
    with pytest.raises(ValueError, match="min is above its max"):
        solved(workspace, DINNER | {"constraints": {"kcal": {"min": 900, "max": 800}}})
    with pytest.raises(ValueError, match="each name once"):
        solved(workspace, DINNER | {"likes": [LIKES[0], LIKES[0]]})
    with pytest.raises(ValueError, match="one or more words"):
        solved(workspace, DINNER | {"likes": [{"name": "cheese", "words": [], "ignore": [], "weight": 1}]})
