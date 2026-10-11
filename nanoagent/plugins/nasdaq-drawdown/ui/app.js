// The nasdaq-drawdown page: pick a week, find the Nasdaq-100 stocks that fell 5% or more, and see
// the checked list. The chat with the plugin's agent lives in a drawer. Design:
// docs/plans/plugin-ui-nasdaq-drawdown.md.

import { announce, appShell, banner, card, chipRow, dateInput, errorCard, explainError, h, howItWorks, icon, isoDate, listFiles, parseToolOutput, readJSON, runButton, skeleton, taskRun, writeJSON } from "./kit/components.js";
import { ERROR_RULES, NEW_YORK, checkSavedWeek, dayProblem, errorFix, failedCallNote, formatDay, formatWeek, resultCard, savedChipLabel, weekFromRun, weekPicks } from "./drawdown.js";

const TASK = "nasdaq-down-5";
const SAVED = "drawdown-weeks/";
const RECENT = 8;

const STEPS = [
  { id: "pin", label: "Getting Nasdaq's official closing prices" },
  { id: "week", label: "Finding the week" },
  { id: "collect", label: "Agent collecting prices" },
  { id: "pick", label: "Agent picking the fallers" },
  { id: "check", label: "Checking the agent's answer" },
];

export default async function page({ plugin }) {
  // These two cannot be recovered from on the page, and the message reaches a reader, so it says
  // what is wrong without naming the task or its argument.
  const task = plugin.tasks.find((one) => one.id === TASK);
  if (!task) throw new Error("This version of Nasdaq-100 Weekly Drawdown no longer offers the weekly check this page is built around.");
  if (!task.inputSchema?.properties?.as_of) throw new Error("This version of Nasdaq-100 Weekly Drawdown no longer takes the week's last day, which this page asks for.");

  const today = isoDate({ timeZone: NEW_YORK });
  const picks = weekPicks(today);
  let shown = null; // the week the result card shows
  let progress = null; // what the current run has told the page so far

  // ----- Chat -----

  const suggestionsFor = (asOf) => [
    `Which Nasdaq-100 stocks rose the most in the week ending ${formatDay(asOf, { weekday: false })}?`,
    `What was NVDA's closing price on ${formatDay(asOf, { weekday: false })}?`,
    "Which companies are in the Nasdaq-100 right now?",
  ];
  const shell = appShell({
    plugin,
    chat: {
      intro: h("div", { class: "chat-intro small" }, h("img", { src: plugin.product.icon, alt: "" }), h("p", { class: "muted", text: "Ask about Nasdaq-100 prices, for example a company's close on a day." })),
      note: "The agent looks prices up on Nasdaq. Answers here are not checked; the list on the page is.",
      placeholder: "Ask about a stock or a week",
      suggestions: suggestionsFor(picks.lastFriday),
      prepare: (text) => (shown ? `(I'm looking at the Nasdaq-100 week ending ${shown.as_of}.)\n\n${text}` : text),
    },
  });

  // ----- Week picker -----

  const caption = (value) => `Compares each company's close on ${formatDay(value, { year: false })} with its close 5 trading days earlier.`;
  const picker = dateInput({
    label: "Week ending",
    value: picks.lastFriday,
    max: picks.latest,
    chips: picks.chips,
    caption: caption(picks.lastFriday),
    check: (value) => dayProblem(value, today),
    onChange: (value) => {
      if (picker.valid()) picker.setCaption(caption(value));
      shell.drawer.chat.setSuggestions(suggestionsFor(picker.valid() ? value : picks.lastFriday));
      refreshButton();
    },
  });

  const recent = chipRow({ label: "Your recent weeks", items: [], scroll: true, onPick: (item) => showSaved(item.value) });
  const recentRow = h("div", { class: "recent", hidden: true }, h("span", { class: "recent-label", text: "Your recent weeks" }), recent.element);
  const recentProblem = h("p", { class: "small-text error-text", hidden: true });

  const run = taskRun({ task: TASK, title: "Finding the fallers", steps: STEPS, onEvent: track, onFinish: finished });
  run.element.tabIndex = -1; // so starting a run can put the keyboard in the progress card (`start`)
  const go = runButton({
    label: "Find the fallers",
    run,
    block: true,
    onClick: () => start(picker.value()),
    note: "Takes about 10 to 15 minutes: every company's prices are fetched twice, once for the answer key and once by the agent. Keep this page open.",
  });
  const refreshButton = () => go.setBlocked(picker.valid() ? null : "Pick a weekday before today to start.");
  run.subscribe((busy) => {
    picker.setDisabled(busy);
    recent.setDisabled(busy);
  });

  const pickerCard = card({ title: "Pick a week", className: "picker-card" }, h("div", { class: "picker-grid" }, picker.element, go.element), recentRow, recentProblem);

  // ----- Results -----

  // Not a live region: a whole result card is far too much for a screen reader to read out. Each
  // outcome announces one sentence instead, below.
  const result = h("div", { class: "result-area" });
  const intro = card(
    { className: "intro-card" },
    h("p", { class: "intro-summary", text: plugin.product.summary }),
    howItWorks(plugin.product.steps),
  );

  function show(...nodes) {
    intro.hidden = true;
    result.classList.remove("stale");
    result.replaceChildren(...nodes);
  }

  function start(asOf) {
    if (run.busy) return;
    picker.set(asOf);
    if (!picker.valid()) return;
    progress = { asOf, constituents: null, received: 0, collecting: false };
    if (shown && result.firstChild) result.classList.add("stale");
    else show(h("div", { class: "card large" }, skeleton({ lines: 3, block: true })));
    recent.select(null);
    run.start({ as_of: asOf });
    // Starting disables "Find the fallers" and replaces a "Run again" button, either of which drops
    // the keyboard to the top of the page; the progress card is where the run now is.
    run.element.focus({ preventScroll: true });
    run.element.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  function track(name, data, controller) {
    switch (name) {
      case "task.started":
      case "task.reference":
        controller.step("pin", { detail: "Every company's close on both days, so the agent's answer can be checked — the slowest part of the run.", progress: "indeterminate" });
        break;
      case "task.tool":
        trackTool(data, controller);
        break;
      case "task.answer":
        controller.step("check");
        break;
    }
  }

  function trackTool(tool, controller) {
    const parsed = parseToolOutput(tool.output);
    if (tool.isError || !parsed?.ok) {
      controller.step(progress.collecting ? "collect" : "week");
      controller.note(failedCallNote(tool));
      return;
    }
    if (tool.name === "list_constituents") {
      progress.constituents = parsed.constituents.length;
      controller.step("week", { state: "done", detail: `${formatWeek(parsed.start, parsed.as_of)} · ${parsed.constituents.length} companies` });
    } else if (tool.name === "get_closes") {
      progress.collecting = true;
      progress.received += parsed.closes.length;
      const needed = progress.constituents ? progress.constituents * 2 : null;
      controller.step("collect", {
        detail: needed ? `${Math.min(progress.received, needed)} of ${needed} prices` : `${progress.received} prices`,
        progress: needed ? progress.received / needed : "indeterminate",
      });
    } else if (tool.name === "submit_tickers") {
      controller.step("pick", { detail: parsed.tickers === 0 ? "Picked none" : `Picked ${parsed.tickers} ${parsed.tickers === 1 ? "stock" : "stocks"}` });
    }
  }

  async function finished(outcome) {
    const { asOf } = progress;
    // `details.expected` is the list the result card shows (the verifier's own recomputation), so a
    // verdict without it is shown as a problem rather than drawn from the agent's numbers.
    if (outcome.verdict?.details?.expected) {
      const week = weekFromRun(asOf, outcome);
      shown = week;
      show(resultCard(week));
      announce(result.firstChild.getAttribute("aria-label"));
      try {
        await writeJSON(`${SAVED}${asOf}.json`, week);
        await loadRecent(asOf);
      } catch (problem) {
        result.append(banner({ tone: "warn", title: "This week couldn't be saved to your recent weeks.", body: problem.message }));
      }
      return;
    }
    shown = null;
    const message = outcome.error ?? (outcome.verdict ? `the check returned no list: ${outcome.verdict.message}` : "The run ended without checking an answer.");
    const fix = outcome.error ? errorFix(outcome.error, today) : null;
    const actions = fix
      ? [h("button", { type: "button", class: "button primary small", text: `Use ${formatDay(fix, { year: false })}`, onclick: () => (picker.set(fix), picker.setCaption(caption(fix)), refreshButton(), go.button.focus()) })]
      : [h("button", { type: "button", class: "button small", onclick: () => start(asOf) }, icon("refresh", { size: 15 }), "Run again")];
    show(errorCard({ message, rules: ERROR_RULES, title: outcome.startFailed ? "Couldn't start" : undefined, actions }));
    announce(explainError(message, ERROR_RULES).text);
  }

  // ----- Recent weeks (one file per week in the workspace) -----

  let saved = new Map();
  async function loadRecent(selected = null) {
    const files = (await listFiles({ prefix: SAVED, extensions: [".json"] })).reverse().slice(0, RECENT);
    const weeks = [];
    const unreadable = [];
    for (const file of files) {
      try {
        weeks.push(checkSavedWeek(await readJSON(file.path), file.path));
      } catch (problem) {
        unreadable.push(problem.message);
      }
    }
    saved = new Map(weeks.map((week) => [week.as_of, week]));
    recent.setItems(weeks.map((week) => ({ label: savedChipLabel(week), value: week.as_of, tone: week.verdict.valid ? "ok" : "warn", title: `${formatWeek(week.start, week.as_of)}: show the saved result`, selected: week.as_of === selected })));
    recentRow.hidden = weeks.length === 0;
    recentProblem.hidden = unreadable.length === 0;
    recentProblem.textContent = unreadable.length ? `Some saved weeks couldn't be read: ${unreadable.join(" ")}` : "";
  }

  function showSaved(asOf) {
    const week = saved.get(asOf);
    shown = week;
    recent.select(asOf);
    picker.set(asOf);
    picker.setCaption(caption(asOf));
    refreshButton();
    run.hide();
    const again = h("button", { type: "button", class: "button small", onclick: () => start(asOf) }, icon("refresh", { size: 15 }), "Run again");
    show(resultCard(week, { saved: true, actions: [again] }));
  }

  try {
    await loadRecent();
  } catch (problem) {
    recentProblem.hidden = false;
    recentProblem.textContent = `Your recent weeks couldn't be listed: ${problem.message}`;
  }
  refreshButton();
  shell.main.append(pickerCard, run.element, result, intro);
  return shell.element;
}
