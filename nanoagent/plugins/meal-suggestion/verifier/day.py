"""solve_day (the plan-day reference) and the plan-day task's outcome check."""

from pathlib import Path

from .checks import result
from .meals import (
    DAY,
    MAX_SERVINGS,
    ROUNDING,
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
    if not value.meals:
        return result(False, "a day has one or more meals")
    problem = path_problem(value.recipes, "recipes") or likes_problem(value.likes) or bounds_problem(value.day)
    for meal, constraints in value.meals.items():
        found = bounds_problem(constraints)
        if found and not problem:
            problem = f"{meal.value}: {found}"
    if problem:
        return result(False, problem)
    if not 1 <= value.max_servings <= MAX_SERVINGS:
        return result(False, f"max_servings must be a whole number from 1 to {MAX_SERVINGS}")
    return result(True, "input is valid")


def day_problems(meals, recipes, arguments):
    """What is wrong with a day (each meal's name -> its dishes, as day.json holds them) for the task's
    arguments (a contract DayInput): its meals, their dishes, each meal's totals and the day's."""
    wanted = [meal.value for meal in arguments.meals]
    if not isinstance(meals, dict) or sorted(meals) != sorted(wanted):
        return [f"the day's meals must be exactly {', '.join(wanted)}"]
    problems = []
    for meal in arguments.meals:
        found = dish_problems(meals[meal.value], recipes, meal, arguments.restrictions, arguments.max_servings)
        problems += [f"{meal.value}: {problem}" for problem in found]
    if problems:
        return problems
    for meal, constraints in arguments.meals.items():
        found = constraint_problems(totals(meals[meal.value], recipes), constraints)
        problems += [f"{meal.value}: {problem}" for problem in found]
    every = [dish for meal in wanted for dish in meals[meal]]
    problems += [f"day: {problem}" for problem in constraint_problems(totals(every, recipes), arguments.day)]
    return problems


def day_score(meals, recipes, likes):
    return sum(meal_score(dishes, recipes, likes) for dishes in meals.values())


def verify_output(input_value, output_value, workspace):
    """The pinned plan is a day meeting every constraint, its scores and totals are its dishes', no
    more than the pinned worst is below it, and each recipe's nutrition and score are the file's (that
    the plan is the best and the worst the least rests on the solver)."""
    recipes = load_recipes(workspace, input_value.recipes)
    likes = input_value.likes
    names = sorted({name for meal in input_value.meals for name in eligible(recipes, meal, input_value.restrictions)})
    if sorted(output_value.recipes) != names or sorted(output_value.scores) != names:
        return result(False, "the pinned recipes are not exactly those eligible for one of the day's meals")
    for name in names:
        if nutrition_problem(output_value.recipes[name], per_serving(recipes[name])):
            return result(False, f"the pinned nutrition of {name} differs from the recipes file")
        if abs(output_value.scores[name] - score(recipes[name], likes)) > ROUNDING:
            return result(False, f"the pinned score of {name} is not the sum of its likes' weights")
    meals = {meal.value: as_dishes(plan.dishes) for meal, plan in output_value.plan.items()}
    problems = day_problems(meals, recipes, input_value)
    if problems:
        return result(False, "the plan is not a day meeting every constraint", problems=problems)
    for meal, plan in output_value.plan.items():
        if nutrition_problem(plan.totals, totals(meals[meal.value], recipes)):
            return result(False, f"the pinned {meal.value} totals are not its dishes'")
        if abs(plan.score - meal_score(meals[meal.value], recipes, likes)) > ROUNDING:
            return result(False, f"the pinned {meal.value} score is not its dishes'")
    every = [dish for dishes in meals.values() for dish in dishes]
    if nutrition_problem(output_value.totals, totals(every, recipes)):
        return result(False, "the pinned day totals are not its dishes'")
    if abs(output_value.score - day_score(meals, recipes, likes)) > ROUNDING:
        return result(False, "the pinned score is not the plan's")
    if output_value.worst > output_value.score + ROUNDING:
        return result(False, "the pinned worst score is above the best")
    return result(True, "the plan is a day meeting every constraint", plan=meals)


def verify_task(arguments, reference, workspace):
    """Valid when day.json holds exactly the day's meals, each of whole servings of its allowed recipes
    within its own bounds, and the day's totals, recomputed from the recipes file, within the day's.
    The score is where its preference score falls between the pinned worst and best (see
    meals.share)."""
    path = Path(workspace) / DAY
    optimum = {
        "plan": {meal.value: as_dishes(plan.dishes) for meal, plan in reference.plan.items()},
        "score": reference.score,
        "worst": reference.worst,
    }
    if not path.is_file():
        return result(False, f"no plan at {DAY}", score=0.0, optimum=optimum)
    meals = load(workspace, DAY).get("meals")
    recipes = load_recipes(workspace, arguments.recipes)
    problems = day_problems(meals, recipes, arguments)
    if problems:
        return result(
            False, "the day breaks a constraint or the restrictions", score=0.0, problems=problems, meals=meals
        )

    value = day_score(meals, recipes, arguments.likes)
    if value > reference.score + ROUNDING or value < reference.worst - ROUNDING:
        return result(
            False, "the day's preference score is outside the pinned range: the reference is wrong", score=0.0
        )
    every = [dish for dishes in meals.values() for dish in dishes]
    return result(
        True,
        f"the day meets every constraint and the restrictions; preference score {value:g} against the best "
        f"{reference.score:g} (worst {reference.worst:g})",
        score=round(share(value, reference.score, reference.worst), 6),
        meals=meals,
        totals=rounded(totals(every, recipes)),
        preference=value,
        optimum=optimum,
    )
