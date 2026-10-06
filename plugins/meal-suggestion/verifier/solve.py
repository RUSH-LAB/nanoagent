"""solve (the suggest-meal reference) and the suggest-meal task's outcome check."""

from pathlib import Path

from .checks import result
from .meals import (
    MEALS,
    NUTRIENTS,
    ROUNDING,
    SUGGESTION,
    constraint_problems,
    dish_problems,
    eligible,
    load,
    path_problem,
    per_serving,
    preference_problem,
    rounded,
    totals,
)


def verify_input(value):
    for name in ("ingredients", "recipes"):
        problem = path_problem(value.get(name), name)
        if problem:
            return result(False, problem)
    if value.get("meal") not in MEALS:
        return result(False, f"meal must be one of {', '.join(MEALS)}")
    constraints = value.get("constraints")
    if not isinstance(constraints, dict) or not set(constraints) <= set(NUTRIENTS):
        return result(False, f"constraints must bound only {', '.join(NUTRIENTS)}")
    for nutrient, bound in constraints.items():
        if not isinstance(bound, dict) or not bound or not set(bound) <= {"min", "max"}:
            return result(False, f"the {nutrient} constraint must give a min, a max or both")
        if bound.get("min", 0) > bound.get("max", float("inf")):
            return result(False, f"the {nutrient} constraint's min is above its max")
    problem = preference_problem(value.get("preference"))
    if problem:
        return result(False, problem)
    objective = value.get("objective")
    if not isinstance(objective, dict) or objective.get("sense") not in ("maximize", "minimize"):
        return result(False, "objective sense must be maximize or minimize")
    if objective.get("nutrient") not in NUTRIENTS:
        return result(False, f"objective nutrient must be one of {', '.join(NUTRIENTS)}")
    servings = value.get("max_servings")
    if isinstance(servings, bool) or not isinstance(servings, int) or servings < 1:
        return result(False, "max_servings must be a positive whole number")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    """The pinned plan is a feasible meal, and its objective and each recipe's nutrition are the
    files' (that the plan is optimal rests on the solver)."""
    ingredients = load(workspace, input_value["ingredients"])
    recipes = load(workspace, input_value["recipes"])
    names = eligible(recipes, input_value["meal"], input_value["preference"])
    pinned = output_value.get("recipes", {})
    if sorted(pinned) != names:
        return result(False, "the pinned recipes are not exactly the meal's recipes that meet the preference")
    for name in names:
        expected = per_serving(recipes[name], ingredients)
        if any(abs(pinned[name][nutrient] - expected[nutrient]) > ROUNDING for nutrient in NUTRIENTS):
            return result(False, f"the pinned nutrition of {name} differs from the input files")
    plan = output_value.get("plan")
    problems = dish_problems(plan, recipes, input_value)
    if problems:
        return result(False, "the plan is not a meal of the allowed recipes", problems=problems)
    plan_totals = totals(plan, recipes, ingredients)
    problems = constraint_problems(plan_totals, input_value["constraints"])
    if problems:
        return result(False, "the plan breaks a constraint", problems=problems)
    if abs(output_value.get("objective", float("nan")) - plan_totals[input_value["objective"]["nutrient"]]) > ROUNDING:
        return result(False, "the pinned objective is not the plan's total")
    return result(True, "the plan is a feasible meal", plan=plan)


def _score(sense, value, optimum):
    """1.0 at the optimum. Maximize: value / optimum; minimize: optimum / value. Nutrients are never
    negative, so a feasible meal scores in (0, 1], and a value short of the optimum has a non-zero
    denominator."""
    if abs(value - optimum) <= ROUNDING:
        return 1.0
    return value / optimum if sense == "maximize" else optimum / value


def verify_task(arguments, reference, workspace):
    """Valid when meal.json is a meal of whole servings of the allowed recipes whose totals, recomputed
    from the input files, meet every constraint. The score is how close its objective comes to the
    pinned optimum (see _score); a feasible but suboptimal meal is valid with a score below 1."""
    path = Path(workspace) / SUGGESTION
    optimum = {"plan": reference["plan"], "objective": reference["objective"]}
    if not path.is_file():
        return result(False, f"no suggestion at {SUGGESTION}", score=0.0, optimum=optimum)
    dishes = load(workspace, SUGGESTION).get("dishes")
    ingredients = load(workspace, arguments["ingredients"])
    recipes = load(workspace, arguments["recipes"])
    problems = dish_problems(dishes, recipes, arguments)
    if problems:
        return result(False, "the dishes break the preference or the servings", score=0.0, problems=problems, dishes=dishes)
    meal_totals = totals(dishes, recipes, ingredients)
    problems = constraint_problems(meal_totals, arguments["constraints"])
    if problems:
        return result(
            False, "the meal breaks a constraint", score=0.0, problems=problems, dishes=dishes, totals=rounded(meal_totals)
        )

    sense, nutrient = arguments["objective"]["sense"], arguments["objective"]["nutrient"]
    value = meal_totals[nutrient]
    beaten = value > optimum["objective"] + ROUNDING if sense == "maximize" else value < optimum["objective"] - ROUNDING
    if beaten:
        return result(False, f"the meal beats the pinned optimum's {nutrient}: the reference is wrong", score=0.0)
    score = round(_score(sense, value, optimum["objective"]), 6)
    return result(
        True,
        f"the meal meets every constraint and the preference; {sense} {nutrient}: {value:.2f} "
        f"against the optimum {optimum['objective']:.2f}",
        score=score,
        dishes=dishes,
        totals=rounded(meal_totals),
        optimum=optimum,
    )
