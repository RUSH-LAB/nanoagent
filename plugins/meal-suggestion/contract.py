"""Each tool's and task's typed input and output (see nanoagent.plugin.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    SOLVE = "solve"
    LIST_RECIPES = "list_recipes"
    NUTRITION = "nutrition"
    SUBMIT_MEAL = "submit_meal"
    SOLVE_DAY = "solve_day"
    SUBMIT_DAY = "submit_day"


class Task(Enum):
    SUGGEST_MEAL = "suggest-meal"
    PLAN_DAY = "plan-day"


class Meal(Enum):
    BREAKFAST = "breakfast"
    LUNCH = "lunch"
    DINNER = "dinner"


class Nutrient(Enum):
    KCAL = "kcal"
    PROTEIN = "protein"
    FAT = "fat"
    SATURATED_FAT = "saturated_fat"
    CHOLESTEROL = "cholesterol"
    SODIUM = "sodium"
    CARBS = "carbs"
    FIBER = "fiber"
    SUGAR = "sugar"


RECIPES = "The recipes file in the workspace (inputs/recipes.json), a Cookbook: each recipe's meals, tags, servings, nutrition per serving, ingredients and steps"
RECIPE = "A recipe's name, as list_recipes gives it"
RESTRICTIONS = "What the meal must and must not be, a hard filter on recipe tags"
LIKES = "What the eater likes and dislikes, each a weight on the recipes it matches"


@dataclass
class Bound(Output):
    min: Annotated[float | None, "The least the meal's total may be, or null for no minimum"]
    max: Annotated[float | None, "The most the meal's total may be, or null for no maximum"]


@dataclass
class Restrictions(Output):
    require: Annotated[list[str], "Tags every dish must have, e.g. Vegan"]
    exclude: Annotated[list[str], "Tags no dish may have, e.g. Meat"]


@dataclass
class Like(Output):
    name: Annotated[str, "What is liked, e.g. dairy"]
    words: Annotated[
        list[str],
        "Words that mean it, e.g. milk, cheese, yogurt; a recipe matches when one is a word (or its plural) of its ingredients or tags",
    ]
    ignore: Annotated[list[str], "Phrases its words do not count in, e.g. peanut butter for dairy; [] for none"]
    weight: Annotated[float, "How much it is liked: positive for a like, negative for a dislike"]


@dataclass
class Nutrition(Output):
    kcal: float
    protein: Annotated[float, "Grams"]
    fat: Annotated[float, "Grams"]
    saturated_fat: Annotated[float, "Grams"]
    cholesterol: Annotated[float, "Milligrams"]
    sodium: Annotated[float, "Milligrams"]
    carbs: Annotated[float, "Grams"]
    fiber: Annotated[float, "Grams"]
    sugar: Annotated[float, "Grams"]


@dataclass
class CookbookRecipe(Output):
    url: Annotated[str, "The recipe's page at its source"]
    meals: Annotated[list[Meal], "The meals it is for, one or more"]
    tags: Annotated[list[str], "Its source's labels, e.g. Food.com's Vegan or Meat"]
    servings: Annotated[int, "The servings the whole recipe makes"]
    per_serving: Annotated[Nutrition, "One serving's nutrition, as its source gives it"]
    ingredients: Annotated[list[str], "Its ingredients, as its source gives them: names, or lines with amounts"]
    steps: Annotated[list[str], "How it is made, in order"]


@dataclass
class Cookbook(Output):
    source: Annotated[str, "Where the recipes came from, and how to credit it"]
    recipes: Annotated[dict[str, CookbookRecipe], "Each recipe, by name"]


@dataclass
class Dish(Output):
    recipe: Annotated[str, RECIPE]
    servings: Annotated[int, "Whole servings, at most the task's max_servings"]


@dataclass
class Recipe(Output):
    name: str
    tags: list[str]
    per_serving: Nutrition
    liked: Annotated[list[str], "The likes it matches, by name"]
    score: Annotated[float, "Its preference score: the sum of the weights of the likes it matches"]


@dataclass
class SolveInput(Output):
    recipes: Annotated[str, RECIPES]
    meal: Annotated[Meal, "The meal to suggest"]
    constraints: Annotated[
        dict[Nutrient, Bound],
        'Bounds on the meal\'s totals, e.g. {"protein": {"min": 50, "max": null}}: kcal, mg of cholesterol and sodium, and grams of protein, fat, saturated_fat, carbs, fiber and sugar',
    ]
    restrictions: Annotated[Restrictions, RESTRICTIONS]
    likes: Annotated[list[Like], LIKES]
    max_servings: Annotated[int, "The most whole servings of any one recipe, 1 to 10"]


@dataclass
class SolveOutput(Output):
    plan: list[Dish]
    score: Annotated[float, "The plan's preference score, the sum of its dishes' scores: the most any meal can have"]
    worst: Annotated[float, "The least preference score any meal that meets every constraint can have"]
    totals: Nutrition
    recipes: Annotated[dict[str, Nutrition], "Each eligible recipe's nutrition per serving"]
    scores: Annotated[dict[str, float], "Each eligible recipe's preference score"]


@dataclass
class RecipesInput(Output):
    recipes: Annotated[str, RECIPES]
    meal: Meal
    restrictions: Annotated[Restrictions, RESTRICTIONS]
    likes: Annotated[list[Like], LIKES]


@dataclass
class RecipesOutput(Output):
    recipes: list[Recipe]


@dataclass
class NutritionInput(Output):
    recipes: Annotated[str, RECIPES]
    recipe: Annotated[str, RECIPE]


@dataclass
class NutritionOutput(Output):
    recipe: str
    ingredients: Annotated[list[str], "Its ingredients, by name"]
    per_serving: Nutrition


@dataclass
class SubmitInput(Output):
    dishes: Annotated[list[Dish], "The suggested meal: each dish's recipe and servings, each recipe once"]


@dataclass
class SubmitOutput(Output):
    path: str
    dishes: int


@dataclass
class DayInput(Output):
    recipes: Annotated[str, RECIPES]
    meals: Annotated[
        dict[Meal, dict[Nutrient, Bound]],
        'The day\'s meals, each with the bounds on its own totals, e.g. {"breakfast": {"kcal": {"min": 300, "max": 600}}, "dinner": {}}',
    ]
    day: Annotated[dict[Nutrient, Bound], "Bounds on the whole day's totals, its meals' summed"]
    restrictions: Annotated[Restrictions, RESTRICTIONS]
    likes: Annotated[list[Like], LIKES]
    max_servings: Annotated[int, "The most whole servings of any one recipe in a meal, 1 to 10"]


@dataclass
class MealPlan(Output):
    dishes: list[Dish]
    totals: Nutrition
    score: Annotated[float, "The meal's preference score"]


@dataclass
class DayOutput(Output):
    plan: Annotated[dict[Meal, MealPlan], "Each meal of the day the eater likes best"]
    score: Annotated[float, "The day's preference score, its meals' summed: the most any day can have"]
    worst: Annotated[float, "The least preference score any day that meets every constraint can have"]
    totals: Annotated[Nutrition, "The day's totals"]
    recipes: Annotated[
        dict[str, Nutrition], "Each recipe eligible for one of the day's meals, its nutrition per serving"
    ]
    scores: Annotated[dict[str, float], "Each such recipe's preference score"]


@dataclass
class SubmitDayInput(Output):
    meals: Annotated[dict[Meal, list[Dish]], "Each meal of the day and its dishes, each recipe once per meal"]


@dataclass
class SubmitDayOutput(Output):
    path: str
    dishes: Annotated[int, "The day's dishes, over all its meals"]


TOOLS = {
    Tool.SOLVE: (SolveInput, SolveOutput),
    Tool.LIST_RECIPES: (RecipesInput, RecipesOutput),
    Tool.NUTRITION: (NutritionInput, NutritionOutput),
    Tool.SUBMIT_MEAL: (SubmitInput, SubmitOutput),
    Tool.SOLVE_DAY: (DayInput, DayOutput),
    Tool.SUBMIT_DAY: (SubmitDayInput, SubmitDayOutput),
}
TASKS = {Task.SUGGEST_MEAL: SolveInput, Task.PLAN_DAY: DayInput}
