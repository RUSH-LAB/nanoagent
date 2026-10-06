from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import INGREDIENTS, RECIPES
from test_solve import DINNER

import plugin.meals
import verifier
import verifier.meals
from plugin.meals import list_recipes, nutrition, submit_meal
from plugin.solve import solve

OPTIMUM = [{"recipe": "lentil soup", "servings": 1}, {"recipe": "tofu broccoli stir-fry", "servings": 1}]


def suggest(workspace: Path, dishes: list[dict], arguments: dict = DINNER) -> dict:
    reference = solve(**arguments, workspace=workspace)
    (workspace / "meal.json").write_text(json.dumps({"dishes": dishes}))
    return verifier.verify_task("suggest-meal", arguments, reference, str(workspace))


def test_the_verifier_and_the_plugin_compute_nutrition_alike(workspace: Path) -> None:
    foods = plugin.meals.load_ingredients(workspace, INGREDIENTS)
    for recipe in plugin.meals.load_recipes(workspace, RECIPES, foods).values():
        assert verifier.meals.per_serving(recipe, foods) == plugin.meals.per_serving(recipe, foods)


def test_scores_the_optimal_meal_one(workspace: Path) -> None:
    verdict = suggest(workspace, OPTIMUM)
    assert verdict["valid"] is True and verdict["score"] == 1.0
    assert verdict["details"]["dishes"] == OPTIMUM


def test_scores_a_feasible_meal_by_its_share_of_the_maximum(workspace: Path) -> None:
    verdict = suggest(workspace, [{"recipe": "lentil soup", "servings": 2}])
    assert verdict["valid"] is True
    assert verdict["score"] == pytest.approx(50.3 / 66.8, abs=1e-6)


def test_scores_a_feasible_meal_by_the_minimums_share_of_it(workspace: Path) -> None:
    arguments = DINNER | {"objective": {"sense": "minimize", "nutrient": "kcal"}}
    reference = solve(**arguments, workspace=workspace)
    verdict = suggest(workspace, OPTIMUM, arguments)
    assert verdict["valid"] is True
    assert verdict["score"] == pytest.approx(reference["objective"] / 966.6, abs=1e-6) and verdict["score"] < 1


def test_refuses_a_missing_suggestion(workspace: Path) -> None:
    verdict = verifier.verify_task("suggest-meal", DINNER, solve(**DINNER, workspace=workspace), str(workspace))
    assert verdict["valid"] is False and verdict["score"] == 0.0
    assert verdict["message"] == "no suggestion at meal.json"


@pytest.mark.parametrize(
    ("dishes", "problem"),
    [
        ([], "the meal has no dishes"),
        ([{"recipe": "pizza", "servings": 1}], "'pizza' is not a recipe"),
        ([{"recipe": "chicken rice bowl", "servings": 2}], "chicken rice bowl is not a dinner recipe that meets the preference"),
        ([{"recipe": "greek yogurt bowl", "servings": 1}], "greek yogurt bowl is not a dinner recipe that meets the preference"),
        ([{"recipe": "lentil soup", "servings": 3}], "lentil soup: servings must be a whole number from 1 to 2"),
        ([{"recipe": "lentil soup", "servings": 1}] * 2, "lentil soup is listed twice"),
        ([{"recipe": "lentil soup", "servings": 1}], "protein is 25.15, below the minimum 50"),
        ([{"recipe": "tofu broccoli stir-fry", "servings": 2}], "kcal is 1193.80, above the maximum 1000"),
    ],
)
def test_refuses_a_meal_breaking_the_preference_servings_or_constraints(
    workspace: Path, dishes: list[dict], problem: str
) -> None:
    verdict = suggest(workspace, dishes)
    assert verdict["valid"] is False and verdict["score"] == 0.0
    assert problem in verdict["details"]["problems"]


def test_refuses_a_meal_beating_the_pinned_optimum(workspace: Path) -> None:
    reference = solve(**DINNER, workspace=workspace) | {"objective": 60.0}
    (workspace / "meal.json").write_text(json.dumps({"dishes": OPTIMUM}))
    verdict = verifier.verify_task("suggest-meal", DINNER, reference, str(workspace))
    assert verdict["valid"] is False and "the reference is wrong" in verdict["message"]


def test_checks_the_pinned_reference(workspace: Path) -> None:
    reference = solve(**DINNER, workspace=workspace)
    assert verifier.verify_output("solve", DINNER, reference, str(workspace))["valid"] is True
    tampered = reference | {"objective": 70.0}
    assert verifier.verify_output("solve", DINNER, tampered, str(workspace))["valid"] is False
    infeasible = reference | {"plan": [{"recipe": "lentil soup", "servings": 1}], "objective": 25.15}
    assert verifier.verify_output("solve", DINNER, infeasible, str(workspace))["message"] == "the plan breaks a constraint"
    bad = DINNER | {"constraints": {"kcal": {"min": 900, "max": 800}}}
    assert verifier.verify_input("solve", bad)["valid"] is False
    assert verifier.verify_input("solve", DINNER | {"recipes": "../recipes.json"})["valid"] is False


def test_checks_the_agent_tools_outputs(workspace: Path) -> None:
    calls = [
        ("list_recipes", {"recipes": RECIPES, "meal": "dinner", "preference": DINNER["preference"]}, list_recipes),
        ("nutrition", {"ingredients": INGREDIENTS, "recipes": RECIPES, "recipe": "lentil soup"}, nutrition),
        ("submit_meal", {"dishes": OPTIMUM}, submit_meal),
    ]
    for tool, value, function in calls:
        assert verifier.verify_input(tool, value)["valid"] is True
        output = function(**value, workspace=workspace)
        assert verifier.verify_output(tool, value, output, str(workspace))["valid"] is True
    listed = list_recipes(**calls[0][1], workspace=workspace)
    listed["recipes"].pop()
    assert verifier.verify_output("list_recipes", calls[0][1], listed, str(workspace))["valid"] is False
    soup = nutrition(**calls[1][1], workspace=workspace)
    soup["per_serving"]["protein"] += 1
    assert verifier.verify_output("nutrition", calls[1][1], soup, str(workspace))["valid"] is False
    assert verifier.verify_input("submit_meal", {"dishes": [OPTIMUM[0], OPTIMUM[0]]})["valid"] is False
