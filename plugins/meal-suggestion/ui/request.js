// The request panel: which meal (or day), how you eat, tastes, targets and servings, kept in one
// plain state object (saved to the workspace by app.js), and the builders that turn it into
// exactly contract.SolveInput / contract.DayInput.

import { chipRow, chipToggles, disclosure, h, icon, numberStepper, plural, segmented } from "./kit/components.js";
import { RECIPES_PATH, eligible, liked } from "./cookbook.js";
import { FOOD_GROUPS, LEVELS, MEALS, MEAL_WORDS, NUTRIENT, NUTRIENTS, PRESETS, RULES, WEIGHT, isListedTag, presetRows } from "./presets.js";

/** The meal people most likely plan now, by the local clock. */
export function mealByClock(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  return minutes < 10 * 60 + 30 ? "breakfast" : minutes < 15 * 60 ? "lunch" : "dinner";
}

const asText = (rows) => rows.map((row) => ({ nutrient: row.nutrient, min: row.min === null ? "" : String(row.min), max: row.max === null ? "" : String(row.max) }));

/** A fresh request: meal by the clock, no rules, no tastes, Balanced targets. */
export function defaultState() {
  const meal = mealByClock();
  return {
    version: 1,
    mode: "meal",
    meal,
    dayMeals: [...MEALS],
    rules: [],
    tags: {},
    likes: [],
    targets: {
      meal: { preset: "balanced", rows: asText(presetRows("balanced", "meal", meal)) },
      day: { preset: "balanced", rows: asText(presetRows("balanced", "day")) },
      perMeal: { breakfast: [], lunch: [], dinner: [] },
    },
    servings: { meal: 2, day: 1 },
  };
}

/** Throws unless `value` is a saved request this page wrote (meal-suggestion/profile.json). */
export function checkState(value) {
  const rowsOk = (rows) => Array.isArray(rows) && rows.every((row) => row && NUTRIENT[row.nutrient] && typeof row.min === "string" && typeof row.max === "string");
  const ok =
    ["meal", "day"].includes(value.mode) &&
    MEALS.includes(value.meal) &&
    Array.isArray(value.dayMeals) && value.dayMeals.every((meal) => MEALS.includes(meal)) &&
    Array.isArray(value.rules) && value.rules.every((id) => RULES.some((rule) => rule.id === id)) &&
    value.tags && typeof value.tags === "object" && Object.values(value.tags).every((how) => how === "require" || how === "exclude") &&
    Array.isArray(value.likes) && value.likes.every((like) => like && typeof like.name === "string" && Array.isArray(like.words) && Array.isArray(like.ignore) && WEIGHT[like.level] !== undefined) &&
    value.targets && rowsOk(value.targets.meal?.rows) && rowsOk(value.targets.day?.rows) && MEALS.every((meal) => rowsOk(value.targets.perMeal?.[meal])) &&
    Number.isInteger(value.servings?.meal) && Number.isInteger(value.servings?.day);
  if (!ok) throw new Error("it isn't a request this page saved");
  return value;
}

/** contract.Restrictions from the toggles and the extra labels. */
export function restrictionsOf(state) {
  const require = new Set();
  const exclude = new Set();
  for (const rule of RULES.filter((one) => state.rules.includes(one.id))) {
    for (const tag of rule.require ?? []) require.add(tag);
    for (const tag of rule.exclude ?? []) exclude.add(tag);
  }
  for (const [tag, how] of Object.entries(state.tags)) (how === "require" ? require : exclude).add(tag);
  return { require: [...require], exclude: [...exclude] };
}

/** contract.Like[] from the tastes. */
export const likesOf = (state) => state.likes.map(({ name, words, ignore, level }) => ({ name, words, ignore, weight: WEIGHT[level] }));

/** The meals a run covers, in day order. */
export const mealsOf = (state) => (state.mode === "meal" ? [state.meal] : MEALS.filter((meal) => state.dayMeals.includes(meal)));

/** A target row read: its numbers (null when blank) and a plain-words problem, if any. */
export function readRow(row) {
  const parse = (text) => {
    const clean = text.trim().replace(/,/g, "");
    if (!clean) return { value: null };
    const value = Number(clean);
    if (!Number.isFinite(value)) return { value: null, error: "Enter a number." };
    if (value < 0) return { value: null, error: "Use 0 or more." };
    return { value };
  };
  const min = parse(row.min);
  const max = parse(row.max);
  const error = min.error ?? max.error ?? (min.value !== null && max.value !== null && min.value > max.value ? "“At least” must not be above “at most”." : null);
  return { nutrient: row.nutrient, min: min.value, max: max.value, error, empty: min.value === null && max.value === null && !error };
}

/** contract's dict[Nutrient, Bound] from rows; blank rows are dropped. */
export function boundsOf(rows) {
  return Object.fromEntries(
    rows
      .map(readRow)
      .filter((row) => !row.empty && !row.error)
      .map((row) => [row.nutrient, { min: row.min, max: row.max }]),
  );
}

/** Every target row of the request. */
function allRows(state) {
  if (state.mode === "meal") return state.targets.meal.rows;
  return [...state.targets.day.rows, ...mealsOf(state).flatMap((meal) => state.targets.perMeal[meal])];
}

/** The task and its arguments, exactly its contract input. */
export function taskOf(state) {
  const common = { recipes: RECIPES_PATH };
  if (state.mode === "meal") {
    return {
      task: "suggest-meal",
      arguments: { ...common, meal: state.meal, constraints: boundsOf(state.targets.meal.rows), restrictions: restrictionsOf(state), likes: likesOf(state), max_servings: state.servings.meal },
    };
  }
  return {
    task: "plan-day",
    arguments: {
      ...common,
      meals: Object.fromEntries(mealsOf(state).map((meal) => [meal, boundsOf(state.targets.perMeal[meal])])),
      day: boundsOf(state.targets.day.rows),
      restrictions: restrictionsOf(state),
      likes: likesOf(state),
      max_servings: state.servings.day,
    },
  };
}

/** Why the request can't run yet, in plain words, or null. */
export function blockedReason(state, cookbook) {
  if (!cookbook) return "Add your recipe collection first.";
  const meals = mealsOf(state);
  if (!meals.length) return "Pick at least one meal.";
  const restrictions = restrictionsOf(state);
  const empty = meals.find((meal) => !eligible(cookbook, meal, restrictions).length);
  if (empty) return `No ${MEAL_WORDS[empty].lower} recipe fits how you eat. Turn a rule off.`;
  if (allRows(state).some((row) => readRow(row).error)) return "Fix the target marked in red first.";
  return null;
}

const fmt = (value) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);

/** One target in words: "Calories at most 800 kcal". */
export function boundWords(nutrient, { min, max }) {
  const { label, unit } = NUTRIENT[nutrient];
  if (min !== null && max !== null) return `${label} ${fmt(min)}–${fmt(max)} ${unit}`;
  return min !== null ? `${label} at least ${fmt(min)} ${unit}` : `${label} at most ${fmt(max)} ${unit}`;
}

/** The request in one line, for the narrow summary card and the chat's context. */
export function summaryOf(state) {
  const parts = [state.mode === "meal" ? MEAL_WORDS[state.meal].one : `A day: ${mealsOf(state).map((meal) => MEAL_WORDS[meal].lower).join(", ") || "no meals"}`];
  const rules = RULES.filter((rule) => state.rules.includes(rule.id)).map((rule) => rule.label.toLowerCase());
  const extra = Object.keys(state.tags).length;
  if (rules.length || extra) parts.push([...rules, extra ? plural(extra, "more label") : ""].filter(Boolean).join(", "));
  const targets = state.mode === "meal" ? Object.keys(boundsOf(state.targets.meal.rows)).length : Object.keys(boundsOf(state.targets.day.rows)).length;
  parts.push(targets ? plural(targets, "target") : "no targets");
  if (state.likes.length) parts.push(plural(state.likes.length, "taste"));
  return parts.join(" · ");
}

/** A small filled heart for liked foods (the kit has no heart icon). */
export const heart = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: 14, height: 14, class: "icon", fill: "currentColor", "aria-hidden": "true" })) svg.setAttribute(key, String(value));
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.4 4.5 6.9 4.5c2.1 0 3.6 1.1 5.1 3 1.5-1.9 3-3 5.1-3 3.5 0 5.5 3.5 4.2 6.8-1.8 4.6-9.3 9.2-9.3 9.2z");
  svg.append(path);
  return svg;
};

/**
 * The request form.
 * @param {{state: object, onChange: () => void, onReset: () => void}} options `onChange` after
 *   every edit (app.js saves nothing until a run, but updates the run button and summary).
 */
export function requestPanel({ state: initial, onChange, onReset }) {
  let state = initial;
  let cookbook = null;
  let live = [];
  let picker = null; // {level}: the taste row whose "Add" picker is open
  const form = h("fieldset", { class: "ms-form" });

  const changed = () => {
    for (const update of live) update();
    onChange();
  };
  const section = (title, ...children) => h("section", { class: "ms-section" }, h("h3", { class: "ms-section-title", text: title }), children);
  const eligibleNow = () => {
    if (!cookbook) return null;
    const restrictions = restrictionsOf(state);
    return Object.fromEntries(mealsOf(state).map((meal) => [meal, eligible(cookbook, meal, restrictions)]));
  };

  // -- Meal or meals --------------------------------------------------------------------------
  function mealSection() {
    if (state.mode === "meal") {
      const choice = segmented({
        label: "Meal",
        options: MEALS.map((meal) => ({ value: meal, label: MEAL_WORDS[meal].one })),
        value: state.meal,
        onChange: (meal) => {
          state.meal = meal;
          const targets = state.targets.meal;
          if (targets.preset !== "custom") targets.rows = asText(presetRows(targets.preset, "meal", meal));
          render();
          changed();
        },
      });
      live.push(() => {
        if (!cookbook) return;
        const restrictions = restrictionsOf(state);
        choice.setCounts(Object.fromEntries(MEALS.map((meal) => [meal, eligible(cookbook, meal, restrictions).length])));
      });
      return section("Your meal", choice.element, cookbook ? h("p", { class: "muted small-text", text: "The numbers are the recipes that fit how you eat." }) : null);
    }
    const toggles = chipToggles({
      label: "Meals of the day",
      options: MEALS.map((meal) => ({ value: meal, label: MEAL_WORDS[meal].one })),
      values: state.dayMeals,
      onChange: (values) => {
        state.dayMeals = values;
        render();
        changed();
      },
    });
    return section("Your day", toggles.element, state.dayMeals.length ? null : h("p", { class: "ms-warn small-text", role: "status" }, icon("alert", { size: 15 }), "Pick at least one meal."));
  }

  // -- How you eat ----------------------------------------------------------------------------
  function rulesSection() {
    const tags = cookbook ? new Set(Object.values(cookbook.recipes).flatMap((recipe) => recipe.tags)) : null;
    const shown = RULES.filter((rule) => !tags || [...(rule.require ?? []), ...(rule.exclude ?? [])].every((tag) => tags.has(tag)));
    const toggles = chipToggles({
      label: "How you eat",
      options: shown.map((rule) => ({ value: rule.id, label: rule.label, hint: rule.hint })),
      values: state.rules.filter((id) => shown.some((rule) => rule.id === id)),
      onChange: (values) => {
        state.rules = values;
        changed();
      },
    });
    const fit = h("p", { class: "ms-fit", role: "status" });
    live.push(() => {
      const found = eligibleNow();
      fit.hidden = !found;
      if (!found) return;
      const meals = Object.keys(found);
      const zero = meals.find((meal) => !found[meal].length);
      fit.classList.toggle("ms-warn", Boolean(zero));
      if (zero) {
        fit.replaceChildren(icon("alert", { size: 15 }), `No ${MEAL_WORDS[zero].lower} recipe fits these rules. Turn one off.`);
      } else if (meals.length === 1) {
        fit.replaceChildren(icon("check", { size: 15 }), `${found[meals[0]].length} ${found[meals[0]].length === 1 ? MEAL_WORDS[meals[0]].lower : MEAL_WORDS[meals[0]].many} fit`);
      } else {
        fit.replaceChildren(icon("check", { size: 15 }), meals.map((meal) => `${MEAL_WORDS[meal].one} ${found[meal].length}`).join(" · "), " fit");
      }
    });
    return section("How you eat", toggles.element, fit, moreLabels(), h("p", { class: "muted small-text", text: "Uses Food.com’s own labels." }));
  }

  function moreLabels() {
    if (!cookbook) return null;
    const counts = new Map();
    for (const recipe of Object.values(cookbook.recipes)) for (const tag of recipe.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const tags = [...counts.entries()].filter(([tag]) => isListedTag(tag)).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
    const search = h("input", { type: "search", class: "input", placeholder: "Find a label", "aria-label": "Find a label" });
    const setCount = () => {
      const count = Object.keys(state.tags).length;
      return count ? `${count} set` : `${tags.length} labels`;
    };
    const rows = tags.map(([tag, count]) => {
      const select = h(
        "select",
        { class: "input ms-tag-select", "aria-label": `${tag}: any, must be, or never` },
        h("option", { value: "", text: "Any" }),
        h("option", { value: "require", text: "Must be" }),
        h("option", { value: "exclude", text: "Never" }),
      );
      select.value = state.tags[tag] ?? "";
      select.addEventListener("change", () => {
        if (select.value) state.tags[tag] = select.value;
        else delete state.tags[tag];
        row.classList.toggle("set", Boolean(select.value));
        hint.textContent = setCount();
        changed();
      });
      const row = h("li", { class: `ms-tag${state.tags[tag] ? " set" : ""}` }, h("span", { class: "ms-tag-name", text: tag }), h("span", { class: "muted small-text numeric", text: String(count) }), select);
      return { tag, row };
    });
    search.addEventListener("input", () => {
      const needle = search.value.trim().toLowerCase();
      for (const { tag, row } of rows) row.hidden = needle && !tag.toLowerCase().includes(needle);
    });
    const box = disclosure({ summary: "More labels", hint: setCount(), className: "ms-more", open: Object.keys(state.tags).length > 0 }, search, h("ul", { class: "ms-tags" }, rows.map((one) => one.row)));
    const hint = box.querySelector(".disclosure-hint");
    return box;
  }

  // -- Tastes ---------------------------------------------------------------------------------
  function tastesSection() {
    const rows = LEVELS.map((level) => {
      const mine = state.likes.filter((like) => like.level === level.id);
      const chips = mine.map((like) => {
        const count = h("span", { class: "ms-like-count numeric" });
        const chip = h(
          "li",
          { class: `chip static ms-like ms-like-${level.id}` },
          level.id === "avoid" ? icon("minus", { size: 14 }) : heart(),
          h("span", { text: like.name }),
          count,
          h("button", { type: "button", class: "chip-remove", "aria-label": `Remove ${like.name}`, onclick: () => removeLike(like.name) }, icon("close", { size: 14 })),
        );
        live.push(() => {
          const found = eligibleNow();
          if (!found) {
            count.hidden = true;
            return;
          }
          const names = [...new Set(Object.values(found).flat())];
          const n = names.filter((name) => liked(cookbook.recipes[name], [like]).length).length;
          const where = mealsOf(state).length === 1 ? MEAL_WORDS[mealsOf(state)[0]].many : "recipes";
          count.hidden = false;
          count.textContent = String(n);
          chip.title = `In ${n} of the ${names.length} ${where} that fit`;
          chip.classList.toggle("ms-like-none", n === 0);
        });
        return chip;
      });
      const add = h("button", { type: "button", class: "chip ms-add", "aria-expanded": String(picker?.level === level.id), onclick: () => openPicker(level.id) }, icon("plus", { size: 14 }), mine.length ? "Add" : `Add something you ${level.id === "avoid" ? "avoid" : level.id}`);
      const row = h("div", { class: "ms-taste-row" }, h("span", { class: `ms-level ms-level-${level.id}`, text: level.label }), h("ul", { class: "chips ms-like-list" }, chips, h("li", {}, add)));
      return [row, picker?.level === level.id ? pickerFor(level.id) : null];
    });
    return section(
      "Tastes",
      rows,
      h("p", { class: "muted small-text", text: state.likes.length ? "Avoid makes a dish less likely. To rule something out completely, use How you eat." : "No tastes yet: any dish that fits will do. Add what you love to get dishes you’ll enjoy." }),
    );
  }

  function pickerFor(levelId) {
    const level = LEVELS.find((one) => one.id === levelId);
    const here = new Set(state.likes.filter((like) => like.level === levelId).map((like) => like.name));
    const groups = chipRow({
      label: `Foods to ${level.label.toLowerCase()}`,
      items: FOOD_GROUPS.filter((group) => !here.has(group.name)).map((group) => ({ label: group.name, value: group.name, title: `Matches ${group.words.join(", ")}` })),
      onPick: (item) => addLike(levelId, FOOD_GROUPS.find((group) => group.name === item.value)),
    });
    const other = h("input", { type: "text", class: "input", placeholder: "Something else, e.g. lemon", "aria-label": "Something else" });
    const error = h("p", { class: "field-error", role: "alert", hidden: true });
    const addOther = () => {
      const word = other.value.trim().toLowerCase();
      if (!word) {
        error.textContent = "Type a food first.";
        error.hidden = false;
        return;
      }
      if (here.has(word)) {
        error.textContent = `${word} is already in ${level.label}.`;
        error.hidden = false;
        return;
      }
      addLike(levelId, { name: word, words: [word], ignore: [] });
    };
    other.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addOther();
      }
    });
    other.addEventListener("input", () => (error.hidden = true));
    const element = h(
      "div",
      { class: "ms-picker", role: "group", "aria-label": `Add to ${level.label}` },
      h("div", { class: "ms-picker-head" }, h("strong", { text: `Add to ${level.label}` }), h("button", { type: "button", class: "button ghost small icon-only", "aria-label": "Close", onclick: () => closePicker() }, icon("close", { size: 15 }))),
      groups.element,
      h("div", { class: "ms-picker-other" }, other, h("button", { type: "button", class: "button small", text: "Add", onclick: addOther })),
      error,
    );
    return element;
  }

  function openPicker(levelId) {
    picker = picker?.level === levelId ? null : { level: levelId };
    render();
    if (picker) form.querySelector(".ms-picker .chip, .ms-picker input")?.focus();
  }
  function closePicker() {
    const level = picker?.level;
    picker = null;
    render();
    form.querySelector(`.ms-level-${level}`)?.parentElement.querySelector(".ms-add")?.focus();
  }
  function addLike(level, group) {
    // Names are unique: adding one that is elsewhere moves it here.
    state.likes = [...state.likes.filter((like) => like.name !== group.name), { name: group.name, words: [...group.words], ignore: [...group.ignore], level }];
    picker = null;
    render();
    changed();
    form.querySelector(`.ms-level-${level}`)?.parentElement.querySelector(".ms-add")?.focus();
  }
  function removeLike(name) {
    state.likes = state.likes.filter((like) => like.name !== name);
    render();
    changed();
  }

  // -- Targets --------------------------------------------------------------------------------
  function targetsEditor(rows, { onEdit, onStructure }) {
    const list = h("ul", { class: "ms-targets" }, h("li", { class: "ms-target-head", "aria-hidden": "true" }, h("span"), h("span", { text: "At least" }), h("span", { text: "At most" })));
    rows.forEach((row, index) => {
      const { label, unit } = NUTRIENT[row.nutrient];
      const input = (key, words) => {
        const box = h("input", { type: "text", inputmode: "decimal", class: "input numeric", value: row[key], placeholder: "—", "aria-label": `${label} ${words} (${unit})` });
        box.addEventListener("input", () => {
          row[key] = box.value;
          onEdit();
          changed();
        });
        return box;
      };
      const min = input("min", "at least");
      const max = input("max", "at most");
      const error = h("p", { class: "field-error", role: "alert", hidden: true });
      const element = h(
        "li",
        { class: "ms-target" },
        h("span", { class: "ms-target-name" }, label, h("span", { class: "muted", text: ` ${unit}` })),
        h("label", { class: "ms-bound" }, h("span", { class: "ms-bound-word", text: "at least" }), min),
        h("label", { class: "ms-bound" }, h("span", { class: "ms-bound-word", text: "at most" }), max),
        h("button", { type: "button", class: "button ghost small icon-only ms-remove", "aria-label": `Remove the ${label.toLowerCase()} target`, onclick: () => (rows.splice(index, 1), onStructure()) }, icon("close", { size: 15 })),
        error,
      );
      live.push(() => {
        const read = readRow(row);
        error.textContent = read.error ?? (read.empty ? "Blank: this target is left out." : "");
        error.hidden = !read.error && !read.empty;
        error.classList.toggle("ms-soft", !read.error);
        element.classList.toggle("invalid", Boolean(read.error));
        for (const box of [min, max]) box.setAttribute("aria-invalid", String(Boolean(read.error)));
      });
      list.append(element);
    });
    const unused = NUTRIENTS.filter((one) => !rows.some((row) => row.nutrient === one.key));
    const add = h(
      "select",
      { class: "input ms-add-target", "aria-label": "Add a target" },
      h("option", { value: "", text: "+ Add a target" }),
      unused.map((one) => h("option", { value: one.key, text: `${one.label} (${one.unit})` })),
    );
    add.hidden = unused.length === 0;
    add.addEventListener("change", () => {
      if (!add.value) return;
      rows.push({ nutrient: add.value, min: "", max: "" });
      onStructure();
      const boxes = form.querySelectorAll(`.ms-targets input`);
      [...boxes].find((box) => box.getAttribute("aria-label").startsWith(NUTRIENT[rows.at(-1).nutrient].label))?.focus();
    });
    return h("div", { class: "ms-targets-box" }, rows.length ? list : h("p", { class: "muted small-text", text: "No targets: any amount is fine." }), add);
  }

  function targetsSection() {
    const key = state.mode === "meal" ? "meal" : "day";
    const targets = state.targets[key];
    const items = () => [
      ...PRESETS.map((preset) => ({ label: preset.label, value: preset.id, selected: targets.preset === preset.id })),
      ...(targets.preset === "custom" ? [{ label: "Custom", value: "custom", selected: true }] : []),
    ];
    const presets = chipRow({
      label: "Target presets",
      items: items(),
      onPick: (item) => {
        if (item.value === "custom") return;
        targets.preset = item.value;
        targets.rows = asText(presetRows(item.value, key, state.meal));
        render();
        changed();
      },
    });
    const custom = () => {
      if (targets.preset === "custom") return;
      targets.preset = "custom";
      presets.setItems(items());
    };
    const editor = targetsEditor(targets.rows, {
      onEdit: custom,
      onStructure: () => {
        custom();
        render();
        changed();
      },
    });
    if (state.mode === "meal") return section("Targets for this meal", presets.element, editor);
    const perMeal = mealsOf(state).map((meal) =>
      h(
        "div",
        { class: "ms-per-meal" },
        h("h4", { text: MEAL_WORDS[meal].one }),
        targetsEditor(state.targets.perMeal[meal], {
          onEdit: () => {},
          onStructure: () => {
            render();
            changed();
          },
        }),
      ),
    );
    const setCount = mealsOf(state).reduce((sum, meal) => sum + state.targets.perMeal[meal].length, 0);
    return section(
      "Targets for the whole day",
      presets.element,
      editor,
      mealsOf(state).length
        ? disclosure({ summary: "Targets for each meal", hint: setCount ? plural(setCount, "target") : "optional", className: "ms-more", open: setCount > 0 }, h("p", { class: "muted small-text", text: "For example, keep breakfast between 300 and 600 kcal." }), perMeal)
        : null,
    );
  }

  // -- Servings -------------------------------------------------------------------------------
  function servingsSection() {
    const key = state.mode === "meal" ? "meal" : "day";
    const stepper = numberStepper({
      label: "Most servings of any one dish",
      value: state.servings[key],
      min: 1,
      max: 10,
      unit: "servings",
      hint: "More servings make high protein or calorie targets easier to reach.",
      onChange: (value) => {
        state.servings[key] = value;
        changed();
      },
    });
    return h("section", { class: "ms-section" }, stepper.element);
  }

  function render() {
    live = [];
    form.replaceChildren(
      mealSection(),
      rulesSection(),
      tastesSection(),
      targetsSection(),
      servingsSection(),
      h("div", { class: "ms-reset" }, h("button", { type: "button", class: "button ghost small", onclick: onReset }, icon("refresh", { size: 15 }), "Reset to defaults")),
    );
    for (const update of live) update();
  }
  render();

  return {
    element: form,
    setState(next) {
      state = next;
      picker = null;
      render();
    },
    setCookbook(next) {
      cookbook = next;
      render();
    },
    setDisabled(disabled) {
      form.disabled = disabled;
    },
  };
}
