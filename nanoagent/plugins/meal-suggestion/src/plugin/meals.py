"""The recipes file, a contract Cookbook, and the agent's tools."""

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
    SubmitDayInput,
    SubmitDayOutput,
    SubmitInput,
    SubmitOutput,
)

NUTRIENTS = tuple(nutrient.value for nutrient in Nutrient)
# The files submit_meal and submit_day write and the tasks' verifiers read, relative to the workspace.
SUGGESTION = "meal.json"
DAY = "day.json"


def load_recipes(workspace: Path, path: str) -> dict[str, CookbookRecipe]:
    """The recipes of the Cookbook in ``path``, which must stay inside ``workspace``."""
    relative = Path(path)
    root = workspace.resolve()
    file = (root / relative).resolve()
    if relative.is_absolute() or ".." in relative.parts or not file.is_relative_to(root):
        raise ValueError(f"{path} must stay inside the plugin workspace")
    if not file.is_file():
        raise FileNotFoundError(f"no input file at {path}")
    recipes = build_output(json.loads(file.read_text(encoding="utf-8")), Cookbook).recipes
    if not recipes:
        raise ValueError(f"{path} holds no recipes")
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


def list_recipes(given: RecipesInput, workspace: Path) -> RecipesOutput:
    """The recipes for the meal that meet the restrictions, by name, each with its nutrition per
    serving and its preference score."""
    check_likes(given.likes)
    found = load_recipes(workspace, given.recipes)
    return RecipesOutput(
        recipes=[
            Recipe(
                name=name,
                tags=recipe.tags,
                per_serving=recipe.per_serving,
                liked=liked(recipe, given.likes),
                score=score(recipe, given.likes),
            )
            for name, recipe in sorted(found.items())
            if matches(recipe, given.meal, given.restrictions)
        ]
    )


def nutrition(given: NutritionInput, workspace: Path) -> NutritionOutput:
    """One serving of the recipe: its ingredients and its nutrition."""
    found = load_recipes(workspace, given.recipes)
    if given.recipe not in found:
        raise ValueError(f"no recipe named {given.recipe!r}")
    recipe = found[given.recipe]
    return NutritionOutput(recipe=given.recipe, ingredients=recipe.ingredients, per_serving=recipe.per_serving)


def submit_meal(given: SubmitInput, workspace: Path) -> SubmitOutput:
    """Write the suggestion, each dish's recipe and whole servings, to `meal.json`, replacing an
    earlier one."""
    names = [dish.recipe for dish in given.dishes]
    if not given.dishes or len(set(names)) != len(names):
        raise ValueError("dishes must name at least one recipe, each once")
    path = workspace.resolve() / SUGGESTION
    dishes = [{"recipe": dish.recipe, "servings": dish.servings} for dish in given.dishes]
    path.write_text(json.dumps({"dishes": dishes}, indent=2) + "\n", encoding="utf-8")
    return SubmitOutput(path=str(path), dishes=len(given.dishes))


def submit_day(given: SubmitDayInput, workspace: Path) -> SubmitDayOutput:
    """Write the day's plan, each meal's dishes, to `day.json`, replacing an earlier one."""
    if not given.meals:
        raise ValueError("a day has one or more meals")
    for meal, dishes in given.meals.items():
        names = [dish.recipe for dish in dishes]
        if not dishes or len(set(names)) != len(names):
            raise ValueError(f"{meal.value} must name at least one recipe, each once")
    path = workspace.resolve() / DAY
    meals = {
        meal.value: [{"recipe": dish.recipe, "servings": dish.servings} for dish in dishes]
        for meal, dishes in given.meals.items()
    }
    path.write_text(json.dumps({"meals": meals}, indent=2) + "\n", encoding="utf-8")
    return SubmitDayOutput(path=str(path), dishes=sum(len(dishes) for dishes in given.meals.values()))
