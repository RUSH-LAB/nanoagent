from __future__ import annotations

import itertools
import json
from pathlib import Path

import pytest
from conftest import RECIPES
from slimconfig import build_output, plain_output
from test_solve import LIKES

import verifier
from contract import TOOLS, DayInput, DayOutput, Tool
from plugin.meals import NUTRIENTS, load_recipes, matches, per_serving, score, submit_day
from plugin.solve import solve_day

# A day as JSON: each meal's own bounds and the day's, both to be met.
DAY = {
    "recipes": RECIPES,
    "meals": {
        "breakfast": {"kcal": {"min": None, "max": 600}},
        "lunch": {"kcal": {"min": None, "max": 800}},
        "dinner": {"protein": {"min": 20, "max": None}},
    },
    "day": {
        "protein": {"min": 60, "max": None},
        "kcal": {"min": None, "max": 2000},
        "fiber": {"min": 25, "max": None},
    },
    "restrictions": {"require": [], "exclude": ["Meat", "Poultry"]},
    "likes": LIKES,
    "max_servings": 1,
}


def planned(workspace: Path, arguments: dict = DAY) -> dict:
    return plain_output(solve_day(build_output(arguments, DayInput), workspace))


def within(totals: dict, constraints: dict) -> bool:
    return all(
        (bound["min"] or 0) - 1e-9 <= totals[n] <= (float("inf") if bound["max"] is None else bound["max"]) + 1e-9
        for n, bound in constraints.items()
    )


def exhaustive(workspace: Path, arguments: dict) -> tuple[float, float]:
    """The best and the worst preference score over every day of servings, by enumeration."""
    recipes = load_recipes(workspace, RECIPES)
    given = build_output(arguments, DayInput)
    meals = {
        meal: [recipe for recipe in recipes.values() if matches(recipe, meal, given.restrictions)]
        for meal in given.meals
    }
    choices = {
        meal: [
            servings
            for servings in itertools.product(range(arguments["max_servings"] + 1), repeat=len(options))
            if sum(servings)
        ]
        for meal, options in meals.items()
    }
    values = []
    for day in itertools.product(*choices.values()):
        day_totals = dict.fromkeys(NUTRIENTS, 0.0)
        value, fits = 0.0, True
        for meal, servings in zip(meals, day):
            options = meals[meal]
            totals = {n: sum(c * per_serving(r)[n] for c, r in zip(servings, options)) for n in NUTRIENTS}
            fits = fits and within(totals, arguments["meals"][meal.value])
            day_totals = {n: day_totals[n] + totals[n] for n in NUTRIENTS}
            value += sum(score(r, given.likes) for c, r in zip(servings, options) if c)
        if fits and within(day_totals, arguments["day"]):
            values.append(value)
    return max(values), min(values)


def test_plans_a_day_meeting_each_meals_bounds_and_the_days(workspace: Path) -> None:
    found = planned(workspace)
    assert sorted(found["plan"]) == ["breakfast", "dinner", "lunch"]
    for meal, plan in found["plan"].items():
        assert plan["dishes"] and within(plan["totals"], DAY["meals"][meal])
    assert within(found["totals"], DAY["day"])
    assert found["score"] == sum(plan["score"] for plan in found["plan"].values())


@pytest.mark.parametrize(
    "changes",
    [
        {},
        # The day's protein binds: no meal alone asks for it.
        {"day": {"protein": {"min": 75, "max": None}, "kcal": {"min": None, "max": 2200}}},
        # The day's kcal binds, so the meals compete for it.
        {"day": {"kcal": {"min": None, "max": 1100}}},
        {"meals": {"lunch": {}, "dinner": {"fiber": {"min": 10, "max": None}}}, "max_servings": 2},
        {"likes": []},
    ],
)
def test_matches_exhaustive_search(workspace: Path, changes: dict) -> None:
    arguments = DAY | changes
    found = planned(workspace, arguments)
    assert (found["score"], found["worst"]) == pytest.approx(exhaustive(workspace, arguments))


def test_fails_clearly_when_no_day_fits(workspace: Path) -> None:
    with pytest.raises(ValueError, match="no day of whole servings meets every constraint"):
        planned(workspace, DAY | {"day": {"kcal": {"min": None, "max": 500}}})
    with pytest.raises(ValueError, match="one or more meals"):
        planned(workspace, DAY | {"meals": {}})
    with pytest.raises(ValueError, match="min is above its max"):
        planned(workspace, DAY | {"meals": {"lunch": {"kcal": {"min": 900, "max": 800}}}})


def check_task(workspace: Path, meals: dict, arguments: dict = DAY) -> dict:
    reference = planned(workspace, arguments)
    (workspace / "day.json").write_text(json.dumps({"meals": meals}))
    return verifier.verify_task(
        "plan-day", build_output(arguments, DayInput), build_output(reference, DayOutput), str(workspace)
    )


def test_scores_the_best_day_one_and_refuses_a_day_out_of_bounds(workspace: Path) -> None:
    best = {meal: plan["dishes"] for meal, plan in planned(workspace)["plan"].items()}
    verdict = check_task(workspace, best)
    assert verdict["valid"] is True and verdict["score"] == 1.0
    # Each meal fits its own bounds, but the day falls short of its protein.
    light = best | {"dinner": [{"recipe": "Black Bean and Couscous Salad", "servings": 1}]}
    light["lunch"] = [{"recipe": "Chickpea Burger", "servings": 1}]
    verdict = check_task(workspace, light)
    assert verdict["valid"] is False and any(
        problem.startswith("day: protein") for problem in verdict["details"]["problems"]
    )
    verdict = check_task(workspace, {"breakfast": best["breakfast"]})
    assert verdict["valid"] is False and "exactly breakfast, lunch, dinner" in verdict["details"]["problems"][0]
    wrong = best | {"breakfast": [{"recipe": "Cheese Enchilada Stack", "servings": 1}]}
    verdict = check_task(workspace, wrong)
    assert (
        "breakfast: Cheese Enchilada Stack is not a breakfast recipe that meets the restrictions"
        in verdict["details"]["problems"]
    )


def test_checks_the_pinned_day_and_the_submitted_one(workspace: Path) -> None:
    given = build_output(DAY, DayInput)
    reference = planned(workspace)
    assert (
        verifier.verify_output("solve_day", given, build_output(reference, DayOutput), str(workspace))["valid"] is True
    )
    tampered = build_output(reference | {"score": reference["score"] + 1}, DayOutput)
    assert verifier.verify_output("solve_day", given, tampered, str(workspace))["valid"] is False
    assert verifier.verify_input("solve_day", build_output(DAY | {"meals": {}}, DayInput))["valid"] is False

    meals = {meal: plan["dishes"] for meal, plan in reference["plan"].items()}
    submitted = build_output({"meals": meals}, TOOLS[Tool.SUBMIT_DAY][0])
    assert verifier.verify_input("submit_day", submitted)["valid"] is True
    written = submit_day(submitted, workspace)
    assert verifier.verify_output("submit_day", submitted, written, str(workspace))["valid"] is True
    assert json.loads((workspace / "day.json").read_text()) == {"meals": meals}
