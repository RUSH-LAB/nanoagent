# Meal Suggestion

A `nanoagent.plugin/v1` plugin, created by `nanoagent plugin new` with the
structure of NanoAgent's reference plugin, `plugins/arxiv-source`. It suggests
the dishes for a breakfast, lunch or dinner that the eater likes best and that
together meet nutrition constraints and dietary restrictions, from real
Food.com recipes, or a whole day of them. It uses no network.

Its page is NanoAgent's chat: a person says the meal they want, their targets
and what they like and avoid, the chat runs one of the plugin's tasks with that
as its input, and the page shows the dishes, their servings, Food.com links and
the likes they match, over the meal's totals (`ui/renderers.js`), with the
task's verdict.

## Tools

| Tool | Does | Code |
|---|---|---|
| `solve_meal` | Finds the best-liked meal of whole servings, and the least-liked one, by mixed-integer linear programming (HiGHS, through `scipy.optimize.milp`); the recommend-meal task, and the suggest-meal task's pinned reference | `src/plugin/solve.py` |
| `list_recipes` | Lists the recipes for a meal that meet the restrictions, each with its Food.com link, tags, nutrition per serving, the likes it matches and its preference score | `src/plugin/meals.py` |
| `get_nutrition` | Gives a recipe's ingredients and one serving's nutrition | `src/plugin/meals.py` |
| `solve_day` | Finds the best-liked day of meals, and the least-liked one, each meal within its own bounds and the day within the day's; the plan-day task's pinned reference | `src/plugin/solve.py` |

### Tasks

| Task | Does | Runner |
|---|---|---|
| `recommend-meal` | Recommends the best-liked meal within the nutrition targets, solved exactly | `tool`, with `solve_meal` |
| `suggest-meal` | Has an agent suggest a meal within the nutrition targets, scored against `solve_meal`'s best | `agent`, with `list_recipes` and `get_nutrition` |
| `plan-day` | Has an agent plan a day of meals within the nutrition targets, scored against `solve_day`'s best | `agent`, with `list_recipes` and `get_nutrition` |

### The recipes

The plugin carries its recipes, `src/plugin/recipes.json`, so a person names
no file: every tool reads it, and the verifier reads the same file. It is a
`contract.Cookbook`: where its recipes came from and how to credit them, and
for each recipe, by name, its `url` (its page at its source), `meals` (any of
breakfast, lunch, dinner), `tags`, `servings`, `per_serving` nutrition,
`ingredients` and `steps`. A serving's nutrition is its source's own: kcal, mg
of cholesterol and sodium, and grams of protein, fat, saturated fat, carbs,
fiber and sugar. A meal's totals are servings x per serving, summed over its
dishes. `tests/fixtures/recipes.json` is a 14-recipe excerpt of the Food.com
file, which the tests use in its place.

`examples/meal_suggestion/step1_build_foodcom_recipes.py` builds it (444
recipes; rebuilt with that step, then copied to `src/plugin/recipes.json`) from
Food.com's 522,517 recipes (Kaggle `irkaal/foodcom-recipes-and-reviews`,
version 2, CC0), checking the download's SHA-256. Its config chooses the
recipes: those with at least `min_reviews` reviews whose Food.com category or
keywords name a meal (`Breakfast`, `Lunch/Snacks`, `One Dish Meal`). Tags are
the recipe's Food.com category and keywords as they are, such as `Vegan`,
`Meat`, `Poultry` or `Dessert`; there is no vegetarian tag, so a meatless
restriction excludes `Meat` and `Poultry`, which rests on Food.com's labels. A
selected recipe with no servings or a missing nutrient is left out, and so is
every recipe sharing a name with another; `report.json` lists each with why.
Food.com's ingredient quantities do not line up with its ingredient names in
most recipes, so the file keeps the names only.

### Preference score

`likes` says what the eater likes and dislikes, each a `name`, the `words` that
mean it, phrases to `ignore` and a `weight`, positive for a like and negative
for a dislike:

```json
[
  {"name": "dairy", "words": ["milk", "cheese", "yogurt", "butter", "cream"],
   "ignore": ["peanut butter", "coconut milk"], "weight": 2},
  {"name": "chocolate", "words": ["chocolate", "cocoa"], "ignore": [], "weight": 1},
  {"name": "mushrooms", "words": ["mushroom"], "ignore": [], "weight": -2}
]
```

A recipe matches a like when one of its words, or that word with -s or -es, is
a word of one of the recipe's ingredients or tags, case aside, outside its
ignored phrases (`egg` matches `eggs` but not `eggplant`; dairy's `butter` does
not count in `peanut butter`). A recipe's preference score is the sum of the
weights of the likes it matches, each once; a meal's is the sum of its dishes'
scores, each dish counted once however many servings it has.

### Recommend or suggest a meal

`recommend-meal` and `suggest-meal` take the meal, `constraints` (a `min`, a
`max` or both for any nutrient), `restrictions` (tags every dish must have and
tags none may have, a hard filter), `likes` and `max_servings`, the most whole
servings of any one recipe; the chat fills them from what the person says.
`recommend-meal` runs `solve_meal` alone, no agent: the exact recommendation in a
few seconds, each dish with its recipe, Food.com link, servings and the likes
it matches, the meal's totals, its preference score and the lowest score any
meal within the constraints can have. `solve_meal` is the linear program: for each eligible
recipe, whole servings `x` from 0 to `max_servings` and whether it is a dish,
`y` (0 or 1, tied to `x` by `x <= max_servings * y` and `x >= y`); the
constraints bound the servings' nutrient totals, and at least one serving is
served. It maximizes the sum of score x `y`, and solves again minimizing it,
for the least-liked meal that meets every constraint. `verifier/solve.py`
recomputes a recommendation's totals, likes and score from the recipes; it is
valid when it is a meal of the allowed recipes meeting every constraint.

`suggest-meal` has an agent choose instead. Before the agent starts, NanoAgent
runs `solve_meal` and pins its output; infeasible input fails the run. The agent
gets `list_recipes` and `get_nutrition` and finishes by submitting the meal, a
`contract.SuggestionOutput`: each dish's recipe, link, servings and likes, and the
meal's totals. `verifier/solve.py` judges the suggestion against the recipes:
it is valid when it holds at least one dish, every dish is a recipe for the
meal that meets the restrictions, listed once, with 1 to `max_servings`
servings, its link and the likes it matches, and the totals it gives are its
dishes' and meet every constraint. The score is where the meal's preference
score falls between the pinned lowest and best, (score - lowest) / (best -
lowest): 1.0 at the best, 0.0 at the lowest, and 1.0 when every feasible meal
scores alike. Many meals can tie at the best; any of them scores 1.0. A meal
scoring outside the pinned range means the reference is wrong, and fails.

### Plan a day

`plan-day` takes `meals` (each meal of the day and the bounds on its own
totals, `{}` for none), `day` (bounds on the whole day's totals, its
meals' summed), `restrictions`, `likes` and `max_servings`; both every meal's
bounds and the day's must be met. `solve_day` is the same linear program over
all the meals at once: servings and dish variables for each (meal, recipe), a
recipe eligible for a meal when it is for that meal and meets the restrictions,
each meal's bounds on its own servings, the day's on all of them, and at least
one serving per meal. A recipe may be in more than one meal, a dish each time.
It maximizes the day's preference score, its dishes' scores summed, and solves
again for the least. The agent gets `list_recipes` (one call per meal) and
`get_nutrition` and submits the day, a `contract.DayPlanOutput`: each meal's dishes and
totals, and the day's totals. `verifier/day.py` recomputes every meal's totals
and the day's from the recipes; the verdict is valid when the plan holds
exactly the day's meals, every dish checks as for a meal, the totals it gives
are its dishes' and every bound is met, and the score is where the day's
preference score falls between the pinned lowest and best, as for a meal.
`suggest-meal`'s `solve_meal` is this program with one meal and no day bounds.

## Layout

```text
.
├── nanoagent.yaml   # manifest (a slimconfig ManifestConfig): id, runtime, permissions, tools, tasks
├── contract.py      # each tool's and task's typed input and output: slimconfig Output classes
├── README.md
├── LICENSE
├── pyproject.toml
├── uv.lock
├── .gitignore
├── .env             # environment variable NAMEs this plugin needs (none here)
├── run.sh           # exits 0 when this environment can run the plugin
├── src/plugin/      # the MCP server (__main__.py, its IMPLEMENTATIONS), the tools and recipes.json
├── tests/           # tests, and the sample recipes file in fixtures/
├── ui/              # renderers.js (and renderers.css): the meals as recipe cards in the chat
├── product/         # the product page a catalog shows: product.yaml and icon.svg
└── verifier/        # deterministic verifier package, one module per tool
```

`contract.py` types every value: the server builds each call's input into its
class and checks its output against its own, and NanoAgent and the verifier
get the same classes. A constraint gives both `min` and `max`, `null` for no
bound. `verifier/` imports only the standard library and `contract`, and reads
`src/plugin/recipes.json` as plain JSON. For each tool's output it checks that
the recipe list, the nutrition and the solvers' meals match the recipes, and
for each task's output, the meal or the day it holds.

## Develop and run

```bash
uv sync --extra dev
uv run pytest
uv run --project <nanoagent checkout> nanoagent plugin inspect .
```

Its examples run from the NanoAgent checkout:

```bash
bash examples/meal_suggestion/runs/step1_build_foodcom_recipes.sh  # Food.com recipes (needs the examples extra), for src/plugin/recipes.json
bash examples/meal_suggestion/runs/step2_suggest_meal.sh           # agent: a meatless dinner for a dairy lover
bash examples/meal_suggestion/runs/step3_plan_day.sh               # agent: a day of meals for the same eater
```
