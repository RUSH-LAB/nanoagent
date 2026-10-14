"""Each tool's and task's typed input and output (see nanoagent.plugin.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    SOLVE = "solve"
    LIST_RECIPES = "list_recipes"
    NUTRITION = "nutrition"
    SOLVE_DAY = "solve_day"


class Task(Enum):
    SUGGEST_MEAL = "suggest-meal"
    PLAN_DAY = "plan-day"
    RECOMMEND_MEAL = "recommend-meal"


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


RECIPE = "A recipe's name, as list_recipes gives it"
URL = "The recipe's page on Food.com"
LIKED = "The likes it matches, by name"
RESTRICTIONS = (
    "What every dish must and must not be, a hard filter on Food.com's recipe tags, e.g. Vegan, Healthy, Meat, "
    "Poultry, Pork, Chicken, Cheese, Beans, Dessert, Low Cholesterol, High Protein, Very Low Carbs, Lactose Free, "
    "Egg Free, Kid Friendly, Easy, < 30 Mins: for a vegetarian meal exclude Meat and Poultry; exclude Dessert unless "
    "the person asks for sweets"
)
LIKES = (
    "What the eater likes and dislikes, from what the person says: each a weight on the recipes it matches, "
    "e.g. 'I love cheese and hate mushrooms' is cheese with weight 2 and mushrooms with weight -2; [] for none"
)
CONSTRAINTS = (
    "Bounds on the meal's totals, from the person's targets, e.g. 'at least 30 g of protein and under 800 calories' "
    'is {"protein": {"min": 30, "max": null}, "kcal": {"min": null, "max": 800}}: kcal, mg of cholesterol and '
    "sodium, and grams of protein, fat, saturated_fat, carbs, fiber and sugar; only the nutrients the person bounds"
)
MAX_SERVINGS = "The most whole servings of any one recipe in a meal, 1 to 10: 2 unless the person says otherwise"


@dataclass
class Bound(Output):
    min: Annotated[float | None, "The least the total may be, or null for no minimum"]
    max: Annotated[float | None, "The most the total may be, or null for no maximum"]


@dataclass
class Restrictions(Output):
    require: Annotated[list[str], "Tags every dish must have, e.g. Vegan; [] for none"]
    exclude: Annotated[list[str], "Tags no dish may have, e.g. Meat; [] for none"]


@dataclass
class Like(Output):
    name: Annotated[str, "What is liked, e.g. dairy"]
    words: Annotated[
        list[str],
        "Words that mean it, e.g. milk, cheese, yogurt, butter, cream for dairy; a recipe matches when one is a word "
        "(or its plural) of its ingredients or tags",
    ]
    ignore: Annotated[list[str], "Phrases its words do not count in, e.g. peanut butter for dairy; [] for none"]
    weight: Annotated[
        float, "How much it is liked: positive for a like, negative for a dislike, e.g. 2 for loves, 1 for likes"
    ]


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
    url: Annotated[str, URL]
    servings: Annotated[int, "Whole servings, at most the task's max_servings"]
    liked: Annotated[list[str], LIKED]


@dataclass
class Recipe(Output):
    name: str
    url: Annotated[str, URL]
    tags: list[str]
    per_serving: Nutrition
    liked: Annotated[list[str], LIKED]
    score: Annotated[float, "Its preference score: the sum of the weights of the likes it matches"]


@dataclass
class SolveInput(Output):
    meal: Annotated[Meal, "The meal: breakfast, lunch or dinner"]
    constraints: Annotated[dict[Nutrient, Bound], CONSTRAINTS]
    restrictions: Annotated[Restrictions, RESTRICTIONS]
    likes: Annotated[list[Like], LIKES]
    max_servings: Annotated[int, MAX_SERVINGS]


@dataclass
class SolveOutput(Output):
    dishes: Annotated[list[Dish], "The meal the eater likes best"]
    totals: Annotated[Nutrition, "The meal's totals"]
    score: Annotated[float, "The meal's preference score, the sum of its dishes' scores: the most any meal can have"]
    lowest_score: Annotated[float, "The least preference score any meal that meets every constraint can have"]


@dataclass
class Suggestion(Output):
    dishes: Annotated[list[Dish], "The meal's dishes, each recipe once"]
    totals: Annotated[Nutrition, "The meal's totals: servings x per serving, summed over its dishes"]


@dataclass
class RecipesInput(Output):
    meal: Meal
    restrictions: Annotated[Restrictions, RESTRICTIONS]
    likes: Annotated[list[Like], LIKES]


@dataclass
class RecipesOutput(Output):
    recipes: list[Recipe]


@dataclass
class NutritionInput(Output):
    recipe: Annotated[str, RECIPE]


@dataclass
class NutritionOutput(Output):
    recipe: str
    ingredients: Annotated[list[str], "Its ingredients, by name"]
    per_serving: Nutrition


@dataclass
class DayInput(Output):
    meals: Annotated[
        dict[Meal, dict[Nutrient, Bound]],
        "The day's meals, each with the bounds on its own totals (as for a meal's constraints), e.g. "
        '{"breakfast": {"kcal": {"min": 300, "max": 600}}, "lunch": {}, "dinner": {}}: every meal the person wants '
        "planned, {} for a meal with no bounds of its own",
    ]
    day: Annotated[
        dict[Nutrient, Bound],
        "Bounds on the whole day's totals, its meals' summed, e.g. 'about 2000 calories and at least 90 g of protein "
        'a day\' is {"kcal": {"min": 1800, "max": 2200}, "protein": {"min": 90, "max": null}}',
    ]
    restrictions: Annotated[Restrictions, RESTRICTIONS]
    likes: Annotated[list[Like], LIKES]
    max_servings: Annotated[int, MAX_SERVINGS]


@dataclass
class DayOutput(Output):
    meals: Annotated[dict[Meal, Suggestion], "Each meal of the day the eater likes best"]
    totals: Annotated[Nutrition, "The day's totals"]
    score: Annotated[float, "The day's preference score, its meals' summed: the most any day can have"]
    lowest_score: Annotated[float, "The least preference score any day that meets every constraint can have"]


@dataclass
class DayPlan(Output):
    meals: Annotated[dict[Meal, Suggestion], "Each meal of the day and its dishes, each recipe once per meal"]
    totals: Annotated[Nutrition, "The day's totals, its meals' summed"]


TOOLS = {
    Tool.SOLVE: (SolveInput, SolveOutput),
    Tool.LIST_RECIPES: (RecipesInput, RecipesOutput),
    Tool.NUTRITION: (NutritionInput, NutritionOutput),
    Tool.SOLVE_DAY: (DayInput, DayOutput),
}
TASKS = {
    Task.SUGGEST_MEAL: (SolveInput, Suggestion),
    Task.PLAN_DAY: (DayInput, DayPlan),
    Task.RECOMMEND_MEAL: (SolveInput, SolveOutput),
}
