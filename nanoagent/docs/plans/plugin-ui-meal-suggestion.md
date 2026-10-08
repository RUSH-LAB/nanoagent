# Plan: the meal-suggestion page (`plugins/meal-suggestion/ui/`)

Designed against `contract.py` (Oct 7 16:51) and `nanoagent.yaml` (Oct 7 16:50). Another session
(code-55) is changing the recipe data format; section 8 lists every place the page depends on it, so
a builder re-reads `contract.py` before writing code and adjusts only those places.

## 1. The user job

"Tell me what to cook for dinner (or for the whole day) that I'll enjoy, that hits my nutrition
targets and that respects how I eat, and show me it really does."

The person is a home cook or someone tracking macros, not a developer. They think in "dinner, under
800 kcal, at least 30 g protein, no meat, I love cheese, I hate mushrooms", and want a short list of
real dishes with servings, the totals against their targets, and a trustworthy "yes, this fits".
They never see `solve`, `list_recipes`, `submit_meal`, JSON, weights as numbers or tag syntax.

The two tasks are two modes of one page:

| Mode (user's words) | Task | Writes | Verdict details used |
|---|---|---|---|
| **One meal** | `suggest-meal` (`SolveInput`) | `meal.json` `{dishes: [{recipe, servings}]}` | `dishes`, `totals`, `preference`, `optimum {plan, score, worst}`, `problems` |
| **A whole day** | `plan-day` (`DayInput`) | `day.json` `{meals: {breakfast: [...], ...}}` | `meals`, `totals` (day), `preference`, `optimum`, `problems` |

Both are `runner: agent`: no `task.result`; the outcome is the verdict plus the file the agent wrote.

## 2. Layout

Desktop (>= 960 px): a request panel on the left, the result on the right, chat in a drawer.

```text
+--------------------------------------------------------------------------------------+
| [icon] Meal Suggestion                       ( One meal | A whole day )   [Ask chef] |
|        Meals that hit your nutrition targets                                          |
+------------------------------+-------------------------------------------------------+
| YOUR MEAL                    |  DINNER FOR YOU                                       |
|  Meal  (Breakfast|Lunch|[Dinner])  +---------------------------------------------+  |
|                              |  | (check) Fits every target and how you eat   |  |
| HOW YOU EAT                  |  |  Best match for your tastes: 8 of 8 points  |  |
|  [x] Meatless  [ ] Vegan     |  |  Checked against 444 Food.com recipes        |  |
|  [x] No desserts [ ] Healthy |  +---------------------------------------------+  |
|  + More labels...            |                                                       |
|  38 dinners fit              |  +-------------------+  +-------------------+         |
|                              |  | Penne With        |  | Spaghetti Squash  |         |
| TASTES                       |  | Cannellini Beans  |  | 1 serving         |         |
|  Love  [dairy x] [+]         |  | 2 servings        |  | 210 kcal          |         |
|  Like  [chocolate x] [+]     |  | 410 kcal  22 g P  |  | (heart) dairy     |         |
|  Avoid [mushrooms x] [+]     |  | (heart) dairy     |  | Recipe v          |         |
|                              |  | Recipe v          |  +-------------------+         |
| TARGETS  (Balanced v)        |  +-------------------+                                |
|  Calories   [   ]-[ 1000] kcal|                                                      |
|  Protein    [ 30]-[     ] g  |  TOTALS VS YOUR TARGETS                               |
|  Fiber      [ 10]-[     ] g  |  Calories  657 kcal  |=====|-----]   <= 1000   ok    |
|  Sodium     [   ]-[ 1500] mg |  Protein    38 g     [--|======>     >= 30     ok    |
|  + Add a target              |  Fiber      15 g     [--|====>       >= 10     ok    |
|                              |  Sodium   1085 mg    |=======|---]   <= 1500   ok    |
|  Up to [-] 2 [+] servings    |  More nutrients v (fat, sat. fat, carbs, sugar, ...)  |
|  of any one dish             |                                                       |
|                              |  Chef's note v   (the agent's closing report)         |
|  [   Suggest my dinner   ]   |  Recipes: Food.com via Kaggle, CC0                    |
+------------------------------+-------------------------------------------------------+
```

"A whole day" replaces the meal picker with meal toggles and turns the result into one column per meal:

```text
| YOUR DAY                     |  YOUR DAY        (check) Fits every target            |
|  Meals [x]Breakfast [x]Lunch |  +-------------+ +-------------+ +-------------+      |
|        [x]Dinner             |  | BREAKFAST   | | LUNCH       | | DINNER      |      |
|  Day targets                 |  | 512 kcal    | | 760 kcal    | | 678 kcal    |      |
|   Calories [1600]-[2200]     |  | Waffles  x1 | | Parmesan    | | Lentil      |      |
|   Protein  [  90]-[    ]     |  | Popovers x1 | |  Fish    x1 | |  Pilaf   x1 |      |
|  Per-meal targets v          |  | ...         | | ...         | | ...         |      |
|   Breakfast kcal 300-600     |  +-------------+ +-------------+ +-------------+      |
|   ...                        |  DAY TOTALS VS YOUR TARGETS  (bars as above)          |
|  [ Plan my day ]             |                                                       |
```

Narrow (< 720 px): one column. Before a run the request panel is the page; after a run the result
comes first and the request collapses into a summary card ("Dinner, meatless, no desserts, 4
targets. Edit"). Mode switch and "Ask chef" stay in a compact header; meal columns stack; dish cards
are full width; target rows put min and max on a second line.

```text
+------------------------------+
| Meal Suggestion  [One|Day] (?)|
+------------------------------+
| Dinner, meatless, 4 targets  |
|                       [Edit] |
+------------------------------+
| (check) Fits every target    |
|  Best match for your tastes  |
+------------------------------+
| Penne With Cannellini Beans  |
|  2 servings  410 kcal  dairy |
+------------------------------+
| ...                          |
+------------------------------+
```

## 3. Components

### 3.1 Header

Plugin icon, name and tagline from `describe().plugin` (and `product.yaml`'s copy as the catalog
gives it); the mode switch (segmented control "One meal | A whole day"); "Ask the chef" opens the
chat drawer. Theme from `describe().theme`, then `host.theme` events, via `applyTheme`.

### 3.2 Recipe collection (setup card, shown only when needed)

Both tasks take `recipes`, a workspace path; the web run does not stage inputs (`app.py`: "a web
task reads the workspace's own files"), so the file must already be in the workspace.

- On load: `workspace.list`. If `inputs/recipes.json` exists, `workspace.read` it (the Food.com
  build is ~680 KB, 444 recipes), `JSON.parse`, and check its shape (`source` string, `recipes`
  object whose values have `meals`, `tags`, `per_serving` with all nine nutrients, `ingredients`,
  `steps`, `url`, `servings`). The page keeps the parsed cookbook in memory for the whole session.
- Missing: a card "Add your recipe collection" with a drop zone / file picker for a `.json`
  file; the page reads it with `FileReader`, checks the shape, then `workspace.write {path:
  "inputs/recipes.json", text}` and continues. Copy: "Build it from Food.com with the meal-suggestion
  example (step 1), then drop recipes.json here." Also lists other `.json` files already in the
  workspace as "Use this file" buttons (the user chooses; the page never guesses).
- Wrong shape: a clear error card naming what is missing ("recipe 'X' has no per_serving.fiber"),
  with "Choose another file". No partial use, no fallback.
- Loaded: a quiet line under the result, "444 Food.com recipes · 113 breakfasts, 231 lunches, 155
  dinners · Replace", plus the credit from `source`.

### 3.3 Meal picker / day meals

- One meal: segmented "Breakfast | Lunch | Dinner" (`Meal` enum). Default: by the local clock
  (before 10:30 breakfast, before 15:00 lunch, else dinner).
- Whole day: three toggles, all on by default; at least one required (the button stays disabled
  with "Pick at least one meal").

### 3.4 "How you eat" (restrictions)

Friendly toggles that compile to `Restrictions {require, exclude}`:

| Toggle | Compiles to |
|---|---|
| Meatless | exclude `Meat`, `Poultry` (README: there is no vegetarian tag) |
| Vegan | require `Vegan` |
| No desserts | exclude `Dessert` |
| Healthy | require `Healthy` |
| Low cholesterol | require `Low Cholesterol` |
| Kid friendly | require `Kid Friendly` |

Each preset shows only when its tags exist in the loaded cookbook. "More labels..." opens a
searchable list of every tag in the cookbook with its count, each settable to "Must be" or "Never".
Under the toggles a live count, computed in the page by porting `matches()` (meal in `meals`, all
required tags, no excluded one): "38 dinners fit". For a day, one count per meal. At 0 the count
turns into a warning ("No lunch recipe fits these rules. Turn off Vegan?") and the run button is
disabled, since `solve` would fail with "no lunch recipe meets the restrictions".

A small honest note under "Meatless": "Uses Food.com's own labels."

### 3.5 Tastes (likes)

Three rows, Love / Like / Avoid, each a chip list with "+". Weights: Love = 2, Like = 1, Avoid =
-2 (users never see numbers). Adding opens a small picker of food groups, each a preset `Like`
with its `words` and `ignore` (e.g. dairy: milk, cheese, yogurt, butter, cream; ignore peanut
butter, almond butter, apple butter, coconut milk, coconut cream, almond milk, soy milk, cream of
tartar; also chocolate, mushrooms, spicy, seafood, eggs, beans, rice, pasta, potatoes, chicken,
pork, nuts, fruit, garlic, onions), plus "Something else": a typed word becomes a `Like` whose
name and only word is that word, `ignore: []`. Names are unique; adding an existing one moves it.
Hovering or tapping a chip shows "matches 21 of 38 dinners", computed in the page by porting
`liked()` (word or word+s/es as a whole word of an ingredient or tag, case aside, outside ignored
phrases), the same rule as `src/plugin/meals.py` and `verifier/meals.py`.

Copy makes the limit honest: "Avoid makes a dish less likely; to rule something out completely use
How you eat." No tastes at all is allowed ("any dish that fits").

### 3.6 Targets (constraints / day bounds / per-meal bounds)

- A preset menu: Balanced, High protein, Light, Low sodium, None. One meal, Balanced dinner:
  kcal <= 800, protein >= 25 g, sodium <= 1200 mg. Day, Balanced: kcal 1600-2200, protein >= 90 g,
  fiber >= 30 g, sodium <= 2300 mg, saturated fat <= 22 g (the step 3 example). Choosing a preset
  replaces the rows; editing a row changes the menu label to "Custom".
- Each row: nutrient label in plain words with unit (Calories kcal, Protein g, Fat g, Saturated
  fat g, Cholesterol mg, Sodium mg, Carbs g, Fiber g, Sugar g), "at least" and "at most" number
  inputs (either may be blank = `null`), remove "x". "+ Add a target" lists unused nutrients.
- Inline validation, before any run: negative numbers, min above max ("At least must be below at
  most"), a row with both blank (dropped, not sent).
- Whole day: "Day targets" (the `day` field) are primary; "Per-meal targets" is a collapsible
  section with one small row group per selected meal (`meals[meal]`, `{}` when empty).

### 3.7 Servings stepper

"Up to [-] N [+] servings of any one dish", 1 to 10 (`max_servings`). Default 2 for a meal, 1 for
a day. Helper: "More servings make it easier to reach high protein or calorie targets."

### 3.8 Run button and progress

Label in the user's words: "Suggest my dinner" / "Plan my day". Disabled with a reason when the
cookbook is missing, a meal has 0 fitting recipes, or a target is invalid. Builds the arguments,
calls `runTask {task, arguments}`, keeps `runId`; Cancel calls `cancel {runId}`.

While running, the result area shows a step list with elapsed seconds and skeleton dish cards:

| Event | Step shown |
|---|---|
| `task.started` | "Starting" |
| `task.reference` | "Finding the best possible combination" (the solver pins best and worst) |
| `task.tool` `list_recipes` | "Looked through 38 dinner recipes" (`output.recipes.length`, meal from `arguments.meal`) |
| `task.tool` `nutrition` | "Checked the nutrition of Penne With Cannellini Beans" |
| `task.tool` `submit_meal` / `submit_day` | "Wrote down 4 dishes" |
| `task.tool` with `isError` | "Retried a step" (muted; the agent recovers) |
| `task.answer` | "Double-checking every target" |
| `task.verdict` | result (3.9) |
| `task.error` | error state (3.11) |
| `task.done` | stop timer, re-enable form, `workspace.list` refresh |

Tool names are mapped, never shown. The step list folds into "How this was made (6 steps)" once
the result arrives.

### 3.9 Result

Fed by `task.verdict` plus the in-memory cookbook. On `task.verdict` the page also
`workspace.read`s `meal.json` / `day.json` and uses it when `details.dishes` / `details.meals` is
absent (invalid early exits); when both exist they must agree, else show the error state.

**Verdict banner** (plain words, colour plus icon plus text, never colour alone):

| Verdict | Headline | Second line |
|---|---|---|
| valid, score 1 | "Fits every target and how you eat" | "Best match for your tastes: 8 of 8 points" (`preference` of `optimum.score`); when `optimum.score == optimum.worst`: "Every fitting meal suits your tastes equally" |
| valid, score < 1 | same headline | "A good match: 6 of a possible 8 taste points" with "See the best-liked option" (renders `optimum.plan` as an alternative set of dish cards) |
| not valid | "This suggestion did not pass the check" | each `details.problems` line, humanized (nutrient names to words, "dinner: " prefix to "Dinner:"); then "Try again" |

Always shown small: "Checked by recomputing every total from the recipe file." The raw
`message` sits in a "Details" disclosure for the curious.

**Dish cards**: for each dish, from the cookbook entry: name, "2 servings", per-dish kcal and
protein (servings x `per_serving`), the likes it matches as small heart chips and avoided ones as
a muted "has mushrooms" chip (ported `liked()`), up to 3 friendly tags (skip time/cook-method
noise like "< 4 Hours", "Oven"). "Recipe" disclosure: ingredients list, numbered steps, makes N
servings, and the Food.com address as selectable text with a Copy button (a sandboxed frame
without `allow-popups` cannot open links; see risks).

**Totals vs targets**: one bar per target the user set, the value from `details.totals` (meal or
day), the target band drawn, a status word ("ok", "12 g short", "300 kcal over") and the number.
"More nutrients" shows the untargeted ones as plain numbers. For a day, each meal column shows its
own totals (computed in the page from the cookbook) with its per-meal bars inside the column.

**Chef's note**: the `task.answer` text in a collapsed disclosure, as plain text.

**Actions**: "Try another" (re-run, same request), "Edit request" (narrow screens), "Ask about
this" (opens chat prefilled, 3.10).

### 3.10 Chat drawer ("Ask the chef")

`chatPanel` from components.js in a right-side drawer (full-screen sheet on narrow screens), over
`prompt {text}` and `chat.*` events. Closed by default. Suggested prompts once a result exists:
"Why these dishes?", "Swap the squash for something with rice", "What can I prep ahead?"; the page
prefixes the prompt with a one-line context ("My current dinner: Penne With Cannellini Beans x2,
..."). Chat answers never change the result card; if the agent writes a new `meal.json` /
`day.json` the page notices on `chat.done` (`workspace.list`, compare size) and offers "The chef
changed your meal. Show it" which re-reads the file and recomputes totals in the page, labelled
"Not checked yet" with "Check it" (re-runs nothing automatically).

### 3.11 Empty, running, error states

- First visit, cookbook present: request panel filled with defaults (meal by clock, Meatless off,
  no tastes, Balanced targets) and an empty result area with three sample cards, illustrative and
  muted: "Your dishes will appear here".
- Running: 3.8. Form inputs disabled, Cancel visible.
- `task.error`, mapped by message substring, each with the raw message under "Details":
  - "no dinner of whole servings meets every constraint" (or "no day of ...") -> "No combination of
    these recipes hits all your targets." plus hints computed in the page: the target closest to
    being impossible (e.g. "Fiber at least 40 g: the best single dinner has 14 g; allow more
    servings or lower it"), "Allow more servings", "Turn off a rule".
  - "no X recipe meets the restrictions" -> points at How you eat (should be prevented by 3.4).
  - "min is above its max" -> highlights the row (prevented by 3.6).
  - "no input file at" / "FileNotFoundError" -> the setup card (3.2).
  - "cancelled" -> "Stopped. Nothing was changed." (neutral, not red).
  - anything else -> "Something went wrong on our side" plus the message.
- A start failure (`runTask` rejects) -> the same error card with "Could not start".
- Verdict missing before `task.done` -> "The run ended without a check", error tone.

### 3.12 Remembering the eater

The page has an opaque origin, so no localStorage. On each successful run it writes
`meal-suggestion/profile.json` (mode, meal, restrictions toggles and extra tags, likes, targets,
servings) with `workspace.write`, and reads it on load to prefill. A "Reset to defaults" link
clears the form (and rewrites the file). This is the only file the page writes besides
`inputs/recipes.json`.

## 4. Data flow summary

| Need | Source |
|---|---|
| Plugin name, tagline, tasks, theme | `describe` |
| Recipes, tags, counts, ingredient/step text, per-serving nutrition | `workspace.read inputs/recipes.json` (parsed once) |
| Eligible counts, matched likes, per-dish and per-meal totals | computed in page (ports of `matches`, `liked`, totals) |
| Run progress | `task.reference`, `task.tool`, `task.answer` |
| Verdict, day/meal totals, optimum, problems | `task.verdict` (`valid`, `score`, `message`, `details`) |
| Chosen dishes | `task.verdict.details.dishes`/`meals`, else `workspace.read meal.json`/`day.json` |
| Chef's note | `task.answer.text` |
| Saved preferences | `workspace.read/write meal-suggestion/profile.json` |
| Chat | `prompt`, `chat.*` |

Argument building is one function per task that returns exactly `SolveInput` / `DayInput` with
`recipes: "inputs/recipes.json"`; every nutrient key is a `Nutrient` value, every bound has both
`min` and `max` (`null` for none).

## 5. Visual rules

Inter, accent `#3b5998` (dark `#8ea6d6`), cards 16 px radius with 1 px soft borders, from
`style.css` variables keyed on `html[data-theme]`. Status colours (ok green, short/over amber, fail
red) each have a light and a dark value with at least 4.5:1 text contrast, and always pair with a
word and an icon. Target bars use the accent for the value and a hatched band for the target range
so they read in both themes and in greyscale. Tap targets at least 40 px; chips wrap.

## 6. Edge cases

- Long or odd recipe names (`Now don't go "EEEWWW!!" before you try this!`): text only, never HTML;
  clamp to 2 lines with full name on the card's title attribute.
- The same recipe in two meals of a day: shown in each column.
- A recipe in the result that is not in the loaded cookbook (file replaced mid-run): error state
  "The recipe file changed during the run. Run again."
- Score 1 with `worst == score`: no "points" wording (3.9).
- Tastes that match nothing: the chip shows "matches 0" and is greyed; allowed.
- Very large cookbooks: parse once; tag picker virtualized past 300 tags.
- A day with one meal only: fine; columns collapse to one.
- `host.theme` mid-run: re-applies, no re-render of data.
- Run started then panel switched to the other mode: switching is disabled while running.

## 7. Build notes

- `app.js` composes its own layout instead of `chatLayout`; reuses `h`, `applyTheme`,
  `runControls` (or the same start/cancel logic), `chatPanel`, and the bridge client. No
  `schemaForm`, no `toolItem`, no `filesPanel` in the main view.
- New files under `ui/`: `cookbook.js` (load/validate, `matches`, `liked`, totals ports),
  `request.js` (form and argument builders), `result.js` (verdict, dish cards, bars), `presets.js`
  (food groups, target presets, restriction toggles). All static.
- Tests: the ports of `matches`/`liked`/totals must agree with Python on
  `tests/fixtures/recipes.json`; a builder checks this by hand against `list_recipes` output (no
  test runner for `ui/` exists today).

## 8. Risks and dependencies

- **Recipe format churn (code-55).** The page reads `Cookbook` fields directly: `source`,
  `recipes{name: {url, meals, tags, servings, per_serving{9 nutrients}, ingredients, steps}}`. Any
  rename breaks 3.2's validation (it fails loudly by design) and the ports in `cookbook.js`.
- **Reference tool and staging on the web path.** `web/app.py` passes `stage=lambda _: None`, and
  `run_task` runs the reference tool (`solve` / `solve_day`) in an empty scratch folder; `solve`
  then cannot find `inputs/recipes.json`. If that holds, every web run ends in `task.error` before
  the agent starts. Needs a NanoAgent fix (copy the workspace's input files into the scratch
  folder) outside this plugin.
- **Matching rule drift.** The page's `liked()` port must stay identical to
  `src/plugin/meals.py`; otherwise chips disagree with the verdict.
- **Links.** The sandbox has no `allow-popups`; Food.com links cannot open. The page shows
  copyable addresses; the host could add `allow-popups` later.
- **Agent quality on large lists.** Without "Healthy" or similar, a meal can have 150+ eligible
  recipes; runs are slow (step 3 took about 5 minutes) and may land below the best. The progress
  view and the "best-liked option" alternative cover it; the restriction count nudges users toward
  narrower lists.
- **Ingredient-only likes.** Food.com ingredient lines lack quantities, and likes match words, so
  "Avoid" is soft; copy says so.

## 9. As built (Oct 8)

Built on the shared kit (`ui/kit/`) with `app.js`, `cookbook.js`, `request.js`, `result.js` and
`presets.js`, against `contract.py` as of Oct 7 16:51 (restrictions, likes, `score`/`worst`/`scores`,
`plan-day`). Differences from the plan above:

- The run button sits in a bar at the bottom of the request card that stays in view while the
  long form scrolls (the kit's narrow sticky bar, and the same on wide screens).
- After any run, including a failed or stopped one, narrow screens show the outcome first with the
  request folded into its summary card.
- "No combination hits all your targets": when the page finds a target pair no mix of servings can
  meet (e.g. "within 700 kcal, these breakfasts give at most about 24.2 g of protein"), it says so
  and does not offer "Allow more servings", which could not help; without such a hint it offers it.
- After a failure the retry button reads "Try again"; after a valid result, "Try another". Errors
  the same request would hit again (no combination fits, no recipe fits, a bad target, a refused
  request) offer "Edit my request" without a plain retry.
- The setup card (3.2) sits above the request and the result, so on narrow screens a first visit
  starts with adding the recipes rather than below the long form.
- Checked by hand: the `matches`/`liked` ports agree with `src/plugin/meals.py` on every recipe of
  the Food.com build for every food group and restriction toggle, and the arguments the page
  builds from the saved requests equal the recorded runs' `step2_suggest_meal_arguments.json` and
  `step3_plan_day_arguments.json` and validate as `SolveInput` / `DayInput`.
