"""solve (the recommend-meal tool and the suggest-meal reference) and the meal tasks' outcome checks."""

from .checks import result
from .meals import (
    MAX_SERVINGS,
    ROUNDING,
    bounds_problem,
    constraint_problems,
    dish_problems,
    likes_problem,
    load_recipes,
    meal_score,
    nutrition_problem,
    share,
    totals,
)


def verify_input(value):
    problem = likes_problem(value.likes) or bounds_problem(value.constraints)
    if problem:
        return result(False, problem)
    if not 1 <= value.max_servings <= MAX_SERVINGS:
        return result(False, f"max_servings must be a whole number from 1 to {MAX_SERVINGS}")
    return result(True, "input is valid")


def totals_problems(dishes, given, recipes, constraints):
    """What is wrong with the totals of ``dishes`` within ``constraints``, recomputed from the recipes,
    and with ``given``, the totals a plan gives for them."""
    found = totals(dishes, recipes)
    problems = constraint_problems(found, constraints)
    if nutrition_problem(given, found):
        problems.append("the totals are not its dishes'")
    return problems


def meal_problems(plan, meal, recipes, constraints, given):
    """What is wrong with ``plan`` (a contract Suggestion or SolveOutput) as ``meal`` within
    ``constraints``, for the task's input ``given``: its dishes, then its totals."""
    return dish_problems(plan.dishes, recipes, meal, given) or totals_problems(
        plan.dishes, plan.totals, recipes, constraints
    )


def verify_output(input_value, output_value, workspace):
    """The recommended meal meets every constraint, its totals and score are its dishes', and the lowest
    score is no more than its (that it is the best and the lowest the least rests on the solver)."""
    recipes = load_recipes()
    problems = meal_problems(output_value, input_value.meal, recipes, input_value.constraints, input_value)
    if problems:
        return result(False, "the meal breaks a constraint or the restrictions", problems=problems)
    if abs(output_value.score - meal_score(output_value.dishes, recipes, input_value.likes)) > ROUNDING:
        return result(False, "the score is not the meal's")
    if output_value.lowest_score > output_value.score + ROUNDING:
        return result(False, "the lowest score is above the best")
    return result(True, "the meal meets every constraint and the restrictions")


def verify_task(arguments, output, reference, workspace):
    """Valid when the suggestion is whole servings of the allowed recipes, each with its recipe's url and
    the likes it matches, whose totals (recomputed from the recipes, and as it gives them) meet every
    constraint. The score is where its preference score falls between the pinned lowest and best (see
    meals.share); a feasible meal that is not the best is valid with a score below 1."""
    recipes = load_recipes()
    optimum = {"dishes": reference.dishes, "score": reference.score, "lowest_score": reference.lowest_score}
    problems = meal_problems(output, arguments.meal, recipes, arguments.constraints, arguments)
    if problems:
        return result(
            False, "the meal breaks a constraint or the restrictions", score=0.0, problems=problems, optimum=optimum
        )
    value = meal_score(output.dishes, recipes, arguments.likes)
    if value > reference.score + ROUNDING or value < reference.lowest_score - ROUNDING:
        return result(
            False, "the meal's preference score is outside the pinned range: the reference is wrong", score=0.0
        )
    return result(
        True,
        f"the meal meets every constraint and the restrictions; preference score {value:g} against the best "
        f"{reference.score:g} (lowest {reference.lowest_score:g})",
        score=round(share(value, reference.score, reference.lowest_score), 6),
        preference=value,
        optimum=optimum,
    )


def verify_recommendation(arguments, output, reference, workspace):
    """The recommended meal is the solver's: valid when it checks as solve's output (see verify_output)."""
    return verify_output(arguments, output, workspace)
