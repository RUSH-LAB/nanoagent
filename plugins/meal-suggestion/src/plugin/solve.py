"""The meal-suggestion reference: the best meal of whole servings, by mixed-integer linear programming."""

from __future__ import annotations

from pathlib import Path

from scipy.optimize import Bounds, LinearConstraint, milp

from plugin.meals import NUTRIENTS, load_ingredients, load_recipes, matches, per_serving, rounded

# scipy.optimize.milp's status for a problem with no feasible point.
INFEASIBLE = 2


def solve(
    ingredients: str,
    recipes: str,
    meal: str,
    constraints: dict,
    preference: dict,
    objective: dict,
    max_servings: int,
    *,
    workspace: Path,
) -> dict:
    """The meal that optimizes the objective: whole servings, 0 to ``max_servings`` of each recipe
    for ``meal`` that meets the preference, at least one serving in all, every constraint met.
    HiGHS solves it to proven optimality (no relative gap)."""
    for nutrient, bound in constraints.items():
        if bound.get("min", 0) > bound.get("max", float("inf")):
            raise ValueError(f"the {nutrient} constraint's min is above its max")
    foods = load_ingredients(workspace, ingredients)
    found = load_recipes(workspace, recipes, foods)
    names = sorted(name for name, recipe in found.items() if matches(recipe, meal, preference))
    if not names:
        raise ValueError(f"no {meal} recipe meets the preference")
    nutrition = {name: per_serving(found[name], foods) for name in names}

    rows = [[nutrition[name][nutrient] for name in names] for nutrient in constraints]
    lower = [bound.get("min", -float("inf")) for bound in constraints.values()]
    upper = [bound.get("max", float("inf")) for bound in constraints.values()]
    # A meal has at least one dish.
    rows.append([1.0] * len(names))
    lower.append(1.0)
    upper.append(float("inf"))
    sign = -1.0 if objective["sense"] == "maximize" else 1.0
    solution = milp(
        [sign * nutrition[name][objective["nutrient"]] for name in names],
        integrality=[1] * len(names),
        bounds=Bounds(0, max_servings),
        constraints=LinearConstraint(rows, lower, upper),
        options={"mip_rel_gap": 0},
    )
    if solution.status == INFEASIBLE:
        raise ValueError(f"no {meal} of whole servings meets every constraint and the preference")
    if not solution.success:
        raise RuntimeError(f"the solver failed: {solution.message}")

    plan = [
        {"recipe": name, "servings": round(servings)}
        for name, servings in zip(names, solution.x, strict=True)
        if round(servings)
    ]
    totals = {
        nutrient: sum(dish["servings"] * nutrition[dish["recipe"]][nutrient] for dish in plan) for nutrient in NUTRIENTS
    }
    return {
        "ok": True,
        "plan": plan,
        "objective": round(totals[objective["nutrient"]], 6),
        "totals": rounded(totals),
        "recipes": {name: rounded(nutrition[name]) for name in names},
    }
