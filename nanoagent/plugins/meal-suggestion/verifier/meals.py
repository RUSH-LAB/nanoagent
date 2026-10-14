"""The plugin's recipes and each recipe's nutrition, read as `src/plugin/meals.py` reads them."""

import json
import re
from dataclasses import asdict
from pathlib import Path

from contract import Nutrient

NUTRIENTS = tuple(nutrient.value for nutrient in Nutrient)
# The recipes the plugin's tools read, in its src/.
COOKBOOK = Path(__file__).resolve().parent.parent / "src" / "plugin" / "recipes.json"
MAX_SERVINGS = 10
# Slack for float sums and for the 3-decimal rounding of tool outputs.
EPSILON = 1e-6
ROUNDING = 1e-3


def load_recipes():
    """The recipes of the plugin's Cookbook, as JSON."""
    return json.loads(COOKBOOK.read_text(encoding="utf-8"))["recipes"]


def per_serving(recipe):
    return {nutrient: recipe["per_serving"][nutrient] for nutrient in NUTRIENTS}


def matches(recipe, meal, restrictions):
    tags = set(recipe["tags"])
    return meal.value in recipe["meals"] and set(restrictions.require) <= tags and not tags & set(restrictions.exclude)


def eligible(recipes, meal, restrictions):
    """The names of the recipes for ``meal`` (a contract Meal) that meet the restrictions, sorted."""
    return sorted(name for name, recipe in recipes.items() if matches(recipe, meal, restrictions))


def liked(recipe, likes):
    """The names of the contract Likes the recipe matches, as `src/plugin/meals.py` matches them."""
    texts = [text.lower() for text in (*recipe["ingredients"], *recipe["tags"])]
    return [like.name for like in likes if any(_mentions(text, like) for text in texts)]


def _mentions(text, like):
    """Whether ``text`` (lowercase) has one of the like's words, once its ignored phrases are taken out."""
    for phrase in like.ignore:
        text = re.sub(rf"\b{re.escape(phrase.strip().lower())}\b", " ", text)
    return any(re.search(rf"\b{re.escape(word.strip().lower())}(?:s|es)?\b", text) for word in like.words)


def score(recipe, likes):
    matched = set(liked(recipe, likes))
    return sum(like.weight for like in likes if like.name in matched)


def meal_score(dishes, recipes, likes):
    """A meal's preference score: each dish counts its recipe's score once."""
    return sum(score(recipes[dish.recipe], likes) for dish in dishes)


def likes_problem(likes):
    names = [like.name for like in likes]
    if len(set(names)) != len(names) or not all(name.strip() for name in names):
        return "each like must have a name, each name once"
    for like in likes:
        if not like.words or not all(word.strip() for word in like.words):
            return f"like {like.name!r} must give one or more words"
    return None


def dish_problems(dishes, recipes, meal, given):
    """What is wrong with the dishes (contract Dishes) of ``meal`` for the task's input ``given``
    (its restrictions, likes and max_servings), beyond their totals."""
    if not dishes:
        return ["the meal has no dishes"]
    allowed = eligible(recipes, meal, given.restrictions)
    problems = []
    seen = set()
    for dish in dishes:
        name = dish.recipe
        if name not in recipes:
            problems.append(f"{name!r} is not a recipe")
        elif name in seen:
            problems.append(f"{name} is listed twice")
        elif name not in allowed:
            problems.append(f"{name} is not a {meal.value} recipe that meets the restrictions")
        else:
            if dish.url != recipes[name]["url"]:
                problems.append(f"{name}: its url is not the recipe's")
            if dish.liked != liked(recipes[name], given.likes):
                problems.append(f"{name}: its likes are not the ones its ingredients and tags match")
        if not 1 <= dish.servings <= given.max_servings:
            problems.append(f"{name}: servings must be a whole number from 1 to {given.max_servings}")
        seen.add(name)
    return problems


def totals(dishes, recipes):
    """The meal's total of each nutrient: servings x per serving, summed over the dishes."""
    return {
        nutrient: sum(dish.servings * recipes[dish.recipe]["per_serving"][nutrient] for dish in dishes)
        for nutrient in NUTRIENTS
    }


def constraint_problems(meal_totals, constraints):
    """``constraints``: the contract's Nutrient -> Bound."""
    problems = []
    for nutrient, bound in constraints.items():
        total = meal_totals[nutrient.value]
        if bound.min is not None and total < bound.min - EPSILON:
            problems.append(f"{nutrient.value} is {total:.2f}, below the minimum {bound.min:g}")
        if bound.max is not None and total > bound.max + EPSILON:
            problems.append(f"{nutrient.value} is {total:.2f}, above the maximum {bound.max:g}")
    return problems


def nutrition_problem(given, expected):
    """Whether a contract Nutrition differs from the recomputed one beyond rounding."""
    values = asdict(given)
    return any(abs(values[nutrient] - expected[nutrient]) > ROUNDING for nutrient in NUTRIENTS)


def bounds_problem(constraints):
    """What is wrong with ``constraints`` (the contract's Nutrient -> Bound), or None."""
    for nutrient, bound in constraints.items():
        if bound.min is None and bound.max is None:
            return f"the {nutrient.value} constraint must give a min, a max or both"
        if any(limit is not None and limit < 0 for limit in (bound.min, bound.max)):
            return f"the {nutrient.value} constraint's bounds must not be negative"
        if bound.min is not None and bound.max is not None and bound.min > bound.max:
            return f"the {nutrient.value} constraint's min is above its max"
    return None


def share(value, best, worst):
    """Where a preference score falls between the worst and the best that meeting every constraint
    allows: 1.0 at the best, 0.0 at the worst, and 1.0 when every such choice scores alike."""
    if best - worst <= ROUNDING:
        return 1.0
    return (value - worst) / (best - worst)
