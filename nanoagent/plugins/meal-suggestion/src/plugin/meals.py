"""The plugin's recipes, a contract Cookbook, and the agent's tools."""

from __future__ import annotations

import json
import re
from dataclasses import asdict
from pathlib import Path

from slimconfig import build_output

from contract import (
    Cookbook,
    CookbookRecipe,
    Like,
    Meal,
    Nutrient,
    Nutrition,
    NutritionInput,
    NutritionOutput,
    Recipe,
    RecipesInput,
    RecipesOutput,
    Restrictions,
)

NUTRIENTS = tuple(nutrient.value for nutrient in Nutrient)
# The Food.com recipes examples/meal_suggestion's step 1 builds, copied here; the verifier reads the same file.
COOKBOOK = Path(__file__).with_name("recipes.json")


def load_recipes() -> dict[str, CookbookRecipe]:
    """The recipes of the plugin's Cookbook."""
    recipes = build_output(json.loads(COOKBOOK.read_text(encoding="utf-8")), Cookbook).recipes
    if not recipes:
        raise ValueError(f"{COOKBOOK.name} holds no recipes")
    for name, recipe in recipes.items():
        if not recipe.meals:
            raise ValueError(f"recipe {name!r} must be for one or more meals")
        if recipe.servings < 1:
            raise ValueError(f"recipe {name!r} must make at least one serving")
        if any(value < 0 for value in asdict(recipe.per_serving).values()):
            raise ValueError(f"recipe {name!r} has a negative nutrient per serving")
    return recipes


def per_serving(recipe: CookbookRecipe) -> dict[str, float]:
    """One serving's kcal, mg of cholesterol and sodium, and grams of each other nutrient."""
    return asdict(recipe.per_serving)


def matches(recipe: CookbookRecipe, meal: Meal, restrictions: Restrictions) -> bool:
    """Whether the recipe is for ``meal`` and has every required tag and no excluded one."""
    tags = set(recipe.tags)
    return meal in recipe.meals and set(restrictions.require) <= tags and not tags & set(restrictions.exclude)


def liked(recipe: CookbookRecipe, likes: list[Like]) -> list[str]:
    """The likes the recipe matches: those with a word (or its plural, -s or -es) that is a word of
    one of its ingredients or tags, case aside, outside the like's ignored phrases."""
    texts = [text.lower() for text in (*recipe.ingredients, *recipe.tags)]
    return [like.name for like in likes if any(_mentions(text, like) for text in texts)]


def _mentions(text: str, like: Like) -> bool:
    """Whether ``text`` (lowercase) has one of the like's words, once its ignored phrases are taken out."""
    for phrase in like.ignore:
        text = re.sub(rf"\b{re.escape(phrase.strip().lower())}\b", " ", text)
    return any(re.search(rf"\b{re.escape(word.strip().lower())}(?:s|es)?\b", text) for word in like.words)


def score(recipe: CookbookRecipe, likes: list[Like]) -> float:
    """The recipe's preference score: the sum of the weights of the likes it matches."""
    matched = set(liked(recipe, likes))
    return sum(like.weight for like in likes if like.name in matched)


def check_likes(likes: list[Like]) -> None:
    names = [like.name for like in likes]
    if len(set(names)) != len(names) or not all(name.strip() for name in names):
        raise ValueError("each like must have a name, each name once")
    for like in likes:
        if not like.words or not all(word.strip() for word in like.words):
            raise ValueError(f"like {like.name!r} must give one or more words")


def rounded(values: dict[str, float]) -> Nutrition:
    return Nutrition(**{key: round(value, 3) for key, value in values.items()})


def list_recipes(given: RecipesInput) -> RecipesOutput:
    """The recipes for the meal that meet the restrictions, by name, each with its nutrition per
    serving and its preference score."""
    check_likes(given.likes)
    return RecipesOutput(
        recipes=[
            Recipe(
                name=name,
                url=recipe.url,
                tags=recipe.tags,
                per_serving=recipe.per_serving,
                liked=liked(recipe, given.likes),
                score=score(recipe, given.likes),
            )
            for name, recipe in sorted(load_recipes().items())
            if matches(recipe, given.meal, given.restrictions)
        ]
    )


def nutrition(given: NutritionInput) -> NutritionOutput:
    """One serving of the recipe: its ingredients and its nutrition."""
    found = load_recipes()
    if given.recipe not in found:
        raise ValueError(f"no recipe named {given.recipe!r}")
    recipe = found[given.recipe]
    return NutritionOutput(recipe=given.recipe, ingredients=recipe.ingredients, per_serving=recipe.per_serving)
