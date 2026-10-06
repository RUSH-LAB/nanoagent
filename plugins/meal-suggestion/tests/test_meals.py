from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import INGREDIENTS, RECIPES

from plugin.meals import list_recipes, load_ingredients, load_recipes, nutrition, submit_meal

VEGETARIAN = {"require": ["vegetarian"], "exclude": []}


def test_lists_the_meals_recipes_that_meet_the_preference(workspace: Path) -> None:
    listed = list_recipes(RECIPES, "dinner", {"require": ["vegetarian"], "exclude": ["dairy"]}, workspace=workspace)
    assert [recipe["name"] for recipe in listed["recipes"]] == [
        "chickpea quinoa salad",
        "lentil soup",
        "tofu broccoli stir-fry",
    ]


def test_gives_one_servings_nutrition(workspace: Path) -> None:
    soup = nutrition(INGREDIENTS, RECIPES, "lentil soup", workspace=workspace)
    # 250 g lentils, 100 g tomato sauce, 50 g spinach, 5 g olive oil.
    assert soup["per_serving"] == {"kcal": 369.7, "protein": 25.15, "fat": 6.5, "carbs": 57.35, "fiber": 22.35}
    with pytest.raises(ValueError, match="no recipe named"):
        nutrition(INGREDIENTS, RECIPES, "pizza", workspace=workspace)


def test_every_recipe_uses_known_ingredients(workspace: Path) -> None:
    assert len(load_recipes(workspace, RECIPES, load_ingredients(workspace, INGREDIENTS))) == 12


def test_refuses_input_files_outside_the_workspace_or_malformed(workspace: Path) -> None:
    with pytest.raises(ValueError, match="inside the plugin workspace"):
        list_recipes("../recipes.json", "dinner", VEGETARIAN, workspace=workspace)
    with pytest.raises(FileNotFoundError):
        list_recipes("inputs/missing.json", "dinner", VEGETARIAN, workspace=workspace)
    (workspace / "inputs" / "bad.json").write_text(json.dumps({"soup": {"meals": ["dinner"], "tags": []}}))
    with pytest.raises(ValueError, match="exactly meals, tags and ingredients"):
        list_recipes("inputs/bad.json", "dinner", VEGETARIAN, workspace=workspace)
    recipes = json.loads((workspace / RECIPES).read_text())
    recipes["lentil soup"]["ingredients"]["saffron"] = 1
    (workspace / "inputs" / "unknown.json").write_text(json.dumps(recipes))
    with pytest.raises(ValueError, match="'saffron', which is not in the ingredients file"):
        nutrition(INGREDIENTS, "inputs/unknown.json", "lentil soup", workspace=workspace)


def test_submits_the_meal_replacing_an_earlier_one(workspace: Path) -> None:
    submit_meal([{"recipe": "lentil soup", "servings": 2}], workspace=workspace)
    dishes = [{"recipe": "lentil soup", "servings": 1}, {"recipe": "tofu broccoli stir-fry", "servings": 1}]
    assert submit_meal(dishes, workspace=workspace)["dishes"] == 2
    assert json.loads((workspace / "meal.json").read_text()) == {"dishes": dishes}
    with pytest.raises(ValueError, match="each once"):
        submit_meal([dishes[0], dishes[0]], workspace=workspace)
