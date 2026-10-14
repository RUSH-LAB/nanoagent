from __future__ import annotations

import itertools

import pytest
from slimconfig import build_output, plain_output
from test_solve import LIKES
from test_verifier import dish, suggestion

import verifier
from contract import DayInput, DayOutput, DayPlan
from plugin.meals import NUTRIENTS, load_recipes, matches, per_serving, score
from plugin.solve import solve_day

# A day as JSON: each meal's own bounds and the day's, both to be met.
DAY = {
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


def planned(arguments: dict = DAY) -> dict:
    return plain_output(solve_day(build_output(arguments, DayInput)))


def within(totals: dict, constraints: dict) -> bool:
    return all(
        (bound["min"] or 0) - 1e-9 <= totals[n] <= (float("inf") if bound["max"] is None else bound["max"]) + 1e-9
        for n, bound in constraints.items()
    )


def exhaustive(arguments: dict) -> tuple[float, float]:
    """The best and the worst preference score over every day of servings, by enumeration."""
    recipes = load_recipes()
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


def test_plans_a_day_meeting_each_meals_bounds_and_the_days() -> None:
    found = planned()
    assert sorted(found["meals"]) == ["breakfast", "dinner", "lunch"]
    for name, plan in found["meals"].items():
        assert plan["dishes"] and within(plan["totals"], DAY["meals"][name])
    assert within(found["totals"], DAY["day"])


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
def test_matches_exhaustive_search(changes: dict) -> None:
    arguments = DAY | changes
    found = planned(arguments)
    assert (found["score"], found["lowest_score"]) == pytest.approx(exhaustive(arguments))


def test_fails_clearly_when_no_day_fits() -> None:
    with pytest.raises(ValueError, match="no day of whole servings meets every constraint"):
        planned(DAY | {"day": {"kcal": {"min": None, "max": 500}}})
    with pytest.raises(ValueError, match="one or more meals"):
        planned(DAY | {"meals": {}})
    with pytest.raises(ValueError, match="min is above its max"):
        planned(DAY | {"meals": {"lunch": {"kcal": {"min": 900, "max": 800}}}})


def check_task(meals: dict) -> dict:
    """The plan-day verdict on a day of ``meals`` (each meal's dishes), with its true totals."""
    every = [one for dishes in meals.values() for one in dishes]
    plan = {
        "meals": {name: suggestion(dishes) for name, dishes in meals.items()},
        "totals": suggestion(every)["totals"],
    }
    return verifier.verify_task(
        "plan-day", build_output(DAY, DayInput), build_output(plan, DayPlan), build_output(planned(), DayOutput), "."
    )


def test_scores_the_best_day_one_and_refuses_a_day_out_of_bounds() -> None:
    best = {name: plan["dishes"] for name, plan in planned()["meals"].items()}
    verdict = check_task(best)
    assert verdict["valid"] is True and verdict["score"] == 1.0
    # Each meal fits its own bounds, but the day falls short of its protein.
    light = best | {
        "dinner": [dish("Black Bean and Couscous Salad", liked=["beans"])],
        "lunch": [dish("Chickpea Burger", liked=["beans"])],
    }
    verdict = check_task(light)
    assert verdict["valid"] is False and any(
        problem.startswith("day: protein") for problem in verdict["details"]["problems"]
    )
    verdict = check_task({"breakfast": best["breakfast"]})
    assert verdict["valid"] is False and "exactly breakfast, lunch, dinner" in verdict["details"]["problems"][0]
    wrong = best | {"breakfast": [dish("Cheese Enchilada Stack", liked=["cheese"])]}
    verdict = check_task(wrong)
    assert (
        "breakfast: Cheese Enchilada Stack is not a breakfast recipe that meets the restrictions"
        in verdict["details"]["problems"]
    )


def test_checks_the_pinned_day() -> None:
    given = build_output(DAY, DayInput)
    reference = planned()
    assert verifier.verify_output("solve_day", given, build_output(reference, DayOutput), ".")["valid"] is True
    tampered = build_output(reference | {"score": reference["score"] + 1}, DayOutput)
    assert verifier.verify_output("solve_day", given, tampered, ".")["valid"] is False
    assert verifier.verify_input("solve_day", build_output(DAY | {"meals": {}}, DayInput))["valid"] is False
