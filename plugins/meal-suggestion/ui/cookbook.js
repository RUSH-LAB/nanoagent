// The recipe collection (contract.Cookbook) in the page: checking its shape, and ports of the
// plugin's own rules (src/plugin/meals.py: matches, liked, score; verifier/meals.py: totals) so the
// page can count fitting recipes, mark tastes and total a meal exactly as the verdict does.

import { MEALS, NUTRIENTS } from "./presets.js";

/** Where the tasks read the recipes (their `recipes` argument). */
export const RECIPES_PATH = "inputs/recipes.json";

const KEYS = NUTRIENTS.map((one) => one.key);
const isStringList = (value) => Array.isArray(value) && value.every((one) => typeof one === "string");

/**
 * Parse and check a recipes file as contract.Cookbook. Throws an Error in plain words naming the
 * first problem; never uses part of a file.
 * @param {string} text
 * @returns {{source: string, recipes: Object<string, object>}}
 */
export function parseCookbook(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("This isn't a JSON file. Choose the recipes.json the meal-suggestion example builds.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("This JSON isn't a recipe collection: it should hold a source and recipes.");
  if (typeof value.source !== "string") throw new Error("This recipe collection doesn't say where its recipes came from (source).");
  if (!value.recipes || typeof value.recipes !== "object" || Array.isArray(value.recipes)) throw new Error("This file has no recipes list.");
  const names = Object.keys(value.recipes);
  if (!names.length) throw new Error("This recipe collection is empty.");
  for (const name of names) {
    const recipe = value.recipes[name];
    const say = (what) => new Error(`Recipe "${name}" ${what}.`);
    if (!recipe || typeof recipe !== "object") throw say("isn't a recipe");
    if (typeof recipe.url !== "string") throw say("has no address (url)");
    if (!Array.isArray(recipe.meals) || !recipe.meals.length || !recipe.meals.every((meal) => MEALS.includes(meal))) throw say("must be for breakfast, lunch or dinner (meals)");
    if (!isStringList(recipe.tags)) throw say("has no labels list (tags)");
    if (!Number.isInteger(recipe.servings) || recipe.servings < 1) throw say("must make at least one whole serving (servings)");
    if (!recipe.per_serving || typeof recipe.per_serving !== "object") throw say("has no nutrition per serving");
    for (const key of KEYS) {
      const amount = recipe.per_serving[key];
      if (typeof amount !== "number" || !Number.isFinite(amount)) throw say(`has no per_serving.${key}`);
      if (amount < 0) throw say(`has a negative per_serving.${key}`);
    }
    if (!isStringList(recipe.ingredients)) throw say("has no ingredients list");
    if (!isStringList(recipe.steps)) throw say("has no steps list");
  }
  return value;
}

/** What a cookbook holds, for the page's summary line: its recipes, and how many are for each meal. */
export function describeCookbook(cookbook) {
  const meals = Object.fromEntries(MEALS.map((meal) => [meal, 0]));
  for (const recipe of Object.values(cookbook.recipes)) for (const meal of recipe.meals) meals[meal] += 1;
  return { count: Object.keys(cookbook.recipes).length, meals };
}

/** meals.py `matches`: for the meal, every required tag, no excluded one. */
export function matches(recipe, meal, restrictions) {
  const tags = new Set(recipe.tags);
  return recipe.meals.includes(meal) && restrictions.require.every((tag) => tags.has(tag)) && !restrictions.exclude.some((tag) => tags.has(tag));
}

/** The names of the recipes for `meal` that meet the restrictions, sorted as Python sorts them. */
export function eligible(cookbook, meal, restrictions) {
  return Object.keys(cookbook.recipes)
    .filter((name) => matches(cookbook.recipes[name], meal, restrictions))
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

// Python's `\b` on str: a boundary between a Unicode word character and anything else.
const WORD = "[\\p{L}\\p{N}_]";
const B = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

function mentions(text, like) {
  let rest = text;
  for (const phrase of like.ignore) rest = rest.replace(new RegExp(`${B}${escape(phrase.trim().toLowerCase())}${B}`, "gu"), " ");
  return like.words.some((word) => new RegExp(`${B}${escape(word.trim().toLowerCase())}(?:s|es)?${B}`, "u").test(rest));
}

/** meals.py `liked`: the names of the likes the recipe matches, in the likes' order. */
export function liked(recipe, likes) {
  const texts = [...recipe.ingredients, ...recipe.tags].map((text) => text.toLowerCase());
  return likes.filter((like) => texts.some((text) => mentions(text, like))).map((like) => like.name);
}

/** meals.py `score`: the sum of the weights of the likes the recipe matches. */
export function score(recipe, likes) {
  const matched = new Set(liked(recipe, likes));
  return likes.filter((like) => matched.has(like.name)).reduce((sum, like) => sum + like.weight, 0);
}

/** verifier/meals.py `totals`: servings x per serving, summed over the dishes. */
export function totals(cookbook, dishes) {
  const sum = Object.fromEntries(KEYS.map((key) => [key, 0]));
  for (const dish of dishes) {
    const recipe = cookbook.recipes[dish.recipe];
    for (const key of KEYS) sum[key] += dish.servings * recipe.per_serving[key];
  }
  return sum;
}

/** The dishes' recipes that are not in the cookbook (the file changed during a run). */
export const missingRecipes = (cookbook, dishes) => dishes.map((dish) => dish.recipe).filter((name) => !(name in cookbook.recipes));
