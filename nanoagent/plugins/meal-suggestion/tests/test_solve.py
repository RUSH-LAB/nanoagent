from __future__ import annotations

import itertools

import pytest
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


def solved(arguments: dict = DINNER) -> dict:
    """solve's output for ``arguments``, as JSON."""
    return plain_output(solve(build_output(arguments, SolveInput)))


def exhaustive(arguments: dict) -> tuple[float, float]:
    """The best and the worst preference score over every combination of servings, by enumeration."""
    given = build_output(arguments, SolveInput)
    eligible = [recipe for recipe in load_recipes().values() if matches(recipe, given.meal, given.restrictions)]
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


def test_pins_the_best_liked_dinner_and_the_worst() -> None:
    # Cheese (2) and beans (1) are the most a dinner within the limits can have: the enchilada stack
    # with a bean dish. Several such dinners tie; any is the best.
    found = solve(build_output(DINNER, SolveInput))
    assert (found.score, found.lowest_score) == (3.0, 1.0)
    assert "Cheese Enchilada Stack" in [dish.recipe for dish in found.dishes]
    assert all(isinstance(dish, Dish) and 1 <= dish.servings <= 2 for dish in found.dishes)
    stack = next(dish for dish in found.dishes if dish.recipe == "Cheese Enchilada Stack")
    assert stack.liked == ["cheese"] and stack.url.startswith("https://www.food.com/recipe/")


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
def test_matches_exhaustive_search(changes: dict) -> None:
    arguments = DINNER | changes
    found = solved(arguments)
    assert (found["score"], found["lowest_score"]) == pytest.approx(exhaustive(arguments))


def test_fails_clearly_when_no_meal_fits() -> None:
    with pytest.raises(ValueError, match="no dinner of whole servings meets every constraint"):
        solved(DINNER | {"constraints": {"protein": {"min": 100, "max": None}, "kcal": {"min": None, "max": 1000}}})
    with pytest.raises(ValueError, match="no dinner recipe meets the restrictions"):
        solved(DINNER | {"restrictions": {"require": ["Vegan"], "exclude": ["Beans"]}})
    with pytest.raises(ValueError, match="min is above its max"):
        solved(DINNER | {"constraints": {"kcal": {"min": 900, "max": 800}}})
    with pytest.raises(ValueError, match="each name once"):
        solved(DINNER | {"likes": [LIKES[0], LIKES[0]]})
    with pytest.raises(ValueError, match="one or more words"):
        solved(DINNER | {"likes": [{"name": "cheese", "words": [], "ignore": [], "weight": 1}]})
