from __future__ import annotations

import pytest
from conftest import DINNER, dish, solved, suggestion
from slimconfig import build_output, plain_output

import plugin.meals
import verifier
import verifier.meals
from contract import TASKS, TOOLS, SolveInput, SolveOutput, SuggestionOutput, Task, Tool
from plugin.meals import get_nutrition, list_recipes, load_recipes

WORKSPACE = "."

OPTIMUM = [
    dish("Baja Black Beans, Corn and Rice", liked=["beans"]),
    dish("Cheese Enchilada Stack", liked=["cheese"]),
]


# The verifier gets contract instances, as NanoAgent's sandbox builds them from JSON.
def verify_input(tool: str, value: dict) -> dict:
    return verifier.verify_input(tool, build_output(value, TOOLS[Tool(tool)][0]))


def verify_output(tool: str, value: dict, output: dict) -> dict:
    given, made = TOOLS[Tool(tool)]
    return verifier.verify_output(tool, build_output(value, given), build_output(output, made), WORKSPACE)


def suggest(output: dict, arguments: dict = DINNER, reference: dict | None = None) -> dict:
    return verifier.verify_task(
        "suggest-meal",
        build_output(arguments, SolveInput),
        build_output(output, SuggestionOutput),
        build_output(reference or solved(arguments), SolveOutput),
        WORKSPACE,
    )


def test_the_verifier_and_the_plugin_read_nutrition_and_score_alike() -> None:
    recipes = verifier.meals.load_recipes()
    likes = build_output(DINNER, SolveInput).likes
    for name, recipe in load_recipes().items():
        assert verifier.meals.per_serving(recipes[name]) == plugin.meals.per_serving(recipe)
        assert verifier.meals.liked(recipes[name], likes) == plugin.meals.liked(recipe, likes)


def test_scores_the_best_liked_meal_one() -> None:
    verdict = suggest(suggestion(OPTIMUM))
    assert verdict["valid"] is True and verdict["score"] == 1.0
    assert verdict["details"]["preference"] == 3


def test_scores_a_feasible_meal_by_where_it_falls_between_the_lowest_and_the_best() -> None:
    # Beans twice (1 + 1) of a best 3 and a lowest 1: halfway.
    middle = [
        dish("Black Bean and Couscous Salad", 2, ["beans"]),
        dish("Baja Black Beans, Corn and Rice", 1, ["beans"]),
    ]
    assert suggest(suggestion(middle))["score"] == pytest.approx(0.5)
    # Beans and a dish that is beans and spinach (1 + 0): the lowest.
    worst = [
        dish("Black Bean and Couscous Salad", 2, ["beans"]),
        dish("Chickpeas With Spinach (Greek)", 1, ["beans", "spinach"]),
    ]
    verdict = suggest(suggestion(worst))
    assert verdict["valid"] is True and verdict["score"] == 0.0


def test_scores_every_feasible_meal_one_when_all_score_alike() -> None:
    plain = [dict(one, liked=[]) for one in OPTIMUM]
    verdict = suggest(suggestion(plain), DINNER | {"likes": []})
    assert verdict["valid"] is True and verdict["score"] == 1.0


@pytest.mark.parametrize(
    ("dishes", "problem"),
    [
        ([], "the meal has no dishes"),
        ([dict(OPTIMUM[0], recipe="pizza")], "'pizza' is not a recipe"),
        (
            [dish("Baked Chicken Breasts", 2)],
            "Baked Chicken Breasts is not a dinner recipe that meets the restrictions",
        ),
        ([dish("Chickpea Burger", 1, ["beans"])], "Chickpea Burger is not a dinner recipe that meets the restrictions"),
        (
            [dish("Cheese Enchilada Stack", 3, ["cheese"])],
            "Cheese Enchilada Stack: servings must be a whole number from 1 to 2",
        ),
        ([OPTIMUM[1]] * 2, "Cheese Enchilada Stack is listed twice"),
        ([dict(OPTIMUM[1], url="https://example.com")], "Cheese Enchilada Stack: its url is not the recipe's"),
        (
            [dict(OPTIMUM[1], liked=[])],
            "Cheese Enchilada Stack: its likes are not the ones its ingredients and tags match",
        ),
        ([dish("Chickpeas With Spinach (Greek)", 1, ["beans", "spinach"])], "protein is 13.30, below the minimum 30"),
        ([dish("Cheese Enchilada Stack", 2, ["cheese"])], "kcal is 1127.80, above the maximum 1000"),
    ],
)
def test_refuses_a_meal_breaking_the_restrictions_servings_or_constraints(dishes: list[dict], problem: str) -> None:
    output = suggestion([one for one in dishes if one["recipe"] != "pizza"]) | {"dishes": dishes}
    verdict = suggest(output)
    assert verdict["valid"] is False and verdict["score"] == 0.0
    assert problem in verdict["details"]["problems"]


def test_refuses_totals_that_are_not_the_dishes() -> None:
    output = suggestion(OPTIMUM)
    output["totals"]["kcal"] += 10
    verdict = suggest(output)
    assert verdict["valid"] is False and verdict["details"]["problems"] == ["the totals are not its dishes'"]


def test_refuses_a_meal_beating_the_pinned_optimum() -> None:
    verdict = suggest(suggestion(OPTIMUM), reference=solved() | {"score": 2.0})
    assert verdict["valid"] is False and "the reference is wrong" in verdict["message"]


def test_checks_the_recommendation() -> None:
    recommended = solved()
    verdict = verifier.verify_task(
        "recommend-meal", build_output(DINNER, SolveInput), build_output(recommended, SolveOutput), None, WORKSPACE
    )
    assert verdict["valid"] is True and verdict["score"] == 1.0
    assert TASKS[Task.RECOMMEND_MEAL] == TOOLS[Tool.SOLVE_MEAL]


def test_checks_the_solver_output_and_input() -> None:
    reference = solved()
    assert verify_output("solve_meal", DINNER, reference)["valid"] is True
    assert verify_output("solve_meal", DINNER, reference | {"score": 4.0})["valid"] is False
    infeasible = suggestion([dish("Chickpeas With Spinach (Greek)", 1, ["beans", "spinach"])]) | {
        "score": 0.0,
        "lowest_score": 0.0,
    }
    assert (
        verify_output("solve_meal", DINNER, infeasible)["message"] == "the meal breaks a constraint or the restrictions"
    )
    assert verify_output("solve_meal", DINNER, reference | {"lowest_score": 3.5})["valid"] is False
    assert verify_input("solve_meal", DINNER | {"constraints": {"kcal": {"min": 900, "max": 800}}})["valid"] is False
    assert verify_input("solve_meal", DINNER | {"constraints": {"kcal": {"min": None, "max": None}}})["valid"] is False
    assert verify_input("solve_meal", DINNER | {"max_servings": 11})["valid"] is False
    likes = [{"name": "x", "words": [], "ignore": [], "weight": 1}]
    assert verify_input("solve_meal", DINNER | {"likes": likes})["valid"] is False


def test_checks_the_agent_tools_outputs() -> None:
    calls = [
        (
            "list_recipes",
            {"meal": "dinner", "restrictions": DINNER["restrictions"], "likes": DINNER["likes"]},
            list_recipes,
        ),
        ("get_nutrition", {"recipe": "Chickpea Curry (Garbanzos)"}, get_nutrition),
    ]
    outputs = {}
    for tool, value, function in calls:
        assert verify_input(tool, value)["valid"] is True
        outputs[tool] = plain_output(function(build_output(value, TOOLS[Tool(tool)][0])))
        assert verify_output(tool, value, outputs[tool])["valid"] is True
    listed = outputs["list_recipes"]
    first = listed["recipes"][0]
    for tampered in ({"url": "https://example.com"}, {"score": first["score"] + 1}):
        changed = {"recipes": [first | tampered, *listed["recipes"][1:]]}
        assert verify_output("list_recipes", calls[0][1], changed)["valid"] is False
    assert verify_output("list_recipes", calls[0][1], {"recipes": listed["recipes"][:-1]})["valid"] is False
    soup = outputs["get_nutrition"]
    soup["per_serving"]["protein"] += 1
    assert verify_output("get_nutrition", calls[1][1], soup)["valid"] is False
