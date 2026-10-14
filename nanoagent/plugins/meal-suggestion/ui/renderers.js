// How Meal Suggestion's page draws its meals: each dish as a recipe card, its Food.com link, its
// servings and the likes (or dislikes) it matches, over the meal's totals.

import { h, plural, statusPill } from "./kit/components.js";

// contract.Nutrition's fields, as the totals line names them.
const NUTRIENTS = [
  ["kcal", "Calories", "kcal"],
  ["protein", "Protein", "g"],
  ["fat", "Fat", "g"],
  ["saturated_fat", "Saturated fat", "g"],
  ["carbs", "Carbs", "g"],
  ["fiber", "Fiber", "g"],
  ["sugar", "Sugar", "g"],
  ["sodium", "Sodium", "mg"],
  ["cholesterol", "Cholesterol", "mg"],
];
const MEALS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" };

const amount = (value) => Math.round(value * 10) / 10;
const totalsLine = (label, totals) =>
  h("p", { class: "muted small-text", text: `${label}: ${NUTRIENTS.map(([key, name, unit]) => `${name} ${amount(totals[key])} ${unit}`).join(" · ")}` });

function dishes(meal) {
  return h(
    "ol",
    { class: "ms-dishes" },
    meal.dishes.map((dish) =>
      h(
        "li",
        { class: "ms-dish" },
        h("div", { class: "ms-dish-head" }, h("a", { href: dish.url, target: "_blank", rel: "noopener noreferrer", text: dish.recipe }), h("span", { class: "muted", text: plural(dish.servings, "serving") })),
        dish.liked.length ? h("p", { class: "ms-liked" }, dish.liked.map((name) => statusPill(name, "neutral"))) : null,
      ),
    ),
  );
}

const meal = (value) => h("div", { class: "stack" }, dishes(value), totalsLine("Meal total", value.totals));

export default {
  SolveOutput: (value) =>
    h("div", { class: "stack" }, meal(value), h("p", { class: "muted small-text", text: `Preference score ${value.score}, the best within your targets (the least-liked meal scores ${value.lowest_score})` })),
  Suggestion: meal,
  DayPlan: (value) =>
    h(
      "div",
      { class: "stack" },
      Object.entries(value.meals).map(([name, plan]) => h("section", { class: "stack" }, h("h4", { text: MEALS[name] }), meal(plan))),
      totalsLine("Day total", value.totals),
    ),
};
