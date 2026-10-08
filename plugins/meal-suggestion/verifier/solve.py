"""solve (the suggest-meal reference) and the suggest-meal task's outcome check."""

from pathlib import Path

from .checks import result
from .meals import (
    MAX_SERVINGS,
    ROUNDING,
    SUGGESTION,
    as_dishes,
    bounds_problem,
    constraint_problems,
    dish_problems,
    eligible,
    likes_problem,
    load,
    load_recipes,
    meal_score,
    nutrition_problem,
    path_problem,
    per_serving,
    rounded,
    score,
    share,
    totals,
)


def verify_input(value):
    problem = path_problem(value.recipes, "recipes") or likes_problem(value.likes) or bounds_problem(value.constraints)
    if problem:
        return result(False, problem)
    if not 1 <= value.max_servings <= MAX_SERVINGS:
        return result(False, f"max_servings must be a whole number from 1 to {MAX_SERVINGS}")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    """The pinned plan is a feasible meal, its score is its dishes' and no more than the pinned worst
    is below it, and each recipe's nutrition and score are the file's (that the plan is the best and
    the worst the least rests on the solver)."""
    recipes = load_recipes(workspace, input_value.recipes)
    names = eligible(recipes, input_value.meal, input_value.restrictions)
    if sorted(output_value.recipes) != names or sorted(output_value.scores) != names:
        return result(False, "the pinned recipes are not exactly the meal's recipes that meet the restrictions")
    for name in names:
        if nutrition_problem(output_value.recipes[name], per_serving(recipes[name])):
            return result(False, f"the pinned nutrition of {name} differs from the recipes file")
        if abs(output_value.scores[name] - score(recipes[name], input_value.likes)) > ROUNDING:
            return result(False, f"the pinned score of {name} is not the sum of its likes' weights")
    plan = as_dishes(output_value.plan)
    problems = dish_problems(plan, recipes, input_value.meal, input_value.restrictions, input_value.max_servings)
    if problems:
        return result(False, "the plan is not a meal of the allowed recipes", problems=problems)
    problems = constraint_problems(totals(plan, recipes), input_value.constraints)
    if problems:
        return result(False, "the plan breaks a constraint", problems=problems)
    if abs(output_value.score - meal_score(plan, recipes, input_value.likes)) > ROUNDING:
        return result(False, "the pinned score is not the plan's")
    if output_value.worst > output_value.score + ROUNDING:
        return result(False, "the pinned worst score is above the best")
    return result(True, "the plan is a feasible meal", plan=plan)


def verify_task(arguments, reference, workspace):
    """Valid when meal.json is a meal of whole servings of the allowed recipes whose totals, recomputed
    from the recipes file, meet every constraint. The score is where its preference score falls
    between the pinned worst and best (see meals.share); a feasible meal that is not the best is valid with
    a score below 1."""
    path = Path(workspace) / SUGGESTION
    optimum = {"plan": as_dishes(reference.plan), "score": reference.score, "worst": reference.worst}
    if not path.is_file():
        return result(False, f"no suggestion at {SUGGESTION}", score=0.0, optimum=optimum)
    dishes = load(workspace, SUGGESTION).get("dishes")
    recipes = load_recipes(workspace, arguments.recipes)
    problems = dish_problems(dishes, recipes, arguments.meal, arguments.restrictions, arguments.max_servings)
    if problems:
        return result(
            False, "the dishes break the restrictions or the servings", score=0.0, problems=problems, dishes=dishes
        )
    meal_totals = totals(dishes, recipes)
    problems = constraint_problems(meal_totals, arguments.constraints)
    if problems:
        return result(
            False,
            "the meal breaks a constraint",
            score=0.0,
            problems=problems,
            dishes=dishes,
            totals=rounded(meal_totals),
        )

    value = meal_score(dishes, recipes, arguments.likes)
    if value > reference.score + ROUNDING or value < reference.worst - ROUNDING:
        return result(
            False, "the meal's preference score is outside the pinned range: the reference is wrong", score=0.0
        )
    return result(
        True,
        f"the meal meets every constraint and the restrictions; preference score {value:g} against the best "
        f"{reference.score:g} (worst {reference.worst:g})",
        score=round(share(value, reference.score, reference.worst), 6),
        dishes=dishes,
        totals=rounded(meal_totals),
        preference=value,
        optimum=optimum,
    )
