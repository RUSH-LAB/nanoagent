// The Meal Suggestion page: say what you want to eat (one meal or a whole day), get real Food.com
// dishes and servings that hit your targets, checked by recomputing every total. The plugin's
// agent is one click away in the "Ask the chef" drawer. See docs/plans/plugin-ui-meal-suggestion.md.

import {
  actionBar,
  announce,
  appShell,
  banner,
  card,
  columns,
  emptyState,
  explainError,
  fileDrop,
  h,
  icon,
  jsonStore,
  listFiles,
  mountApp,
  parseToolOutput,
  plural,
  readText,
  runButton,
  segmented,
  taskRun,
} from "./kit/components.js";
import { RECIPES_PATH, describeCookbook, missingRecipes, parseCookbook } from "./cookbook.js";
import { MEALS, MEAL_WORDS } from "./presets.js";
import { blockedReason, boundWords, checkState, defaultState, mealsOf, requestPanel, summaryOf, taskOf } from "./request.js";
import { errorRules, infeasibleHints, placeholderDishes, resultView } from "./result.js";

const PROFILE = "meal-suggestion/profile.json";
// The files submit_meal and submit_day write (src/plugin/meals.py).
const WRITES = { "suggest-meal": "meal.json", "plan-day": "day.json" };
const TASK = { meal: "suggest-meal", day: "plan-day" };

const STEPS = [
  { id: "start", label: "Reading your request" },
  { id: "best", label: "Working out the best possible match" },
  { id: "look", label: "Looking through the recipes" },
  { id: "choose", label: "Choosing dishes and servings" },
  { id: "check", label: "Double-checking every total" },
];

/** The plan a verdict or a written file holds: dishes for a meal, meal -> dishes for a day. */
function planOf(task, value) {
  if (!value || typeof value !== "object") return null;
  const valid = (dishes) => Array.isArray(dishes) && dishes.length > 0 && dishes.every((dish) => dish && typeof dish.recipe === "string" && Number.isInteger(dish.servings));
  if (task === "suggest-meal") return valid(value.dishes) ? value.dishes : null;
  const meals = value.meals;
  return meals && typeof meals === "object" && Object.keys(meals).every((meal) => MEALS.includes(meal) && valid(meals[meal])) && Object.keys(meals).length ? meals : null;
}
const dishesOf = (task, plan) => (task === "suggest-meal" ? plan : Object.values(plan).flat());

function cookbookLine(cookbook) {
  const about = describeCookbook(cookbook);
  return `${plural(about.count, "recipe")} · ${MEALS.map((meal) => `${about.meals[meal]} ${about.meals[meal] === 1 ? MEAL_WORDS[meal].lower : MEAL_WORDS[meal].many}`).join(" · ")}`;
}
// "Food.com recipes (Kaggle …, CC0): https://…" -> the credit without the download address.
const credit = (source) => source.replace(/:?\s*https?:\/\/\S+\s*$/, "").trim();

mountApp(async ({ plugin }) => {
  // -- Saved request ----------------------------------------------------------------------------
  const store = jsonStore({ path: PROFILE, version: 1, initial: defaultState() });
  let profileProblem = null;
  let state;
  try {
    state = checkState(await store.load());
  } catch (problem) {
    profileProblem = problem.message;
    state = defaultState();
  }

  let cookbook = null;
  let parsed = null;
  let replacing = false;
  const shown = { meal: null, day: null }; // the result on screen per mode: {request, plan}
  const ran = { meal: false, day: false }; // whether a mode shows a run's outcome, even a failed one
  const known = {}; // file -> text the page last saw, to notice changes made in chat

  // -- Header -----------------------------------------------------------------------------------
  const mode = segmented({
    label: "Plan",
    options: [
      { value: "meal", label: "One meal" },
      { value: "day", label: "A whole day" },
    ],
    value: state.mode,
    onChange: (value) => {
      state.mode = value;
      panel.setState(state);
      update();
    },
  });

  const shell = appShell({
    plugin,
    nav: mode.element,
    width: "wide",
    chat: {
      title: "Ask the chef",
      buttonLabel: "Ask the chef",
      note: "Ask about a suggestion, swaps or what to prep ahead. What the chef changes here isn’t checked until you run a new suggestion.",
      intro: h("div", { class: "chat-intro small" }, h("img", { src: plugin.product.icon, alt: "" }), h("p", { class: "muted", text: "Ask the chef about these recipes, your targets or a suggestion." })),
      placeholder: "Ask the chef…",
      suggestions: ["Which dinners here are quickest to make?", "What makes a filling high-protein breakfast?"],
      prepare: (text) => `${chatContext()}\n\n${text}`,
      onTurnDone: () => noticeChatChanges(),
    },
  });

  // -- Request ----------------------------------------------------------------------------------
  const panel = requestPanel({
    state,
    onChange: () => update(),
    onReset: async () => {
      state = defaultState();
      mode.set(state.mode);
      panel.setState(state);
      update();
      if (!profileProblem) await store.reset();
    },
  });

  const runs = Object.fromEntries(
    Object.values(TASK).map((task) => {
      const listed = {};
      const run = taskRun({
        task,
        title: task === "plan-day" ? "Planning your day" : "Finding your dishes",
        steps: STEPS,
        onEvent: (name, data, controller) => {
          if (name === "task.started") {
            for (const key of Object.keys(listed)) delete listed[key];
            controller.step("start");
          } else if (name === "task.reference") {
            controller.step("best", { detail: "So the suggestion can be graded fairly", progress: "indeterminate" });
          } else if (name === "task.tool") {
            onTool(data, controller, listed);
          } else if (name === "task.answer") {
            controller.step("check");
          }
        },
      });
      return [task, run];
    }),
  );

  function onTool(data, controller, listed) {
    const args = data.arguments ?? {};
    if (data.isError) {
      controller.note("Retried a step");
      return;
    }
    const output = parseToolOutput(data.output);
    if (data.name === "list_recipes" && Array.isArray(output?.recipes) && MEALS.includes(args.meal)) {
      listed[args.meal] = output.recipes.length;
      const meals = MEALS.filter((meal) => meal in listed);
      controller.step("look", {
        detail: meals.length === 1 ? `Looked through ${listed[meals[0]]} ${MEAL_WORDS[meals[0]].lower} recipes` : `Looked through ${meals.map((meal) => `${listed[meal]} ${MEAL_WORDS[meal].lower}`).join(", ")} recipes`,
      });
    } else if (data.name === "nutrition" && typeof args.recipe === "string") {
      controller.step("choose", { detail: `Read the recipe for ${args.recipe}` });
    } else if (data.name === "submit_meal" && Array.isArray(args.dishes)) {
      controller.step("choose", { detail: `Wrote down ${plural(args.dishes.length, "dish", "dishes")}` });
    } else if (data.name === "submit_day" && args.meals && typeof args.meals === "object") {
      controller.step("choose", { detail: `Wrote down ${plural(Object.values(args.meals).flat().length, "dish", "dishes")}` });
    }
  }

  const buttons = {
    meal: runButton({ label: "Suggest my meal", run: runs["suggest-meal"], cancelWhileBusy: true, block: true, note: "Takes a few minutes: the chef weighs every combination.", onClick: () => go() }),
    day: runButton({ label: "Plan my day", run: runs["plan-day"], cancelWhileBusy: true, block: true, note: "Takes a few minutes: the chef weighs every combination.", onClick: () => go() }),
  };
  const summaryText = h("p", { class: "ms-summary-text" });
  const summary = h(
    "section",
    { class: "card ms-summary", "aria-label": "Your request" },
    h("div", {}, h("span", { class: "muted small-text", text: "Your request" }), summaryText),
    h("button", { type: "button", class: "button small", text: "Edit", onclick: () => setEditing(true) }),
  );
  const profileBanner = profileProblem
    ? banner({
        tone: "warn",
        title: "Your saved choices couldn’t be read",
        body: "The page starts from the defaults and won’t save over that file until you start fresh.",
        details: profileProblem,
        detailsLabel: "Technical details",
        actions: [
          h("button", {
            type: "button",
            class: "button small",
            text: "Start fresh",
            onclick: async (event) => {
              await store.reset();
              profileProblem = null;
              event.target.closest(".banner").remove();
            },
          }),
        ],
      })
    : null;
  const saveNote = h("p", { class: "muted small-text", role: "status" });
  const requestCard = card(
    { title: "What would you like?", className: "ms-request", size: "large" },
    profileBanner,
    panel.element,
    saveNote,
    actionBar({ sticky: "narrow" }, buttons.meal.element, buttons.day.element),
  );

  // -- Recipes ----------------------------------------------------------------------------------
  const drop = fileDrop({
    title: "Add your recipe collection",
    path: RECIPES_PATH,
    extensions: [".json"],
    description: "Build recipes.json from Food.com with the meal-suggestion example (step 1), then drop it here.",
    maxBytes: 20 * 1024 * 1024,
    paste: false,
    inspect: (text) => {
      parsed = parseCookbook(text);
      return cookbookLine(parsed);
    },
    onChange: (file) => {
      if (file) {
        replacing = false;
        setCookbook(parsed);
      } else if (!replacing) {
        setCookbook(null);
      }
      update();
    },
  });
  const keep = h("button", {
    type: "button",
    class: "button ghost small",
    text: "Keep the current recipes",
    onclick: () => {
      replacing = false;
      update();
    },
  });
  const setupCard = h("div", { class: "ms-setup" }, drop.element, keep);
  const recipesLine = h("footer", { class: "ms-recipes-line small-text" });

  function setCookbook(next) {
    cookbook = next;
    panel.setCookbook(next);
    recipesLine.replaceChildren(
      ...(next
        ? [
            h("span", { class: "muted" }, icon("file", { size: 14 }), " ", cookbookLine(next)),
            h("span", { class: "muted", text: `Recipes: ${credit(next.source)}` }),
            h("button", {
              type: "button",
              class: "button ghost small",
              text: "Replace",
              onclick: () => {
                replacing = true;
                drop.clear();
                update();
                setupCard.scrollIntoView({ block: "nearest" });
              },
            }),
          ]
        : []),
    );
  }

  // -- Results ----------------------------------------------------------------------------------
  const views = Object.fromEntries(
    Object.entries(TASK).map(([key, task]) => {
      const slot = h("div", { class: "ms-slot" });
      const notice = h("div", { class: "ms-notice" });
      return [key, { task, slot, notice, element: h("div", { class: "ms-view stack" }, notice, runs[task].element, slot) }];
    }),
  );
  const resultColumn = h("div", { class: "stack ms-results" }, views.meal.element, views.day.element, recipesLine);

  function emptyView(key) {
    const meal = key === "meal" ? MEAL_WORDS[state.meal].lower : "day";
    return card(
      { size: "large", className: "ms-empty" },
      emptyState({
        icon: "spark",
        title: key === "meal" ? "Your dishes will appear here" : "Your day will appear here",
        body: `Pick how you eat, what you love and your targets, then press the button. The chef chooses real Food.com dishes and servings for your ${meal}, and every total is checked against your targets.`,
      }),
      placeholderDishes({ running: false }),
    );
  }

  // The recipes come first: nothing can run without them, and on narrow screens the form is long.
  const root = h("div", { class: "ms stack" }, setupCard, columns({ main: resultColumn, aside: h("div", { class: "stack" }, summary, requestCard), asideWidth: "420px", asideSide: "left", asideFirst: true }));
  shell.main.append(root);

  function setEditing(editing) {
    root.classList.toggle("editing", editing);
    if (editing) requestCard.scrollIntoView({ block: "start" });
  }

  function update() {
    const key = state.mode;
    const reason = blockedReason(state, cookbook);
    buttons.meal.setLabel(`Suggest my ${MEAL_WORDS[state.meal].lower}`);
    buttons.meal.setBlocked(reason);
    buttons.day.setBlocked(reason);
    buttons.meal.element.hidden = key !== "meal";
    buttons.day.element.hidden = key !== "day";
    views.meal.element.hidden = key !== "meal";
    views.day.element.hidden = key !== "day";
    for (const [name, view] of Object.entries(views)) {
      // Before any run the slot shows the empty state, kept in step with the chosen meal.
      if (!runs[view.task].busy && !shown[name] && (!view.slot.childNodes.length || view.slot.querySelector(".ms-empty"))) view.slot.replaceChildren(emptyView(name));
    }
    setupCard.hidden = Boolean(cookbook) && !replacing;
    keep.hidden = !(cookbook && replacing);
    recipesLine.hidden = !cookbook || replacing;
    summaryText.textContent = summaryOf(state);
    root.classList.toggle("has-result", ran[key]);
  }

  for (const run of Object.values(runs)) {
    run.subscribe(() => {
      const busy = Object.values(runs).some((one) => one.busy);
      panel.setDisabled(busy);
      mode.setDisabled(busy);
      drop.setDisabled(busy);
      for (const button of recipesLine.querySelectorAll("button")) button.disabled = busy;
    });
  }

  // -- Running ----------------------------------------------------------------------------------
  async function go() {
    const key = state.mode;
    const view = views[key];
    const request = taskOf(state);
    if (!profileProblem) store.update(() => structuredClone(state)).catch((problem) => (saveNote.textContent = `Couldn’t save your choices for next time: ${problem.message}`));
    view.notice.replaceChildren();
    view.slot.replaceChildren(placeholderDishes({ running: true }));
    ran[key] = true;
    root.classList.add("has-result");
    setEditing(false);
    const outcome = await runs[request.task].start(request.arguments);
    await show(key, request, outcome);
    update();
  }

  async function readPlan(task) {
    const file = WRITES[task];
    const files = await listFiles({ prefix: file });
    if (!files.some((one) => one.path === file)) return { text: null, plan: null };
    const text = await readText(file);
    let value = null;
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
    return { text, plan: planOf(task, value) };
  }

  async function show(key, request, outcome) {
    const view = views[key];
    const task = request.task;
    // "Try another" after a result; "Try again" after a failure.
    const again = () => h("button", { type: "button", class: "button", onclick: () => go() }, icon("refresh", { size: 15 }), "Try again");
    const actions = () => [
      h("button", { type: "button", class: "button", onclick: () => go() }, icon("refresh", { size: 15 }), "Try another"),
      h("button", { type: "button", class: "button", onclick: () => shell.drawer.open({ prefill: key === "meal" ? "Why did you choose these dishes?" : "Why did you plan the day this way?" }) }, icon("chat", { size: 15 }), "Ask about this"),
      h("button", { type: "button", class: "button ghost ms-narrow-only", text: "Edit request", onclick: () => setEditing(true) }),
    ];
    let written = { text: null, plan: null };
    let unread = null;
    try {
      written = await readPlan(task);
      if (written.text !== null) known[WRITES[task]] = written.text;
    } catch (problem) {
      unread = problem.message;
    }

    if (outcome.status === "valid" || outcome.status === "invalid") {
      const plan = planOf(task, outcome.verdict.details ?? {}) ?? written.plan;
      if (!plan && unread) {
        view.slot.replaceChildren(banner({ tone: "bad", title: "Couldn’t read the suggestion", body: "The check finished, but the page couldn’t read what the chef wrote down.", details: unread, detailsLabel: "Technical details", actions: [again()] }));
        return;
      }
      if (plan && missingRecipes(cookbook, dishesOf(task, plan)).length) {
        view.slot.replaceChildren(banner({ tone: "bad", title: "The recipe file changed during the run", body: "Some suggested dishes aren’t in your recipe collection any more. Run again.", actions: [again()] }));
        return;
      }
      shown[key] = plan ? { request, plan } : null;
      const heading = key === "meal" ? `${MEAL_WORDS[request.arguments.meal].one} for you` : "Your day";
      view.slot.replaceChildren(resultView({ cookbook, request, verdict: outcome.verdict, plan, answer: outcome.answer, actions: outcome.status === "valid" ? actions() : [again(), ...actions().slice(1)], heading }));
      shell.drawer.chat.setSuggestions(key === "meal" ? ["Why these dishes?", "Swap one dish for something with rice", "What can I prep ahead?"] : ["Why this breakfast?", "Make lunch quicker to cook", "What can I prep the night before?"]);
      announce(outcome.status === "valid" ? "Your suggestion is ready and fits every target." : "The suggestion didn’t pass the check.");
      return;
    }

    if (outcome.status === "cancelled") {
      view.slot.replaceChildren(banner({ tone: "neutral", title: "Stopped", body: "Your request is still here when you want to try again.", actions: [again()] }));
      shown[key] = null;
      return;
    }
    if (outcome.status === "unchecked") {
      view.slot.replaceChildren(banner({ tone: "bad", title: "The run ended without a check", body: "Nothing was graded, so nothing is shown. Try again.", actions: [again()] }));
      shown[key] = null;
      return;
    }

    const plain = explainError(outcome.error, errorRules({ cookbookLoaded: Boolean(cookbook), meal: key === "meal" ? MEAL_WORDS[request.arguments.meal].lower : "day" }));
    const lines = [];
    const fixes = [];
    if (plain.rule === "infeasible") {
      // The hints hold for any number of servings, so more servings are offered only without one.
      const hints = infeasibleHints(cookbook, request);
      lines.push(...hints);
      const servings = state.servings[key];
      if (!hints.length && servings < 10) {
        fixes.push(
          h("button", {
            type: "button",
            class: "button small",
            text: `Allow up to ${servings + 1} servings`,
            onclick: () => {
              state.servings[key] = servings + 1;
              panel.setState(state);
              update();
              go();
            },
          }),
        );
      }
      lines.push(hints.length ? "Loosen one of these targets, or turn off a rule under How you eat." : "Loosen a target, allow more servings, or turn off a rule under How you eat.");
    }
    fixes.push(h("button", { type: "button", class: "button small", text: "Edit my request", onclick: () => setEditing(true) }));
    // The same request fails the same way, so these offer no plain retry.
    const retry = !["infeasible", "restrictions", "bounds", "input"].includes(plain.rule);
    shown[key] = null;
    view.slot.replaceChildren(
      banner({
        tone: plain.tone,
        title: outcome.startFailed ? "Couldn’t start" : plain.text,
        body: outcome.startFailed ? plain.text : undefined,
        lines,
        actions: retry ? [...fixes, again()] : fixes,
        details: plain.raw && plain.raw !== "cancelled" ? plain.raw : undefined,
        detailsLabel: "Technical details",
      }),
    );
  }

  // -- Chat -------------------------------------------------------------------------------------
  function chatContext() {
    const request = taskOf(state);
    const args = request.arguments;
    const bounds = request.task === "suggest-meal" ? args.constraints : args.day;
    const lines = [
      `(Context from the Meal Suggestion page. The recipes file is ${RECIPES_PATH}.`,
      `I am planning ${request.task === "suggest-meal" ? `a ${args.meal}` : `a day of ${mealsOf(state).join(", ")}`}: ${summaryOf(state)}.`,
    ];
    const targets = Object.entries(bounds).map(([key, bound]) => boundWords(key, bound));
    if (targets.length) lines.push(`My targets${request.task === "plan-day" ? " for the day" : ""}: ${targets.join("; ")}.`);
    if (args.restrictions.require.length || args.restrictions.exclude.length) lines.push(`Restrictions: must be ${args.restrictions.require.join(", ") || "anything"}; never ${args.restrictions.exclude.join(", ") || "nothing"}.`);
    if (args.likes.length) lines.push(`Tastes: ${args.likes.map((like) => `${like.name} (${like.weight > 0 ? "like" : "avoid"}, weight ${like.weight})`).join(", ")}.`);
    const current = shown[state.mode];
    if (current) {
      const meals = current.request.task === "suggest-meal" ? { [current.request.arguments.meal]: current.plan } : current.plan;
      lines.push(`The current suggestion: ${Object.entries(meals).map(([meal, dishes]) => `${meal}: ${dishes.map((dish) => `${dish.recipe} x${dish.servings}`).join(", ")}`).join("; ")}.)`);
    } else {
      lines[lines.length - 1] += ")";
    }
    return lines.join("\n");
  }

  async function noticeChatChanges() {
    if (!cookbook) return;
    const key = state.mode;
    const task = TASK[key];
    let written;
    try {
      written = await readPlan(task);
    } catch {
      return; // Only an offer: a plan file the page can't read now is offered on a later turn.
    }
    if (written.text === null || written.text === known[WRITES[task]] || !written.plan || missingRecipes(cookbook, dishesOf(task, written.plan)).length) return;
    const view = views[key];
    const request = shown[key]?.request ?? taskOf(state);
    view.notice.replaceChildren(
      banner({
        tone: "info",
        title: key === "meal" ? "The chef changed your meal in chat" : "The chef changed your day in chat",
        actions: [
          h("button", {
            type: "button",
            class: "button small primary",
            text: "Show it",
            onclick: () => {
              known[WRITES[task]] = written.text;
              shown[key] = { request, plan: written.plan };
              view.notice.replaceChildren();
              view.slot.replaceChildren(resultView({ cookbook, request, verdict: null, plan: written.plan, answer: null, heading: key === "meal" ? `${MEAL_WORDS[request.arguments.meal].one} from the chat` : "Your day from the chat", actions: [h("button", { type: "button", class: "button primary", onclick: () => go() }, icon("refresh", { size: 15 }), "Run a checked suggestion")] }));
              update();
            },
          }),
        ],
      }),
    );
  }

  // -- Start ------------------------------------------------------------------------------------
  await drop.restore();
  for (const task of Object.values(TASK)) {
    try {
      const written = await readPlan(task);
      if (written.text !== null) known[WRITES[task]] = written.text;
    } catch {
      // An unreadable earlier plan stays unknown: a chat that rewrites it is then offered.
    }
  }
  update();
  return shell.element;
});
