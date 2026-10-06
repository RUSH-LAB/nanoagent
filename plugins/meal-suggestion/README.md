# Meal Suggestion

A `nanoagent.plugin/v1` plugin, created by `nanoagent plugin new` with the
structure of NanoAgent's reference plugin, `plugins/arxiv-source`. It suggests
dishes for a breakfast, lunch or dinner that together meet nutrition
constraints and a food preference. It uses no network.

## Tools

| Tool | Does | Code |
|---|---|---|
| `solve` | Finds the best meal of whole servings by mixed-integer linear programming (HiGHS, through `scipy.optimize.milp`); the suggest-meal task's pinned reference | `src/plugin/solve.py` |
| `list_recipes` | Lists the recipes for a meal that meet a food preference | `src/plugin/meals.py` |
| `nutrition` | Gives one serving of a recipe: its ingredients' grams and its kcal, protein, fat, carbs and fiber | `src/plugin/meals.py` |
| `submit_meal` | Writes the suggestion, each dish's recipe and whole servings, to `meal.json` | `src/plugin/meals.py` |

### Input files

The task reads two files, staged by NanoAgent's `inputs:` as
`inputs/<name>` in the workspace and named by the task's arguments. Samples
with USDA-like values are in `tests/fixtures/`.

- `ingredients.json`: each ingredient's `kcal`, `protein`, `fat`, `carbs` and
  `fiber` per 100 g (grams, except kcal).
- `recipes.json`: each recipe's `meals` (any of breakfast, lunch, dinner),
  `tags` (such as `vegetarian`, `vegan`, `dairy`, `gluten`) and grams of each
  ingredient per serving.

A serving's nutrition is the sum over its ingredients of grams / 100 x the
ingredient's value per 100 g; a meal's totals are servings x per serving,
summed over its dishes.

### Suggest a meal

`suggest-meal` takes the two files, the meal, `constraints` (a `min`, a `max`
or both for any nutrient), the `preference` (tags every dish must have and tags
none may have, a hard filter), one `objective` (maximize or minimize one
nutrient's total) and `max_servings`, the most whole servings of any one
recipe. Before the agent starts, NanoAgent runs `solve` and pins its optimal
plan, the plan's objective total and each eligible recipe's nutrition as
`reference.json`; infeasible input fails the run. The agent then gets
`list_recipes`, `nutrition` and `submit_meal`.

`verifier/solve.py` recomputes the suggestion's totals from the input files.
The verdict is valid when `meal.json` holds at least one dish, every dish is a
recipe for the meal that meets the preference, listed once, with 1 to
`max_servings` servings, and the totals meet every constraint. The score is how
close the objective comes to the pinned optimum: total / optimum when
maximizing, optimum / total when minimizing. Nutrients are never negative, so a
valid meal scores in (0, 1], 1.0 at the optimum. A feasible meal that is not
optimal is still valid, with a lower score; a meal that beats the optimum means
the reference is wrong, and fails.

## Layout

```text
.
├── nanoagent.yaml   # manifest: id, runtime, permissions, tools, tasks
├── README.md
├── LICENSE
├── pyproject.toml
├── uv.lock
├── .gitignore
├── .env             # environment variable NAMEs this plugin needs (none here)
├── run.sh           # exits 0 when this environment can run the plugin
├── schemas/         # <tool>-input.json / <tool>-output.json, one pair per tool
├── src/plugin/      # the MCP server (__main__.py, its TOOLS table) and the tools
├── tests/           # tests, and the sample input files in fixtures/
└── verifier/        # deterministic verifier package, one module per tool
```

`verifier/` imports only `json` and `pathlib`. `verifier/meals.py` recomputes
nutrition exactly as `src/plugin/meals.py` does. For each tool's output it
checks that the recipe list, the nutrition and the pinned reference match the
input files, and that `meal.json` holds the submitted dishes.

## Develop and run

```bash
uv sync --extra dev
uv run pytest
```

Run it from the NanoAgent repository root:

```bash
uv run nanoagent plugin inspect plugins/meal-suggestion
bash examples/meal_suggestion/runs/step1_suggest_meal.sh  # agent: a vegetarian, high-protein dinner
```
