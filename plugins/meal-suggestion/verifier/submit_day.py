import json
from pathlib import Path

from .checks import result
from .meals import DAY, as_dishes


def verify_input(value):
    if not value.meals:
        return result(False, "a day has one or more meals")
    for meal, dishes in value.meals.items():
        names = [dish.recipe for dish in dishes]
        if not names or not all(name.strip() for name in names) or len(set(names)) != len(names):
            return result(False, f"{meal.value} must name at least one recipe, each once")
        if any(dish.servings < 1 for dish in dishes):
            return result(False, f"{meal.value}: servings must be positive whole numbers")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    path = Path(workspace) / DAY
    if Path(output_value.path) != path or not path.is_file():
        return result(False, f"the plan is not at {DAY} in the workspace")
    meals = {meal.value: as_dishes(dishes) for meal, dishes in input_value.meals.items()}
    if json.loads(path.read_text(encoding="utf-8")) != {"meals": meals}:
        return result(False, f"{DAY} does not hold the submitted meals")
    return result(True, "the plan is written", dishes=output_value.dishes)
