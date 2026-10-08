# Meal Suggestion

A `nanoagent.plugin/v1` plugin, created by `nanoagent plugin new` with the
structure of NanoAgent's reference plugin, `plugins/arxiv-source`. It suggests
the dishes for a breakfast, lunch or dinner that the eater likes best and that
together meet nutrition constraints and dietary restrictions, from real
Food.com recipes. It uses no network.

## Tools

| Tool | Does | Code |
|---|---|---|
| `solve` | Finds the best-liked meal of whole servings, and the least-liked one, by mixed-integer linear programming (HiGHS, through `scipy.optimize.milp`); the suggest-meal task's pinned reference | `src/plugin/solve.py` |
| `list_recipes` | Lists the recipes for a meal that meet the restrictions, each with its tags, nutrition per serving, the likes it matches and its preference score | `src/plugin/meals.py` |
| `nutrition` | Gives a recipe's ingredients and one serving's nutrition | `src/plugin/meals.py` |
| `submit_meal` | Writes the suggestion, each dish's recipe and whole servings, to `meal.json` | `src/plugin/meals.py` |
| `solve_day` | Finds the best-liked day of meals, and the least-liked one, each meal within its own bounds and the day within the day's; the plan-day task's pinned reference | `src/plugin/solve.py` |
| `submit_day` | Writes the day's plan, each meal's dishes, to `day.json` | `src/plugin/meals.py` |

### The recipes file

The task reads one file, `recipes.json`, staged by NanoAgent's `inputs:` as
`inputs/recipes.json` and named by the task's `recipes` argument. It is a
`contract.Cookbook`: where its recipes came from and how to credit them, and
for each recipe, by name, its `url` (its page at its source), `meals` (any of
breakfast, lunch, dinner), `tags`, `servings`, `per_serving` nutrition,
`ingredients` and `steps`. A serving's nutrition is its source's own: kcal, mg
of cholesterol and sodium, and grams of protein, fat, saturated fat, carbs,
fiber and sugar. A meal's totals are servings x per serving, summed over its
dishes. `tests/fixtures/recipes.json` is a 14-recipe excerpt of the Food.com
file.

`examples/meal_suggestion/step1_build_foodcom_recipes.py` builds it from
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

### Suggest a meal

`suggest-meal` takes the recipes file, the meal, `constraints` (a `min`, a `max`
or both for any nutrient), `restrictions` (tags every dish must have and tags
none may have, a hard filter), `likes` and `max_servings`, the most whole
servings of any one recipe. `solve` is the linear program: for each eligible
recipe, whole servings `x` from 0 to `max_servings` and whether it is a dish,
`y` (0 or 1, tied to `x` by `x <= max_servings * y` and `x >= y`); the
constraints bound the servings' nutrient totals, and at least one serving is
served. It maximizes the sum of score x `y`, and solves again minimizing it,
for the least-liked meal that meets every constraint. Before the agent starts,
NanoAgent runs `solve` and pins a best plan, the best and the worst scores and
each eligible recipe's nutrition and score as `reference.json`; infeasible
input fails the run. The agent then gets `list_recipes`, `nutrition` and
`submit_meal`.

`verifier/solve.py` recomputes the suggestion's totals and score from the
recipes file. The verdict is valid when `meal.json` holds at least one dish,
every dish is a recipe for the meal that meets the restrictions, listed once,
with 1 to `max_servings` servings, and the totals meet every constraint. The
score is where the meal's preference score falls between the pinned worst and
best, (score - worst) / (best - worst): 1.0 at the best, 0.0 at the worst, and
1.0 when every feasible meal scores alike. Many meals can tie at the best; any
of them scores 1.0. A meal scoring outside the pinned range means the
reference is wrong, and fails.

### Recommend a meal, and the page

`recommend-meal` takes `suggest-meal`'s input and runs `solve` alone, no agent:
the exact recommendation in a few seconds. `ui/` is the plugin's page for it:
a meal, a min and a max for each nutrient, what the eater likes and does not
like, and the recommended recipes, each with its servings, the likes it
matches and its Food.com link. The page carries the Food.com recipes itself
(`ui/recipes.js`, step 1's `recipes.json` as a module) and stages them as
`inputs/recipes.json` before a run. A typed word is a like of weight +1, or -1
for a dislike; a food group (`dairy`, `meat`, `seafood`, `chocolate`, `eggs`,
`mushrooms`) stands for its words and ignored phrases, any other word for
itself. Recipes tagged `Dessert` are left out.

### Plan a day

`plan-day` takes the recipes file, `meals` (each meal of the day and the bounds
on its own totals, `{}` for none), `day` (bounds on the whole day's totals, its
meals' summed), `restrictions`, `likes` and `max_servings`; both every meal's
bounds and the day's must be met. `solve_day` is the same linear program over
all the meals at once: servings and dish variables for each (meal, recipe), a
recipe eligible for a meal when it is for that meal and meets the restrictions,
each meal's bounds on its own servings, the day's on all of them, and at least
one serving per meal. A recipe may be in more than one meal, a dish each time.
It maximizes the day's preference score, its dishes' scores summed, and solves
again for the least. The agent gets `list_recipes` (one call per meal),
`nutrition` and `submit_day`. `verifier/day.py` recomputes every meal's totals
and the day's from the recipes file; the verdict is valid when `day.json` holds
exactly the day's meals and every bound is met, and the score is where the
day's preference score falls between the pinned worst and best, as for a meal.
`suggest-meal`'s `solve` is this program with one meal and no day bounds.

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
├── src/plugin/      # the MCP server (__main__.py, its TOOLS table) and the tools
├── tests/           # tests, and the sample recipes file in fixtures/
└── verifier/        # deterministic verifier package, one module per tool
```

`contract.py` types every value: the server builds each call's input into its
class and checks its output against its own, and NanoAgent and the verifier
get the same classes. A constraint gives both `min` and `max`, `null` for no
bound. `verifier/` imports only the standard library and `contract`, and reads
the recipes file as plain JSON. For each tool's output it checks that the
recipe list, the nutrition and the pinned reference match the recipes file, and
that `meal.json` holds the submitted dishes.

## Develop and run

```bash
uv sync --extra dev
uv run pytest
```

Run it from the NanoAgent repository root:

```bash
uv run nanoagent plugin inspect plugins/meal-suggestion
bash examples/meal_suggestion/runs/step1_build_foodcom_recipes.sh  # Food.com recipes (needs the examples extra)
bash examples/meal_suggestion/runs/step2_suggest_meal.sh           # agent: a meatless dinner for a dairy lover
bash examples/meal_suggestion/runs/step3_plan_day.sh               # agent: a day of meals for the same eater
```
