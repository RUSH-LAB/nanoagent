from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import RECIPES

from contract import Dish, Like, Meal, NutritionInput, RecipesInput, Restrictions, SubmitInput
from plugin.meals import liked, list_recipes, load_recipes, nutrition, submit_meal

MEATLESS = Restrictions(require=[], exclude=["Meat", "Poultry"])
CHEESE = Like(name="cheese", words=["cheese"], ignore=[], weight=2)


def recipes_of(path: str, restrictions: Restrictions = MEATLESS) -> RecipesInput:
    return RecipesInput(recipes=path, meal=Meal.DINNER, restrictions=restrictions, likes=[CHEESE])


def nutrition_of(recipe: str, recipes: str = RECIPES) -> NutritionInput:
    return NutritionInput(recipes=recipes, recipe=recipe)


def write(workspace: Path, name: str, cookbook: dict) -> str:
    (workspace / "inputs" / name).write_text(json.dumps(cookbook))
    return f"inputs/{name}"


def test_lists_the_meals_recipes_that_meet_the_restrictions(workspace: Path) -> None:
    listed = list_recipes(recipes_of(RECIPES, Restrictions(require=["Vegan"], exclude=[])), workspace)
    assert [recipe.name for recipe in listed.recipes] == [
        "Baja Black Beans, Corn and Rice",
        "Chickpea Curry (Garbanzos)",
    ]
    assert listed.recipes[1].per_serving.kcal == pytest.approx(437.6)
    assert [(recipe.liked, recipe.score) for recipe in listed.recipes] == [([], 0), ([], 0)]


def test_scores_a_recipe_by_the_likes_its_ingredients_and_tags_match(workspace: Path) -> None:
    listed = {recipe.name: recipe for recipe in list_recipes(recipes_of(RECIPES), workspace).recipes}
    assert (listed["Cheese Enchilada Stack"].liked, listed["Cheese Enchilada Stack"].score) == (["cheese"], 2)
    recipes = load_recipes(workspace, RECIPES)
    # A word matches whole, in any case, and its plural; "egg" is not "eggplant".
    assert liked(
        recipes["Baja Black Beans, Corn and Rice"], [Like(name="beans", words=["BEAN"], ignore=[], weight=1)]
    ) == ["beans"]
    assert liked(
        recipes["Black Bean and Couscous Salad"], [Like(name="vegetables", words=["vegetable"], ignore=[], weight=1)]
    ) == ["vegetables"]
    assert liked(recipes["Egg Casserole for Two"], [Like(name="egg", words=["eggplant"], ignore=[], weight=1)]) == []
    assert liked(recipes["Egg Casserole for Two"], [Like(name="egg", words=["egg"], ignore=[], weight=1)]) == ["egg"]
    # An ignored phrase does not count: the casserole's cheese is cheddar cheese.
    cheese = Like(name="cheese", words=["cheese"], ignore=["cheddar cheese"], weight=1)
    assert liked(recipes["Egg Casserole for Two"], [cheese]) == ["cheese"]  # its Cheese tag still counts
    salad = recipes["Black Bean and Couscous Salad"]  # made with chicken broth
    assert liked(salad, [Like(name="chicken", words=["chicken"], ignore=[], weight=1)]) == ["chicken"]
    assert liked(salad, [Like(name="chicken", words=["chicken"], ignore=["chicken broth"], weight=1)]) == []


def test_gives_one_servings_nutrition_as_food_com_gives_it(workspace: Path) -> None:
    curry = nutrition(nutrition_of("Chickpea Curry (Garbanzos)"), workspace)
    assert (curry.per_serving.kcal, curry.per_serving.protein, curry.per_serving.sodium) == (437.6, 13.0, 1267.0)
    assert curry.ingredients[:3] == ["chickpeas", "onion", "fresh ginger"]
    with pytest.raises(ValueError, match="no recipe named"):
        nutrition(nutrition_of("pizza"), workspace)


def test_loads_every_recipe(workspace: Path) -> None:
    assert len(load_recipes(workspace, RECIPES)) == 14


def test_refuses_input_files_outside_the_workspace_or_malformed(workspace: Path) -> None:
    with pytest.raises(ValueError, match="inside the plugin workspace"):
        list_recipes(recipes_of("../recipes.json"), workspace)
    with pytest.raises(FileNotFoundError):
        list_recipes(recipes_of("inputs/missing.json"), workspace)
    cookbook = json.loads((workspace / RECIPES).read_text())
    curry = cookbook["recipes"]["Chickpea Curry (Garbanzos)"]
    with pytest.raises(ValueError, match="missing field"):
        list_recipes(recipes_of(write(workspace, "bad.json", {"recipes": {}})), workspace)
    curry["per_serving"]["sodium"] = -1
    with pytest.raises(ValueError, match="negative nutrient"):
        list_recipes(recipes_of(write(workspace, "negative.json", cookbook)), workspace)
    curry["per_serving"]["sodium"], curry["servings"] = 1267.0, 0
    with pytest.raises(ValueError, match="at least one serving"):
        list_recipes(recipes_of(write(workspace, "servings.json", cookbook)), workspace)


def test_submits_the_meal_replacing_an_earlier_one(workspace: Path) -> None:
    submit_meal(SubmitInput(dishes=[Dish(recipe="Chickpea Curry (Garbanzos)", servings=2)]), workspace)
    dishes = [
        Dish(recipe="Cheese Enchilada Stack", servings=1),
        Dish(recipe="Chickpeas With Spinach (Greek)", servings=1),
    ]
    assert submit_meal(SubmitInput(dishes=dishes), workspace).dishes == 2
    assert json.loads((workspace / "meal.json").read_text()) == {
        "dishes": [
            {"recipe": "Cheese Enchilada Stack", "servings": 1},
            {"recipe": "Chickpeas With Spinach (Greek)", "servings": 1},
        ]
    }
    with pytest.raises(ValueError, match="each once"):
        submit_meal(SubmitInput(dishes=[dishes[0], dishes[0]]), workspace)
