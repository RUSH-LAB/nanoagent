"""solve_day (the plan-day reference) and the plan-day task's output check."""

from .checks import result
from .meals import (
    MAX_SERVINGS,
    ROUNDING,
    bounds_problem,
    dish_problems,
    likes_problem,
    load_recipes,
    meal_score,
    share,
)
from .solve import totals_problems


def verify_input(value):
    if not value.meals:
        return result(False, "a day has one or more meals")
    problem = likes_problem(value.likes) or bounds_problem(value.day)
    for meal, constraints in value.meals.items():
        found = bounds_problem(constraints)
        if found and not problem:
            problem = f"{meal.value}: {found}"
    if problem:
        return result(False, problem)
    if not 1 <= value.max_servings <= MAX_SERVINGS:
        return result(False, f"max_servings must be a whole number from 1 to {MAX_SERVINGS}")
    return result(True, "input is valid")


def day_problems(day, recipes, arguments):
    """What is wrong with ``day`` (a contract DayPlanOutput or DayOutput) for the task's arguments (a contract
    DayInput): its meals, their dishes, each meal's totals and the day's."""
    if sorted(meal.value for meal in day.meals) != sorted(meal.value for meal in arguments.meals):
        return [f"the day's meals must be exactly {', '.join(meal.value for meal in arguments.meals)}"]
    problems = []
    for meal in arguments.meals:
        found = dish_problems(day.meals[meal].dishes, recipes, meal, arguments)
        problems += [f"{meal.value}: {problem}" for problem in found]
    if problems:
        return problems
    for meal, constraints in arguments.meals.items():
        plan = day.meals[meal]
        found = totals_problems(plan.dishes, plan.totals, recipes, constraints)
        problems += [f"{meal.value}: {problem}" for problem in found]
    every = [dish for plan in day.meals.values() for dish in plan.dishes]
    return problems + [f"day: {problem}" for problem in totals_problems(every, day.totals, recipes, arguments.day)]


def day_score(day, recipes, likes):
    return sum(meal_score(plan.dishes, recipes, likes) for plan in day.meals.values())


def verify_output(input_value, output_value, workspace):
    """The pinned plan is a day meeting every constraint, its totals and score are its dishes', and the
    lowest score is no more than its (that it is the best and the lowest the least rests on the solver)."""
    recipes = load_recipes()
    problems = day_problems(output_value, recipes, input_value)
    if problems:
        return result(False, "the plan is not a day meeting every constraint", problems=problems)
    if abs(output_value.score - day_score(output_value, recipes, input_value.likes)) > ROUNDING:
        return result(False, "the pinned score is not the plan's")
    if output_value.lowest_score > output_value.score + ROUNDING:
        return result(False, "the pinned lowest score is above the best")
    return result(True, "the plan is a day meeting every constraint")


def verify_task(arguments, output, reference, workspace):
    """Valid when the plan holds exactly the day's meals, each of whole servings of its allowed recipes
    within its own bounds, and the day's totals within the day's, all recomputed from the recipes and
    as the plan gives them. The score is where its preference score falls between the pinned lowest and
    best (see meals.share)."""
    recipes = load_recipes()
    optimum = {
        "meals": {meal.value: plan for meal, plan in reference.meals.items()},
        "score": reference.score,
        "lowest_score": reference.lowest_score,
    }
    problems = day_problems(output, recipes, arguments)
    if problems:
        return result(
            False, "the day breaks a constraint or the restrictions", score=0.0, problems=problems, optimum=optimum
        )
    value = day_score(output, recipes, arguments.likes)
    if value > reference.score + ROUNDING or value < reference.lowest_score - ROUNDING:
        return result(
            False, "the day's preference score is outside the pinned range: the reference is wrong", score=0.0
        )
    return result(
        True,
        f"the day meets every constraint and the restrictions; preference score {value:g} against the best "
        f"{reference.score:g} (lowest {reference.lowest_score:g})",
        score=round(share(value, reference.score, reference.lowest_score), 6),
        preference=value,
        optimum=optimum,
    )
