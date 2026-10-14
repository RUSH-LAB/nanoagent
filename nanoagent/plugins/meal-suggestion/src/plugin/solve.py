"""The meal-suggestion references, by mixed-integer linear programming: the meal, or the day of meals,
the eater likes best."""

from __future__ import annotations

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp

from contract import (
    Bound,
    CookbookRecipe,
    DayInput,
    DayOutput,
    Dish,
    Meal,
    Nutrient,
    SolveInput,
    SolveOutput,
    SuggestionOutput,
)
from plugin.meals import NUTRIENTS, check_likes, liked, load_recipes, matches, per_serving, rounded, score

# scipy.optimize.milp's status for a problem with no feasible point.
INFEASIBLE = 2


def _check_bounds(constraints: dict[Nutrient, Bound]) -> None:
    for nutrient, bound in constraints.items():
        if bound.min is not None and bound.max is not None and bound.min > bound.max:
            raise ValueError(f"the {nutrient.value} constraint's min is above its max")


def _rows(constraints: dict[Nutrient, Bound], columns: np.ndarray) -> tuple[list, list, list]:
    """The constraints as rows over ``columns`` (one nutrient's per-serving values per row)."""
    rows = [columns[nutrient] for nutrient in constraints]
    lower = [-np.inf if bound.min is None else bound.min for bound in constraints.values()]
    upper = [np.inf if bound.max is None else bound.max for bound in constraints.values()]
    return rows, lower, upper


def optimize(
    meals: dict[Meal, tuple[list[str], dict[Nutrient, Bound]]],
    day: dict[Nutrient, Bound],
    nutrition: dict[str, dict[str, float]],
    scores: dict[str, float],
    max_servings: int,
    what: str,
) -> tuple[dict[Meal, dict[str, int]], float]:
    """The meals the eater likes best, and the least preference score meals meeting every constraint
    can have. ``meals`` gives each meal its eligible recipes and the bounds on its own totals; ``day``
    bounds all the meals' totals summed. Each meal has whole servings, 0 to ``max_servings`` of each
    of its recipes and at least one in all; a dish counts its recipe's score once, however many
    servings it has. HiGHS solves both to proven optimality (no relative gap)."""
    # Variables: each (meal, recipe)'s servings x, then whether it is a dish, y (0 or 1).
    cells = [(meal, name) for meal, (names, _) in meals.items() for name in names]
    count = len(cells)
    zeros = np.zeros(count)
    eye = np.eye(count)

    def columns(within: Meal | None) -> dict[Nutrient, np.ndarray]:
        """Each nutrient's per-serving value of each x (0 outside the meal ``within``), then 0 for each y."""
        return {
            nutrient: np.concatenate(
                [[nutrition[name][nutrient.value] if within in (None, meal) else 0 for meal, name in cells], zeros]
            )
            for nutrient in Nutrient
        }

    rows, lower, upper = _rows(day, columns(None))
    for meal, (_, constraints) in meals.items():
        meal_rows, meal_lower, meal_upper = _rows(constraints, columns(meal))
        # A meal has at least one serving.
        rows += [*meal_rows, np.concatenate([[float(cell[0] == meal) for cell in cells], zeros])]
        lower += [*meal_lower, 1.0]
        upper += [*meal_upper, np.inf]
    # y = 1 exactly when x > 0: x <= max_servings * y and x >= y.
    linked = LinearConstraint(
        np.vstack([np.hstack([eye, -max_servings * eye]), np.hstack([eye, -eye])]),
        np.concatenate([np.full(count, -np.inf), zeros]),
        np.concatenate([zeros, np.full(count, np.inf)]),
    )
    weights = np.concatenate([zeros, [scores[name] for _, name in cells]])

    def solved(sign: float):
        solution = milp(
            sign * weights,
            integrality=np.ones(2 * count),
            bounds=Bounds(0, np.concatenate([np.full(count, max_servings), np.ones(count)])),
            constraints=[LinearConstraint(np.array(rows), lower, upper), linked],
            options={"mip_rel_gap": 0},
        )
        if solution.status == INFEASIBLE:
            raise ValueError(f"no {what} of whole servings meets every constraint and the restrictions")
        if not solution.success:
            raise RuntimeError(f"the solver failed: {solution.message}")
        return solution

    best, worst = solved(-1.0), solved(1.0)
    plan: dict[Meal, dict[str, int]] = {meal: {} for meal in meals}
    for (meal, name), servings in zip(cells, best.x[:count], strict=True):
        if round(servings):
            plan[meal][name] = round(servings)
    return plan, round(worst.fun, 6)


def _eligible(given: SolveInput | DayInput, meals: list[Meal]):
    check_likes(given.likes)
    found = load_recipes()
    eligible = {}
    for meal in meals:
        eligible[meal] = sorted(name for name, recipe in found.items() if matches(recipe, meal, given.restrictions))
        if not eligible[meal]:
            raise ValueError(f"no {meal.value} recipe meets the restrictions")
    names = sorted({name for names in eligible.values() for name in names})
    nutrition = {name: per_serving(found[name]) for name in names}
    scores = {name: score(found[name], given.likes) for name in names}
    return found, eligible, nutrition, scores


def _totals(dishes: list[Dish], nutrition: dict[str, dict[str, float]]) -> dict[str, float]:
    return {
        nutrient: sum(dish.servings * nutrition[dish.recipe][nutrient] for dish in dishes) for nutrient in NUTRIENTS
    }


def _dishes(servings: dict[str, int], found: dict[str, CookbookRecipe], given: SolveInput | DayInput) -> list[Dish]:
    return [
        Dish(recipe=name, url=found[name].url, servings=count, liked=liked(found[name], given.likes))
        for name, count in servings.items()
    ]


def solve_meal(given: SolveInput) -> SolveOutput:
    """The meal with the highest preference score (see optimize), and the lowest score a meal meeting
    every constraint can have, so a meal's score can be put on that range."""
    _check_bounds(given.constraints)
    found, eligible, nutrition, scores = _eligible(given, [given.meal])
    meals = {given.meal: (eligible[given.meal], given.constraints)}
    plan, worst = optimize(meals, {}, nutrition, scores, given.max_servings, given.meal.value)
    dishes = _dishes(plan[given.meal], found, given)
    return SolveOutput(
        dishes=dishes,
        totals=rounded(_totals(dishes, nutrition)),
        score=round(sum(scores[dish.recipe] for dish in dishes), 6),
        lowest_score=worst,
    )


def solve_day(given: DayInput) -> DayOutput:
    """The day of meals with the highest preference score (see optimize): each meal within its own
    bounds and the day within the day's; and the lowest score such a day can have."""
    if not given.meals:
        raise ValueError("a day has one or more meals")
    _check_bounds(given.day)
    for constraints in given.meals.values():
        _check_bounds(constraints)
    found, eligible, nutrition, scores = _eligible(given, list(given.meals))
    meals = {meal: (eligible[meal], constraints) for meal, constraints in given.meals.items()}
    plan, worst = optimize(meals, given.day, nutrition, scores, given.max_servings, "day")
    dishes = {meal: _dishes(servings, found, given) for meal, servings in plan.items()}
    every = [dish for meal in dishes.values() for dish in meal]
    return DayOutput(
        meals={
            meal: SuggestionOutput(dishes=meal_dishes, totals=rounded(_totals(meal_dishes, nutrition)))
            for meal, meal_dishes in dishes.items()
        },
        totals=rounded(_totals(every, nutrition)),
        score=round(sum(scores[dish.recipe] for dish in every), 6),
        lowest_score=worst,
    )
