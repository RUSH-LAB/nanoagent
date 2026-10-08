// The result: the verdict in plain words, dish cards, totals against the targets, the chef's
// note, and plain-words errors with hints computed from the recipes. Everything is computed from
// the verdict and the recipe collection; names and steps are always text, never HTML.

import { banner, copyField, disclosure, h, icon, meter, plural, statusPill, verdictBanner } from "./kit/components.js";
import { eligible, liked, totals } from "./cookbook.js";
import { MEALS, MEAL_WORDS, NUTRIENT, NUTRIENTS, friendlyTags } from "./presets.js";
import { heart } from "./request.js";

const EPSILON = 1e-6; // verifier/meals.py's slack for float sums
const number = (value) => new Intl.NumberFormat("en-US", { maximumFractionDigits: Math.abs(value) < 100 ? 1 : 0 }).format(value);
const amount = (key, value) => `${number(value)} ${NUTRIENT[key].unit}`;

// -- Chef's note: the agent's report, a small safe subset of Markdown as text ----------------------

function inline(text) {
  return text.split(/(\*\*[^*]+\*\*)/).map((part) => (part.startsWith("**") && part.endsWith("**") && part.length > 4 ? h("strong", { text: part.slice(2, -2) }) : part));
}

/** Paragraphs, "- " lists, **bold** and pipe tables, built as text nodes. */
export function noteText(text) {
  const out = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; ) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
    } else if (line.startsWith("|")) {
      const rows = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) rows.push(lines[index++].trim());
      const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      const body = rows.filter((row) => !/^\|[\s:|-]+\|$/.test(row));
      const [head, ...rest] = body;
      out.push(h("div", { class: "ms-note-table" }, h("table", {}, h("thead", {}, h("tr", {}, cells(head).map((cell) => h("th", {}, inline(cell))))), h("tbody", {}, rest.map((row) => h("tr", {}, cells(row).map((cell) => h("td", {}, inline(cell)))))))));
    } else if (/^[-*] /.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*] /.test(lines[index].trim())) items.push(lines[index++].trim().slice(2));
      out.push(h("ul", {}, items.map((item) => h("li", {}, inline(item)))));
    } else {
      out.push(h("p", {}, inline(line)));
      index += 1;
    }
  }
  return h("div", { class: "ms-note" }, out);
}

// -- Totals against targets --------------------------------------------------------------------

/** Whether a total meets a bound, and how far off it is in words. */
export function boundStatus(key, value, { min, max }) {
  if (min !== null && value < min - EPSILON) return { ok: false, words: `${amount(key, min - value)} short of your ${amount(key, min)} minimum` };
  if (max !== null && value > max + EPSILON) return { ok: false, words: `${amount(key, value - max)} over your ${amount(key, max)} limit` };
  if (min !== null && max !== null) return { ok: true, words: `Within your ${number(min)}–${amount(key, max)} range` };
  return { ok: true, words: min !== null ? `Meets your ${amount(key, min)} minimum` : `Under your ${amount(key, max)} limit` };
}

/** One bar per target, the value against its band, and the untargeted nutrients as numbers. */
export function targetBars(sums, bounds, { title = "Totals vs your targets", more = true } = {}) {
  const keys = NUTRIENTS.map((one) => one.key).filter((key) => bounds[key]);
  const bars = keys.map((key) => {
    const bound = bounds[key];
    const value = sums[key];
    const top = Math.max(value, bound.max ?? bound.min ?? 0) * 1.25 || 1;
    const status = boundStatus(key, value, bound);
    return h(
      "li",
      { class: `ms-bar${status.ok ? "" : " off"}` },
      meter({ label: NUTRIENT[key].label, value, min: 0, max: top, band: [bound.min, bound.max], tone: status.ok ? "ok" : "bad", valueText: amount(key, value) }),
      h("p", { class: `ms-bar-status ${status.ok ? "tone-ok" : "tone-bad"}` }, icon(status.ok ? "check" : "alert", { size: 14 }), status.words),
    );
  });
  const rest = NUTRIENTS.filter((one) => !bounds[one.key]);
  return h(
    "section",
    { class: "ms-totals" },
    title ? h("h3", { class: "ms-section-title", text: title }) : null,
    keys.length ? h("ul", { class: "ms-bars" }, bars) : h("p", { class: "muted small-text", text: "You set no targets, so any totals are fine." }),
    more && rest.length
      ? disclosure(
          { summary: keys.length ? "More nutrients" : "Nutrients", hint: rest.map((one) => one.label.toLowerCase()).slice(0, 3).join(", ") + (rest.length > 3 ? "…" : ""), open: !keys.length },
          h("dl", { class: "ms-nutrients" }, rest.map((one) => [h("dt", { text: one.label }), h("dd", { class: "numeric", text: amount(one.key, sums[one.key]) })])),
        )
      : null,
  );
}

// -- Dish cards ----------------------------------------------------------------------------------

/** One dish: name, servings, its nutrition, the tastes it matches, and its recipe. */
export function dishCard(cookbook, dish, likes, { compact = false } = {}) {
  const recipe = cookbook.recipes[dish.recipe];
  const sums = totals(cookbook, [dish]);
  const matched = new Set(liked(recipe, likes));
  const tastes = likes.filter((like) => matched.has(like.name));
  const facts = h("p", { class: "ms-dish-facts numeric" }, h("span", { class: "ms-servings", text: dish.servings === 1 ? "1 serving" : `${dish.servings} servings` }), h("strong", { text: amount("kcal", sums.kcal) }), ` · ${amount("protein", sums.protein)} protein`);
  const recipeBox = disclosure(
    { summary: "Recipe", hint: `makes ${plural(recipe.servings, "serving")}`, className: "ms-recipe" },
    h("h4", { text: "Ingredients" }),
    h("ul", { class: "ms-ingredients" }, recipe.ingredients.map((item) => h("li", { text: item }))),
    h("h4", { text: "Steps" }),
    h("ol", { class: "ms-steps" }, recipe.steps.map((item) => h("li", { text: item }))),
    copyField({ label: "Recipe page", value: recipe.url }),
  );
  return h(
    "article",
    { class: `ms-dish${compact ? " compact" : ""}` },
    h("h4", { class: "ms-dish-name", title: dish.recipe, text: dish.recipe }),
    facts,
    tastes.length || !compact
      ? h(
          "ul",
          { class: "ms-dish-tags" },
          tastes.map((like) => h("li", { class: `ms-taste ${like.weight < 0 ? "avoid" : "like"}`, title: like.weight < 0 ? `Has ${like.name}, which you avoid` : `Has ${like.name}` }, like.weight < 0 ? icon("minus", { size: 13 }) : heart(), like.weight < 0 ? `has ${like.name}` : like.name)),
          compact ? null : friendlyTags(recipe.tags).map((tag) => h("li", { class: "ms-label", text: tag })),
        )
      : null,
    recipeBox,
  );
}

// -- Verdict words --------------------------------------------------------------------------------

const PROBLEM = /^(\w+) is ([\d.]+), (below the minimum|above the maximum) ([\d.e+-]+)$/;

/** A verifier problem line in plain words. */
export function problemWords(line) {
  const prefixed = line.match(/^(breakfast|lunch|dinner|day): (.*)$/);
  const where = prefixed ? (prefixed[1] === "day" ? "Whole day" : MEAL_WORDS[prefixed[1]].one) : null;
  const text = prefixed ? prefixed[2] : line;
  let words;
  const found = text.match(PROBLEM);
  if (found && NUTRIENT[found[1]]) {
    const [, key, value, side, limit] = found;
    words = `${NUTRIENT[key].label} is ${amount(key, Number(value))}, ${side === "below the minimum" ? `under your ${amount(key, Number(limit))} minimum` : `over your ${amount(key, Number(limit))} limit`}`;
  } else if (/^'.*' is not a recipe$|^".*" is not a recipe$/.test(text)) {
    words = `${text.slice(1, text.lastIndexOf(" is not") - 1)} isn’t in your recipe collection`;
  } else if (/ is listed twice$/.test(text)) {
    words = `${text.replace(/ is listed twice$/, "")} is listed twice`;
  } else if (/ is not a (breakfast|lunch|dinner) recipe that meets the restrictions$/.test(text)) {
    words = text.replace(/ is not a (\w+) recipe that meets the restrictions$/, (_, meal) => ` isn’t a ${meal} that fits how you eat`);
  } else if (/: servings must be a whole number from 1 to (\d+)$/.test(text)) {
    words = text.replace(/: servings must be a whole number from 1 to (\d+)$/, (_, most) => `: more servings than you allowed (at most ${most})`);
  } else if (text === "the meal has no dishes") {
    words = "No dishes were chosen";
  } else if (/^the day's meals must be exactly/.test(text)) {
    words = "The plan doesn’t have exactly the meals you asked for";
  } else {
    words = text.charAt(0).toUpperCase() + text.slice(1);
  }
  return where ? `${where}: ${words.charAt(0).toLowerCase()}${words.slice(1)}` : words;
}

/** The verdict banner's words for this page. */
function verdictWords(verdict, likes, { onBest, what }) {
  const details = verdict.details ?? {};
  if (verdict.valid) {
    const optimum = details.optimum;
    let body;
    let actions = [];
    if (!likes.some((like) => like.weight !== 0)) body = `You named no tastes, so any ${what} that fits is as good as this one.`;
    else if (optimum && Math.abs(optimum.score - optimum.worst) <= 1e-3) body = `Every ${what} that fits suits your tastes equally.`;
    else if (verdict.score >= 1 - 1e-6) body = `It matches your tastes as well as any ${what} that fits can.`;
    else {
      body = "A good fit, though another choice that fits matches your tastes better.";
      if (optimum) actions = [h("button", { type: "button", class: "button small", onclick: onBest }, icon("spark", { size: 15 }), "See the best-liked option")];
    }
    return { tone: "ok", title: "Fits every target and how you eat", body, score: "", actions };
  }
  const problems = details.problems ?? [];
  const lines = problems.length
    ? problems.map(problemWords)
    : /^no (suggestion|plan) at/.test(verdict.message ?? "")
      ? ["The chef finished without writing down a meal."]
      : /reference is wrong/.test(verdict.message ?? "")
        ? ["Something went wrong on our side while grading it."]
        : [];
  return { tone: "warn", title: "This suggestion didn’t pass the check", body: "Every total was recomputed from your recipes, and this is what failed:", lines, score: "" };
}

const CHECKED = "Checked by recomputing every total from your recipe file.";

/**
 * The whole result of a run (or a chat-made meal, `checked: false`).
 * @param {object} options
 * @param {object} options.cookbook
 * @param {{task: string, arguments: object}} options.request What was asked (taskOf at the start).
 * @param {object|null} options.verdict The task.verdict, or null for an unchecked chat-made plan.
 * @param {Array|Object|null} options.plan Dishes (a meal) or meal -> dishes (a day); null when none was written.
 * @param {string|null} options.answer The chef's note.
 * @param {Node[]} options.actions Buttons under the result.
 */
export function resultView({ cookbook, request, verdict, plan, answer, actions = [], heading }) {
  const args = request.arguments;
  const day = request.task === "plan-day";
  const alternative = h("div", { class: "ms-alternative", hidden: true });
  const showBest = () => {
    const optimum = verdict.details.optimum;
    alternative.replaceChildren(
      h("h3", { class: "ms-section-title", text: "The best-liked option" }),
      h("p", { class: "muted small-text", text: "Found by the planner’s own solver; it also fits every target." }),
      day ? dayColumns(cookbook, optimum.plan, args) : dishGrid(cookbook, optimum.plan, args.likes),
    );
    alternative.hidden = false;
    alternative.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const status = verdict
    ? verdictBanner(verdict, (one) => verdictWords(one, args.likes, { onBest: showBest, what: day ? "day" : "meal" }))
    : banner({ tone: "info", title: "Not checked yet: the chef changed this in chat", body: "The totals below are computed from your recipes. Run a new suggestion to get one that is checked." });
  const every = !plan ? [] : day ? MEALS.filter((meal) => plan[meal]).flatMap((meal) => plan[meal]) : plan;
  const sums = verdict?.details?.totals ?? totals(cookbook, every);
  return h(
    "div",
    { class: "ms-result" },
    heading ? h("h2", { class: "ms-result-title", text: heading }) : null,
    status,
    verdict ? h("p", { class: "muted small-text ms-checked" }, icon("check", { size: 14 }), CHECKED) : null,
    plan ? (day ? dayColumns(cookbook, plan, args) : dishGrid(cookbook, plan, args.likes)) : null,
    plan ? targetBars(sums, day ? args.day : args.constraints, { title: day ? "Day totals vs your targets" : "Totals vs your targets" }) : null,
    alternative,
    answer ? disclosure({ summary: "Chef’s note", hint: "how the chef chose", className: "ms-chef" }, noteText(answer)) : null,
    actions.length ? h("div", { class: "ms-actions" }, actions) : null,
  );
}

function dishGrid(cookbook, dishes, likes) {
  return h("div", { class: "ms-dishes" }, dishes.map((dish) => dishCard(cookbook, dish, likes)));
}

function dayColumns(cookbook, meals, args) {
  const order = MEALS.filter((meal) => meals[meal]);
  return h(
    "div",
    { class: `ms-day cols-${order.length}` },
    order.map((meal) => {
      const dishes = meals[meal];
      const sums = totals(cookbook, dishes);
      const bounds = args.meals[meal] ?? {};
      const met = Object.entries(bounds).every(([key, bound]) => boundStatus(key, sums[key], bound).ok);
      return h(
        "section",
        { class: "ms-day-meal", "aria-label": MEAL_WORDS[meal].one },
        h("header", { class: "ms-day-head" }, h("h3", { text: MEAL_WORDS[meal].one }), h("span", { class: "ms-day-kcal numeric", text: amount("kcal", sums.kcal) })),
        h("p", { class: "muted small-text numeric", text: `${amount("protein", sums.protein)} protein · ${amount("fiber", sums.fiber)} fiber · ${plural(dishes.length, "dish", "dishes")}` }),
        Object.keys(bounds).length ? h("div", {}, statusPill(met ? "Meets this meal’s targets" : "Misses this meal’s targets", met ? "ok" : "bad", { icon: true })) : null,
        dishes.map((dish) => dishCard(cookbook, dish, args.likes, { compact: true })),
        Object.keys(bounds).length ? targetBars(sums, bounds, { title: "", more: false }) : null,
      );
    }),
  );
}

// -- While it runs and before anything ran ---------------------------------------------------------

/** Placeholder dish cards: shimmering while running, still before the first run. */
export function placeholderDishes({ running }) {
  return h(
    "div",
    { class: `ms-dishes ms-placeholder${running ? " running" : ""}`, "aria-hidden": "true" },
    [0, 1, 2].map(() => h("div", { class: "ms-dish ghost" }, h("span", { class: "ms-ghost-line wide" }), h("span", { class: "ms-ghost-line" }), h("span", { class: "ms-ghost-chips" }, h("span"), h("span")))),
  );
}

// -- Errors ------------------------------------------------------------------------------------------

/**
 * Why no combination fits, from the recipes: for each "at least" target paired with an "at most"
 * one, the most the fitting recipes can give within the limit (the best ratio of the two, so an
 * upper bound: whole servings only lower it); and any limit even the lightest serving breaks.
 */
export function infeasibleHints(cookbook, request) {
  const args = request.arguments;
  const day = request.task === "plan-day";
  const meals = day ? Object.keys(args.meals) : [args.meal];
  const bounds = day ? args.day : args.constraints;
  const names = [...new Set(meals.flatMap((meal) => eligible(cookbook, meal, args.restrictions)))];
  const per = names.map((name) => cookbook.recipes[name].per_serving);
  const where = day ? "these recipes" : `these ${MEAL_WORDS[args.meal].many}`;
  const hints = [];
  for (const [key, bound] of Object.entries(bounds)) {
    if (bound.max === null) continue;
    const lightest = Math.min(...per.map((one) => one[key]));
    if (!day && lightest > bound.max + EPSILON) hints.push({ gap: Infinity, text: `${NUTRIENT[key].label}: even the lightest of ${where} has ${amount(key, lightest)} a serving, over your at most ${amount(key, bound.max)}.` });
  }
  for (const [want, low] of Object.entries(bounds)) {
    if (low.min === null) continue;
    for (const [limit, high] of Object.entries(bounds)) {
      if (limit === want || high.max === null) continue;
      if (per.some((one) => one[limit] <= 0 && one[want] > 0)) continue;
      const ratio = Math.max(...per.map((one) => one[want] / one[limit]));
      const most = high.max * ratio;
      if (most < low.min - EPSILON) {
        hints.push({
          gap: (low.min - most) / low.min,
          text: `Within ${amount(limit, high.max)}${limit === "kcal" ? "" : ` of ${NUTRIENT[limit].label.toLowerCase()}`}, ${where} give at most about ${amount(want, most)} of ${NUTRIENT[want].label.toLowerCase()}; you asked for at least ${amount(want, low.min)}.`,
        });
      }
    }
  }
  return hints.sort((x, y) => y.gap - x.gap).slice(0, 2).map((hint) => hint.text);
}

/** The page's error rules for explainError, tried before the kit's. */
export function errorRules({ cookbookLoaded, meal }) {
  return [
    { id: "infeasible", match: /no (breakfast|lunch|dinner|day) of whole servings meets every constraint/, text: "No combination of these recipes hits all your targets." },
    { id: "restrictions", match: /no (breakfast|lunch|dinner) recipe meets the restrictions/, text: (_, found) => `No ${found[1]} recipe fits how you eat. Turn a rule off and try again.` },
    { id: "bounds", match: /min is above its max/, text: "One of your targets has its “at least” above its “at most”." },
    {
      id: "file",
      match: /no input file at|FileNotFoundError/,
      text: cookbookLoaded
        ? "The meal planner couldn’t open your recipe collection. Your file is in place; this is a problem on our side, so try again later."
        : "Your recipe collection is missing. Add it, then try again.",
    },
    { id: "input", match: /invalid input for task|input verification failed/, text: `The planner didn’t accept this ${meal} request. Check your targets and try again.` },
    { id: "cancelled", match: (message) => message === "cancelled", text: "Stopped. Your request is still here when you want to try again.", tone: "neutral" },
  ];
}
