// Meal Suggestion's page: pick a meal, set nutrient ranges and what you like, and get the recipes
// the recommend-meal task's linear program chooses from the built-in Food.com recipes.

import { appShell, mountApp } from "./kit/shell.js";
import { banner, card } from "./kit/display.js";
import { h } from "./kit/dom.js";
import { chipsInput, segmented } from "./kit/inputs.js";
import { runButton, taskRun } from "./kit/run.js";
import { writeText } from "./kit/workspace.js";
import cookbook from "./recipes.js";

const TASK = "recommend-meal";
// Where the task reads the recipes (its `recipes` argument), staged from the built-in copy.
const RECIPES_PATH = "inputs/recipes.json";
const MAX_SERVINGS = 2;
// Food.com files sweets under Lunch/Snacks too; a meal leaves them out.
const RESTRICTIONS = { require: [], exclude: ["Dessert"] };
const MEALS = [
  { value: "breakfast", label: "Breakfast" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
];
// contract.Nutrition's fields, and the ranges the page starts with.
const NUTRIENTS = [
  { key: "kcal", label: "Calories", unit: "kcal", max: 800 },
  { key: "protein", label: "Protein", unit: "g", min: 25 },
  { key: "fat", label: "Fat", unit: "g" },
  { key: "saturated_fat", label: "Saturated fat", unit: "g" },
  { key: "carbs", label: "Carbs", unit: "g" },
  { key: "fiber", label: "Fiber", unit: "g", min: 5 },
  { key: "sugar", label: "Sugar", unit: "g" },
  { key: "sodium", label: "Sodium", unit: "mg", max: 1500 },
  { key: "cholesterol", label: "Cholesterol", unit: "mg" },
];
// Words that stand for a food group, so "dairy" matches milk and cheese, and phrases that look like
// the group but are not (peanut butter is not dairy). Any other word stands for itself.
const GROUPS = {
  dairy: {
    words: ["milk", "cheese", "yogurt", "butter", "cream"],
    ignore: ["peanut butter", "almond butter", "apple butter", "coconut milk", "coconut cream", "almond milk", "soy milk", "cream of tartar"],
  },
  meat: { words: ["beef", "pork", "chicken", "turkey", "lamb", "bacon", "ham", "sausage", "steak"], ignore: ["chicken broth", "beef broth"] },
  seafood: { words: ["fish", "salmon", "tuna", "shrimp", "cod", "crab", "tilapia"], ignore: [] },
  chocolate: { words: ["chocolate", "cocoa"], ignore: [] },
  eggs: { words: ["egg"], ignore: [] },
  mushrooms: { words: ["mushroom"], ignore: [] },
};

/** A like (contract.Like) for a word the eater typed, weighted +1 for a like and -1 for a dislike. */
function likeOf(word, weight) {
  const name = word.trim().toLowerCase();
  const group = GROUPS[name] ?? { words: [name], ignore: [] };
  return { name, words: group.words, ignore: group.ignore, weight };
}

function rangeRow(nutrient) {
  const box = (value, which) =>
    h("input", { type: "number", min: "0", step: "any", inputmode: "decimal", value: value ?? "", placeholder: which, "aria-label": `${nutrient.label} ${which}` });
  const min = box(nutrient.min, "min");
  const max = box(nutrient.max, "max");
  const element = h("tr", {}, h("th", { scope: "row", text: nutrient.label }), h("td", {}, min), h("td", {}, max), h("td", { class: "muted", text: nutrient.unit }));
  const read = (input) => (input.value.trim() === "" ? null : Number(input.value));
  return { nutrient, element, inputs: [min, max], bound: () => ({ min: read(min), max: read(max) }) };
}

/** Why the request cannot run yet, or null. */
function problemOf(rows) {
  for (const row of rows) {
    const { min, max } = row.bound();
    if ([min, max].some((value) => value !== null && !(Number.isFinite(value) && value >= 0))) return `${row.nutrient.label} must be a number of 0 or more.`;
    if (min !== null && max !== null && min > max) return `${row.nutrient.label}'s min is above its max.`;
  }
  return null;
}

function amount(value, unit) {
  return `${Math.round(value * 10) / 10} ${unit}`;
}

function resultView(response, meal, likes) {
  const recipes = cookbook.recipes;
  const items = response.plan.map((dish) => {
    const recipe = recipes[dish.recipe];
    const per = recipe.per_serving;
    const matched = likes.filter((like) => like.weight > 0 && matches(recipe, like));
    return h(
      "li",
      { class: "ms-dish" },
      h("div", { class: "ms-dish-head" }, h("a", { href: recipe.url, target: "_blank", rel: "noopener", text: dish.recipe }), h("span", { class: "ms-servings", text: `${dish.servings} serving${dish.servings === 1 ? "" : "s"}` })),
      h("p", { class: "muted small-text", text: `Per serving: ${amount(per.kcal, "kcal")} · ${amount(per.protein, "g")} protein · ${amount(per.fiber, "g")} fiber` }),
      matched.length ? h("p", { class: "ms-liked" }, ...matched.map((like) => h("span", { class: "chip static", text: like.name }))) : null,
    );
  });
  const totals = NUTRIENTS.map((one) => `${one.label} ${amount(response.totals[one.key], one.unit)}`).join(" · ");
  return card({ title: `Recommended for ${meal}`, subtitle: `Preference score ${response.score} (the best within your ranges)` }, h("ol", { class: "ms-dishes" }, items), h("p", { class: "muted small-text", text: `Meal total: ${totals}` }));
}

/** meals.py `liked` for one like: one of its words (or its plural) as a word of an ingredient or tag, outside its ignored phrases. */
function matches(recipe, like) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...recipe.ingredients, ...recipe.tags].some((text) => {
    let rest = text.toLowerCase();
    for (const phrase of like.ignore) rest = rest.replace(new RegExp(`\\b${escape(phrase.toLowerCase())}\\b`, "g"), " ");
    return like.words.some((word) => new RegExp(`\\b${escape(word.toLowerCase())}(?:s|es)?\\b`).test(rest));
  });
}

async function page({ plugin }) {
  let meal = "lunch";
  let staged = false;
  const rows = NUTRIENTS.map(rangeRow);
  const mealPicker = segmented({ label: "Meal", options: MEALS, value: meal, onChange: (value) => ((meal = value), update()) });
  const likes = chipsInput({ label: "I like", placeholder: "dairy, chocolate, beans…", hint: "Food groups (dairy, meat, seafood, eggs) or any ingredient word." });
  const dislikes = chipsInput({ label: "I don't like", placeholder: "mushrooms…" });
  const table = h(
    "table",
    { class: "ms-ranges" },
    h("thead", {}, h("tr", {}, h("th", { text: "Nutrient" }), h("th", { text: "Min" }), h("th", { text: "Max" }), h("th", {}))),
    h("tbody", {}, rows.map((row) => row.element)),
  );
  const output = h("div", { class: "stack" });
  const run = taskRun({ task: TASK, title: "Finding your recipes" });
  const button = runButton({ label: "Recommend recipes", run, block: true, onClick: () => recommend() });

  function update() {
    button.setLabel(`Recommend ${MEALS.find((one) => one.value === meal).label.toLowerCase()} recipes`);
    button.setBlocked(problemOf(rows));
  }
  for (const row of rows) for (const input of row.inputs) input.addEventListener("input", update);

  async function recommend() {
    const chosen = [...likes.values().map((word) => likeOf(word, 1)), ...dislikes.values().map((word) => likeOf(word, -1))];
    const constraints = Object.fromEntries(
      rows.map((row) => [row.nutrient.key, row.bound()]).filter(([, bound]) => bound.min !== null || bound.max !== null),
    );
    output.replaceChildren();
    if (!staged) {
      await writeText(RECIPES_PATH, JSON.stringify(cookbook));
      staged = true;
    }
    const outcome = await run.start({
      recipes: RECIPES_PATH,
      meal,
      constraints,
      restrictions: RESTRICTIONS,
      likes: chosen,
      max_servings: MAX_SERVINGS,
    });
    if (outcome.status === "cancelled") return;
    run.hide();
    if (outcome.result) {
      output.replaceChildren(resultView(outcome.result, meal, chosen));
    } else {
      const none = /meets every constraint/.test(outcome.error ?? "");
      output.replaceChildren(
        banner({
          tone: none ? "warn" : "bad",
          title: none ? `No ${meal} fits these ranges` : "Something went wrong",
          body: none ? "Widen a range (a lower min or a higher max) and try again." : outcome.error ?? "The run ended without recipes.",
        }),
      );
    }
  }

  update();
  const form = card(
    { title: "Your meal", subtitle: `From ${Object.keys(cookbook.recipes).length} Food.com recipes, desserts left out. Leave a box empty for no limit.` },
    mealPicker.element,
    table,
    likes.element,
    dislikes.element,
    button.element,
  );
  const shell = appShell({ plugin, chat: false, width: "narrow" }, h("div", { class: "stack" }, form, run.element, output));
  return shell.element;
}

mountApp(page);
