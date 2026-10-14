from __future__ import annotations

from pathlib import Path

import pytest
from slimconfig import build_output, plain_output

import plugin.meals
import verifier.meals
from contract import SolveInput
from plugin.meals import load_recipes
from plugin.solve import solve_meal

FIXTURES = Path(__file__).parent / "fixtures"
LIKES = [
    {"name": "cheese", "words": ["cheese"], "ignore": [], "weight": 2},
    {"name": "beans", "words": ["bean", "chickpea"], "ignore": [], "weight": 1},
    {"name": "spinach", "words": ["spinach"], "ignore": [], "weight": -1},
]
# A solve_meal input as JSON, the way a task's arguments arrive.
DINNER = {
    "meal": "dinner",
    "constraints": {
        "protein": {"min": 30, "max": None},
        "kcal": {"min": None, "max": 1000},
        "fiber": {"min": 10, "max": None},
    },
    "restrictions": {"require": [], "exclude": ["Meat", "Poultry"]},
    "likes": LIKES,
    "max_servings": 2,
}


@pytest.fixture(autouse=True)
def recipes(monkeypatch: pytest.MonkeyPatch) -> Path:
    """The sample recipes, an excerpt of Food.com's, as the plugin's and the verifier's recipes."""
    path = FIXTURES / "recipes.json"
    monkeypatch.setattr(plugin.meals, "COOKBOOK", path)
    monkeypatch.setattr(verifier.meals, "COOKBOOK", path)
    return path


def solved(arguments: dict = DINNER) -> dict:
    """solve_meal's output for ``arguments``, as JSON."""
    return plain_output(solve_meal(build_output(arguments, SolveInput)))


def dish(recipe: str, servings: int = 1, liked: list[str] = ()) -> dict:
    url = load_recipes()[recipe].url
    return {"recipe": recipe, "url": url, "servings": servings, "liked": list(liked)}


def suggestion(dishes: list[dict]) -> dict:
    """A suggestion of ``dishes`` with their true totals."""
    recipes = load_recipes()
    totals = {
        nutrient: round(
            sum(d["servings"] * plugin.meals.per_serving(recipes[d["recipe"]])[nutrient] for d in dishes), 3
        )
        for nutrient in plugin.meals.NUTRIENTS
    }
    return {"dishes": dishes, "totals": totals}
