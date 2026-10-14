from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import DINNER
from slimconfig import build_output

import plugin.meals
from contract import Like, Meal, NutritionInput, RecipesInput, Restrictions
from plugin.meals import get_nutrition, liked, list_recipes, load_recipes

MEATLESS = Restrictions(require=[], exclude=["Meat", "Poultry"])
CHEESE = Like(name="cheese", words=["cheese"], ignore=[], weight=2)


def recipes_of(restrictions: Restrictions = MEATLESS) -> RecipesInput:
    return RecipesInput(meal=Meal.DINNER, restrictions=restrictions, likes=[CHEESE])


def test_lists_the_meals_recipes_that_meet_the_restrictions() -> None:
    listed = list_recipes(recipes_of(Restrictions(require=["Vegan"], exclude=[])))
    assert [recipe.name for recipe in listed.recipes] == [
        "Baja Black Beans, Corn and Rice",
        "Chickpea Curry (Garbanzos)",
    ]
    assert listed.recipes[1].per_serving.kcal == pytest.approx(437.6)
    assert listed.recipes[1].url.startswith("https://www.food.com/recipe/")
    assert [(recipe.liked, recipe.score) for recipe in listed.recipes] == [([], 0), ([], 0)]


def test_scores_a_recipe_by_the_likes_its_ingredients_and_tags_match() -> None:
    dinner = list_recipes(
        build_output({"meal": "dinner", **{key: DINNER[key] for key in ("restrictions", "likes")}}, RecipesInput)
    )
    assert {recipe.name: recipe.score for recipe in dinner.recipes} == {
        "Baja Black Beans, Corn and Rice": 1,
        "Black Bean and Couscous Salad": 1,
        "Cheese Enchilada Stack": 2,
        "Chickpea Curry (Garbanzos)": 1,
        "Chickpeas With Spinach (Greek)": 0,
    }
    recipes = load_recipes()
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


def test_gives_one_servings_nutrition_as_food_com_gives_it() -> None:
    curry = get_nutrition(NutritionInput(recipe="Chickpea Curry (Garbanzos)"))
    assert (curry.per_serving.kcal, curry.per_serving.protein, curry.per_serving.sodium) == (437.6, 13.0, 1267.0)
    assert curry.ingredients[:3] == ["chickpeas", "onion", "fresh ginger"]
    with pytest.raises(ValueError, match="no recipe named"):
        get_nutrition(NutritionInput(recipe="pizza"))


def test_loads_every_recipe() -> None:
    assert len(load_recipes()) == 14


def test_the_plugin_ships_food_coms_recipes() -> None:
    assert len(json.loads((Path(plugin.meals.__file__).with_name("recipes.json")).read_text())["recipes"]) == 444


def test_refuses_malformed_recipes(recipes: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def using(cookbook: dict) -> None:
        path = tmp_path / "recipes.json"
        path.write_text(json.dumps(cookbook))
        monkeypatch.setattr(plugin.meals, "COOKBOOK", path)
        list_recipes(recipes_of())

    cookbook = json.loads(recipes.read_text())
    curry = cookbook["recipes"]["Chickpea Curry (Garbanzos)"]
    with pytest.raises(ValueError, match="missing field"):
        using({"recipes": {}})
    curry["per_serving"]["sodium"] = -1
    with pytest.raises(ValueError, match="negative nutrient"):
        using(cookbook)
    curry["per_serving"]["sodium"], curry["servings"] = 1267.0, 0
    with pytest.raises(ValueError, match="at least one serving"):
        using(cookbook)
