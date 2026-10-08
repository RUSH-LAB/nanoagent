from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import RECIPES
from slimconfig import build_output, plain_output
from test_solve import DINNER, solved

import plugin.meals
import verifier
import verifier.meals
from contract import TOOLS, SolveInput, SolveOutput, Tool
from plugin.meals import list_recipes, nutrition, submit_meal

OPTIMUM = [
    {"recipe": "Baja Black Beans, Corn and Rice", "servings": 1},
    {"recipe": "Cheese Enchilada Stack", "servings": 1},
]


# The verifier gets contract instances, as NanoAgent's sandbox builds them from JSON.
def verify_input(tool: str, value: dict) -> dict:
    return verifier.verify_input(tool, build_output(value, TOOLS[Tool(tool)][0]))


def verify_output(tool: str, value: dict, output: dict, workspace: Path) -> dict:
    given, made = TOOLS[Tool(tool)]
    return verifier.verify_output(tool, build_output(value, given), build_output(output, made), str(workspace))


def verify_task(arguments: dict, reference: dict, workspace: Path) -> dict:
    return verifier.verify_task(
        "suggest-meal", build_output(arguments, SolveInput), build_output(reference, SolveOutput), str(workspace)
    )


def suggest(workspace: Path, dishes: list[dict], arguments: dict = DINNER) -> dict:
    reference = solved(workspace, arguments)
    (workspace / "meal.json").write_text(json.dumps({"dishes": dishes}))
    return verify_task(arguments, reference, workspace)


def test_the_verifier_and_the_plugin_read_nutrition_and_score_alike(workspace: Path) -> None:
    recipes = verifier.meals.load_recipes(workspace, RECIPES)
    likes = build_output(DINNER, SolveInput).likes
    for name, recipe in plugin.meals.load_recipes(workspace, RECIPES).items():
        assert verifier.meals.per_serving(recipes[name]) == plugin.meals.per_serving(recipe)
        assert verifier.meals.liked(recipes[name], likes) == plugin.meals.liked(recipe, likes)


def test_scores_the_best_liked_meal_one(workspace: Path) -> None:
    verdict = suggest(workspace, OPTIMUM)
    assert verdict["valid"] is True and verdict["score"] == 1.0
    assert verdict["details"]["dishes"] == OPTIMUM and verdict["details"]["preference"] == 3


def test_scores_a_feasible_meal_by_where_it_falls_between_the_worst_and_the_best(workspace: Path) -> None:
    # Beans twice (1 + 1) of a best 3 and a worst 1: halfway.
    middle = [
        {"recipe": "Black Bean and Couscous Salad", "servings": 2},
        {"recipe": "Baja Black Beans, Corn and Rice", "servings": 1},
    ]
    assert suggest(workspace, middle)["score"] == pytest.approx(0.5)
    # Beans and a dish that is beans and spinach (1 + 0): the worst.
    worst = [
        {"recipe": "Black Bean and Couscous Salad", "servings": 2},
        {"recipe": "Chickpeas With Spinach (Greek)", "servings": 1},
    ]
    verdict = suggest(workspace, worst)
    assert verdict["valid"] is True and verdict["score"] == 0.0


def test_scores_every_feasible_meal_one_when_all_score_alike(workspace: Path) -> None:
    verdict = suggest(workspace, OPTIMUM, DINNER | {"likes": []})
    assert verdict["valid"] is True and verdict["score"] == 1.0


def test_refuses_a_missing_suggestion(workspace: Path) -> None:
    verdict = verify_task(DINNER, solved(workspace), workspace)
    assert verdict["valid"] is False and verdict["score"] == 0.0
    assert verdict["message"] == "no suggestion at meal.json"


@pytest.mark.parametrize(
    ("dishes", "problem"),
    [
        ([], "the meal has no dishes"),
        ([{"recipe": "pizza", "servings": 1}], "'pizza' is not a recipe"),
        (
            [{"recipe": "Baked Chicken Breasts", "servings": 2}],
            "Baked Chicken Breasts is not a dinner recipe that meets the restrictions",
        ),
        (
            [{"recipe": "Chickpea Burger", "servings": 1}],
            "Chickpea Burger is not a dinner recipe that meets the restrictions",
        ),
        (
            [{"recipe": "Cheese Enchilada Stack", "servings": 3}],
            "Cheese Enchilada Stack: servings must be a whole number from 1 to 2",
        ),
        ([{"recipe": "Cheese Enchilada Stack", "servings": 1}] * 2, "Cheese Enchilada Stack is listed twice"),
        ([{"recipe": "Chickpeas With Spinach (Greek)", "servings": 1}], "protein is 13.30, below the minimum 30"),
        ([{"recipe": "Cheese Enchilada Stack", "servings": 2}], "kcal is 1127.80, above the maximum 1000"),
    ],
)
def test_refuses_a_meal_breaking_the_preference_servings_or_constraints(
    workspace: Path, dishes: list[dict], problem: str
) -> None:
    verdict = suggest(workspace, dishes)
    assert verdict["valid"] is False and verdict["score"] == 0.0
    assert problem in verdict["details"]["problems"]


def test_refuses_a_meal_beating_the_pinned_optimum(workspace: Path) -> None:
    reference = solved(workspace) | {"score": 2.0}
    (workspace / "meal.json").write_text(json.dumps({"dishes": OPTIMUM}))
    verdict = verify_task(DINNER, reference, workspace)
    assert verdict["valid"] is False and "the reference is wrong" in verdict["message"]


def test_checks_the_pinned_reference(workspace: Path) -> None:
    reference = solved(workspace)
    assert verify_output("solve", DINNER, reference, workspace)["valid"] is True
    tampered = reference | {"score": 4.0}
    assert verify_output("solve", DINNER, tampered, workspace)["valid"] is False
    infeasible = reference | {"plan": [{"recipe": "Chickpeas With Spinach (Greek)", "servings": 1}], "score": 0.0}
    assert verify_output("solve", DINNER, infeasible, workspace)["message"] == "the plan breaks a constraint"
    assert verify_input("solve", DINNER | {"constraints": {"kcal": {"min": 900, "max": 800}}})["valid"] is False
    assert verify_input("solve", DINNER | {"constraints": {"kcal": {"min": None, "max": None}}})["valid"] is False
    assert verify_input("solve", DINNER | {"max_servings": 11})["valid"] is False
    assert verify_input("solve", DINNER | {"recipes": "../recipes.json"})["valid"] is False
    assert (
        verify_input("solve", DINNER | {"likes": [{"name": "x", "words": [], "ignore": [], "weight": 1}]})["valid"]
        is False
    )
    assert verify_output("solve", DINNER, reference | {"worst": 3.5}, workspace)["valid"] is False


def test_checks_the_agent_tools_outputs(workspace: Path) -> None:
    calls = [
        (
            "list_recipes",
            {"recipes": RECIPES, "meal": "dinner", "restrictions": DINNER["restrictions"], "likes": DINNER["likes"]},
            list_recipes,
        ),
        ("nutrition", {"recipes": RECIPES, "recipe": "Chickpea Curry (Garbanzos)"}, nutrition),
        ("submit_meal", {"dishes": OPTIMUM}, submit_meal),
    ]
    outputs = {}
    for tool, value, function in calls:
        assert verify_input(tool, value)["valid"] is True
        outputs[tool] = plain_output(function(build_output(value, TOOLS[Tool(tool)][0]), workspace))
        assert verify_output(tool, value, outputs[tool], workspace)["valid"] is True
    listed = outputs["list_recipes"]
    listed["recipes"][0]["score"] += 1
    assert verify_output("list_recipes", calls[0][1], listed, workspace)["valid"] is False
    listed["recipes"].pop()
    assert verify_output("list_recipes", calls[0][1], listed, workspace)["valid"] is False
    soup = outputs["nutrition"]
    soup["per_serving"]["protein"] += 1
    assert verify_output("nutrition", calls[1][1], soup, workspace)["valid"] is False
    assert verify_input("submit_meal", {"dishes": [OPTIMUM[0], OPTIMUM[0]]})["valid"] is False
