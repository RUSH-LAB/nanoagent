// Running a task: `taskRun` (runTask with a progress card, Stop and a collected outcome), a run
// button, the verdict in plain words, errors in plain words, and the generic developer views
// (runControls, taskView, toolItem, verdictView).

import { request, startRun } from "./bridge.js";
import { banner, disclosure } from "./display.js";
import { announce, formatDuration, h, humanize, icon, pretty } from "./dom.js";
import { schemaForm } from "./forms.js";
import { metricsLine } from "./session.js";

/**
 * A `task.tool` event's `output` (the tool's JSON text) parsed, or null when it is not JSON.
 * @param {string|object} output
 * @returns {object|null}
 */
export function parseToolOutput(output) {
  if (output && typeof output === "object") return output;
  try {
    const value = JSON.parse(output);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * How a run ended, as {@link taskRun} reports it.
 * @typedef {object} RunOutcome
 * @property {"valid"|"invalid"|"error"|"cancelled"|"unchecked"} status `valid`/`invalid`: the
 *   verifier's verdict; `error`: a `task.error` (or the host refused to start); `cancelled`:
 *   stopped by the user; `unchecked`: the run ended with neither a verdict nor an error.
 * @property {{valid: boolean, score: number, message: string, details: object}|null} verdict
 * @property {string|null} error The `task.error` message.
 * @property {string|null} answer The agent's `task.answer` text.
 * @property {unknown} result A tool runner's `task.result` response.
 * @property {Array<{name: string, arguments: object, output: string, isError: boolean, data: object|null}>} tools
 *   Every `task.tool` event, with `data` the parsed output.
 * @property {number} seconds How long it took.
 * @property {{model: string|null, cost: number, usage: object, ttft_s: number|null, generation_s: number, duration_s: number}|null} metrics
 *   What the run cost and how long it took, from `task.done`; null for a run that did not finish.
 * @property {boolean} [startFailed] True when the host refused to start the run (show "Couldn't start").
 */

const GENERIC_STEPS = [
  { id: "start", label: "Getting ready" },
  { id: "work", label: "Working on it" },
  { id: "check", label: "Checking the result" },
];

/**
 * One task run with its progress card: runs `runTask` through the bridge, shows plain-language
 * steps with an elapsed timer and a Stop button, and resolves with the whole {@link RunOutcome}.
 *
 * Steps only move forward: making a step active marks every step before it done. Pages drive
 * their own steps from `onEvent` (mapping `task.*` events to words; never show tool names).
 * Without `steps`, the run uses three generic ones and moves them itself.
 *
 * @param {object} options
 * @param {string} options.task The task id.
 * @param {string} [options.title] The card's title while running, e.g. "Finding the fallers".
 * @param {Array<{id: string, label: string}>} [options.steps]
 * @param {(name: string, data: object, run: object) => void} [options.onEvent] Each `task.*` event.
 * @param {(outcome: RunOutcome) => void} [options.onFinish] After `task.done` (or a failed start).
 * @param {string} [options.stopLabel] Default "Stop".
 * @param {boolean} [options.keepSteps] Keep the step list open after a verdict (default: it folds
 *   into "Show steps"; after an error or a stop it stays open so people see how far it got).
 * @returns {{element: HTMLElement, start: (args: object) => Promise<RunOutcome>, cancel: () => Promise<void>, readonly busy: boolean, step: (id: string, update?: {state?: "active"|"done"|"failed", detail?: string, progress?: number|"indeterminate"|null}) => void, note: (text: string, options?: {step?: string, tone?: string}) => void, setTitle: (title: string) => void, hide: () => void, subscribe: (listener: (busy: boolean) => void) => () => void}}
 */
export function taskRun({ task, title = "Working on it", steps, onEvent, onFinish, stopLabel = "Stop", keepSteps = false }) {
  const generic = !steps;
  const plan = steps ?? GENERIC_STEPS;
  const listeners = new Set();
  let runId = null;
  let busy = false;
  let began = 0;
  let timer = null;
  let current = -1;
  let outcome = null;

  const titleText = h("h2", { class: "run-title", text: title });
  const metricsText = h("p", { class: "run-metrics", hidden: true });
  const clock = h("span", { class: "run-clock", "aria-hidden": "true" });
  const stop = h("button", { type: "button", class: "button small" }, icon("stop", { size: 15 }), h("span", { text: stopLabel }));
  const toggle = h("button", { type: "button", class: "button ghost small", hidden: true, "aria-expanded": "true", text: "Hide steps" });
  const rows = plan.map((one) => {
    const detail = h("span", { class: "step-detail" });
    const bar = h("span", { class: "step-bar", hidden: true }, h("span", { class: "step-bar-fill" }));
    const notes = h("ul", { class: "step-notes" });
    const element = h("li", { class: "step", "data-state": "pending" }, h("span", { class: "step-mark", "aria-hidden": "true" }), h("div", { class: "step-body" }, h("span", { class: "step-label", text: one.label }), detail, bar, notes));
    return { ...one, element, detail, bar, notes };
  });
  const list = h("ol", { class: "steps" }, rows.map((row) => row.element));
  const element = h(
    "section",
    { class: "card run-card", hidden: true, "aria-label": title },
    h("header", { class: "run-head" }, h("span", { class: "run-spinner", "aria-hidden": "true" }), titleText, clock, toggle, stop),
    metricsText,
    list,
  );

  const notify = () => listeners.forEach((listener) => listener(busy));
  const tick = () => (clock.textContent = formatDuration((Date.now() - began) / 1000));
  const indexOf = (id) => {
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) throw new Error(`Run "${task}" has no step ${JSON.stringify(id)}.`);
    return index;
  };
  const setState = (row, state) => {
    row.element.dataset.state = state;
    if (state !== "active") row.bar.hidden = true;
  };

  /** Move to a step or update it. */
  function step(id, { state = "active", detail, progress } = {}) {
    const index = indexOf(id);
    const row = rows[index];
    if (index < current && state === "active") return; // forward only
    if (state === "active" || state === "done") {
      for (const earlier of rows.slice(0, index)) if (earlier.element.dataset.state !== "failed") setState(earlier, "done");
    }
    if (index > current) {
      current = index;
      if (state === "active") announce(row.label);
    }
    setState(row, state);
    if (detail !== undefined) row.detail.textContent = detail;
    if (progress !== undefined && state === "active") {
      row.bar.hidden = progress === null;
      row.bar.classList.toggle("indeterminate", progress === "indeterminate");
      if (typeof progress === "number") row.bar.firstChild.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
    }
  }

  /** A muted line under a step (default the active one), e.g. "Nasdaq had no price for XYZ; the agent retried". */
  function note(text, { step: id, tone = "neutral" } = {}) {
    const row = id ? rows[indexOf(id)] : rows[Math.max(0, current)];
    row.notes.append(h("li", { class: `tone-${tone}`, text }));
  }

  const showSteps = (open) => {
    list.hidden = !open;
    toggle.textContent = open ? "Hide steps" : "Show steps";
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => showSteps(list.hidden));

  const finish = () => {
    clearInterval(timer);
    busy = false;
    runId = null;
    outcome.seconds = (Date.now() - began) / 1000;
    if (outcome.status === "unchecked" && outcome.verdict) outcome.status = outcome.verdict.valid ? "valid" : "invalid";
    const words = {
      valid: `Done in ${formatDuration(outcome.seconds)}`,
      invalid: `Done in ${formatDuration(outcome.seconds)}`,
      unchecked: `Ended after ${formatDuration(outcome.seconds)} without a check`,
      error: `Stopped by a problem after ${formatDuration(outcome.seconds)}`,
      cancelled: `Stopped after ${formatDuration(outcome.seconds)}`,
    }[outcome.status];
    if (outcome.status === "valid" || outcome.status === "invalid") {
      for (const row of rows) if (row.element.dataset.state !== "failed") setState(row, "done");
    } else if (current >= 0 && rows[current].element.dataset.state === "active") {
      setState(rows[current], outcome.status === "cancelled" ? "stopped" : "failed");
    }
    element.dataset.status = outcome.status;
    titleText.textContent = words;
    metricsText.hidden = !outcome.metrics;
    if (outcome.metrics) metricsText.textContent = metricsLine(outcome.metrics);
    clock.textContent = "";
    stop.hidden = true;
    toggle.hidden = false;
    showSteps(keepSteps || !(outcome.status === "valid" || outcome.status === "invalid"));
    announce(words);
    notify();
    onFinish?.(outcome);
  };

  const controller = {
    element,
    get busy() {
      return busy;
    },
    step,
    note,
    setTitle(text) {
      titleText.textContent = text;
    },
    hide() {
      element.hidden = true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async cancel() {
      if (!runId) return;
      stop.disabled = true;
      stop.lastChild.textContent = "Stopping…";
      try {
        await request("cancel", { runId });
      } catch (problem) {
        stop.disabled = false;
        stop.lastChild.textContent = stopLabel;
        note(`Couldn't stop: ${problem.message}`, { tone: "bad" });
      }
    },
    start(args) {
      if (busy) return Promise.reject(new Error(`A run of ${task} is already in progress.`));
      busy = true;
      outcome = { status: "unchecked", verdict: null, error: null, answer: null, result: null, tools: [], seconds: 0, metrics: null };
      metricsText.hidden = true;
      current = -1;
      for (const row of rows) {
        setState(row, "pending");
        row.detail.textContent = "";
        row.notes.replaceChildren();
      }
      delete element.dataset.status;
      titleText.textContent = title;
      stop.hidden = false;
      stop.disabled = false;
      stop.lastChild.textContent = stopLabel;
      toggle.hidden = true;
      showSteps(true);
      element.hidden = false;
      began = Date.now();
      tick();
      timer = setInterval(tick, 1000);
      notify();
      if (generic) step("start");
      return new Promise((resolve) => {
        const done = () => {
          finish();
          resolve(outcome);
        };
        startRun("runTask", { task, arguments: args }, (name, data) => {
          switch (name) {
            case "task.tool":
              outcome.tools.push({ ...data, data: parseToolOutput(data.output) });
              if (generic) step("work", { detail: `${outcome.tools.length} step${outcome.tools.length === 1 ? "" : "s"} done` });
              break;
            case "task.answer":
              outcome.answer = data.text ?? "";
              if (generic) step("check");
              break;
            case "task.result":
              outcome.result = data.response;
              if (generic) step("check");
              break;
            case "task.verdict":
              outcome.verdict = data;
              outcome.status = data.valid ? "valid" : "invalid";
              break;
            case "task.error":
              outcome.error = data.message ?? "";
              outcome.status = outcome.error === "cancelled" ? "cancelled" : "error";
              break;
          }
          if (name === "task.done") outcome.metrics = data.metrics ?? null;
          if (name === "task.reference" && generic) step("start", { detail: "Prepared the answer key" });
          onEvent?.(name, data, controller);
          if (name === "task.done") done();
        })
          .then((id) => {
            if (busy) runId = id;
          })
          .catch((problem) => {
            outcome.error = problem.message;
            outcome.status = "error";
            outcome.startFailed = true;
            done();
          });
      });
    },
  };
  stop.addEventListener("click", () => controller.cancel());
  return controller;
}

/**
 * The page's primary button for a run, e.g. "Find the fallers". With `run`, it is disabled while
 * that run is busy, or, with `cancelWhileBusy`, turns into a Cancel button for it. A reason it
 * can't be pressed yet ("Add both files to start") shows under it.
 * @param {{label: string, onClick: () => void, run?: object, cancelWhileBusy?: boolean, note?: string, block?: boolean}} options
 *   `note` is a muted line under the button ("Takes about 5–10 minutes"); `block` makes it full width.
 * @returns {{element: HTMLElement, button: HTMLButtonElement, setLabel: (label: string) => void, setBlocked: (reason: string|null) => void}}
 */
export function runButton({ label, onClick, run, cancelWhileBusy = false, note, block = false }) {
  let text = label;
  let blocked = null;
  const button = h("button", { type: "button", class: `button primary large${block ? " block" : ""}`, text: label });
  const reason = h("p", { class: "run-reason", hidden: true });
  const render = () => {
    const busy = run?.busy ?? false;
    button.textContent = busy && cancelWhileBusy ? "Cancel" : text;
    button.classList.toggle("primary", !(busy && cancelWhileBusy));
    button.disabled = busy ? !cancelWhileBusy : Boolean(blocked);
    reason.textContent = busy ? "" : blocked ?? "";
    reason.hidden = busy || !blocked;
  };
  button.addEventListener("click", () => (run?.busy && cancelWhileBusy ? run.cancel() : onClick()));
  run?.subscribe(render);
  render();
  return {
    element: h("div", { class: `run-button${block ? " block" : ""}` }, button, reason, note ? h("p", { class: "muted small-text", text: note }) : null),
    button,
    setLabel(next) {
      text = next;
      render();
    },
    setBlocked(next) {
      blocked = next;
      render();
    },
  };
}

/**
 * The verifier's verdict in plain words, as a banner: a check icon and "Checked" when valid, a
 * warning when not, the score in words, and the raw message and details under "Details" (never as
 * the headline). Pages pass their own words.
 * @param {{valid: boolean, score?: number, message?: string, details?: object}} verdict A `task.verdict`.
 * @param {object} [words] Overrides, or a function of the verdict returning them:
 *   `{tone, title, body, lines, actions, score}`; `score` is the score in words, or "" for none.
 * @returns {HTMLElement}
 */
export function verdictBanner(verdict, words = {}) {
  const custom = typeof words === "function" ? words(verdict) : words;
  const score = typeof verdict.score === "number" ? `Score ${Math.round(verdict.score * 100)}%` : "";
  const base = verdict.valid
    ? { tone: "ok", title: "Checked: the result passed the plugin's own check.", body: undefined, score: verdict.score < 1 ? score : "" }
    : { tone: "warn", title: "The check found problems with this result.", body: undefined, score };
  const merged = { ...base, ...custom };
  const raw = h("div", { class: "verdict-raw" }, verdict.message ? h("p", { text: verdict.message }) : null, verdict.details && Object.keys(verdict.details).length ? h("pre", { text: pretty(verdict.details) }) : null);
  return banner({
    tone: merged.tone,
    title: merged.title,
    body: [merged.body, merged.score].filter(Boolean).join(" · ") || undefined,
    lines: merged.lines,
    actions: merged.actions,
    details: raw.childNodes.length ? raw : undefined,
  });
}

/**
 * Rules that turn known error messages into plain words; pages pass their own first. A rule's
 * `match` is a substring, a RegExp, or a function of the message; `text` is the words (or a
 * function of the message and the RegExp match); `tone` defaults to "bad".
 * @typedef {{match: string|RegExp|((message: string) => boolean), text: string|((message: string, found: RegExpMatchArray|null) => string), tone?: string, id?: string}} ErrorRule
 */

/** The kit's own rules, tried after a page's: stops, maintenance, timeouts, network trouble. */
export const COMMON_ERRORS = Object.freeze([
  { id: "cancelled", match: (message) => message === "cancelled", text: "Stopped. Nothing more will happen in this run.", tone: "neutral" },
  { id: "maintenance", match: "under maintenance", text: "This app is under maintenance right now. Try again later." },
  { id: "timeout", match: /timed? ?out|TimeoutError/i, text: "It ran out of time before finishing. Try again." },
  { id: "host", match: "No NanoAgent host", text: "This page has to be opened from Mochi." },
  { id: "network", match: /URLError|Connection(Error| refused| reset)|HTTP Error 5\d\d/, text: "Couldn't reach the service it needs. Try again in a minute." },
]);

/**
 * A message in plain words: the first matching rule of `rules`, then {@link COMMON_ERRORS}, else
 * "Something went wrong." The raw message is always kept for "Technical details".
 * @param {string} message
 * @param {ErrorRule[]} [rules]
 * @returns {{text: string, tone: string, rule: string|null, raw: string}}
 */
export function explainError(message, rules = []) {
  const raw = String(message ?? "");
  for (const rule of [...rules, ...COMMON_ERRORS]) {
    let found = null;
    let hit;
    if (typeof rule.match === "string") hit = raw.includes(rule.match);
    else if (rule.match instanceof RegExp) hit = Boolean((found = raw.match(rule.match)));
    else hit = rule.match(raw);
    if (hit) return { text: typeof rule.text === "function" ? rule.text(raw, found) : rule.text, tone: rule.tone ?? "bad", rule: rule.id ?? null, raw };
  }
  return { text: "Something went wrong.", tone: "bad", rule: null, raw };
}

/**
 * An error in plain words, as a banner with the raw message under "Technical details" and an
 * optional action (e.g. "Try again", "Use Fri, Oct 2").
 * @param {{message: string, rules?: ErrorRule[], title?: string, actions?: Node[]}} options
 *   `title` replaces the plain words' headline (they become the body), e.g. "Couldn't start".
 * @returns {HTMLElement}
 */
export function errorCard({ message, rules = [], title, actions = [] }) {
  const plain = explainError(message, rules);
  return banner({
    tone: plain.tone,
    title: title ?? plain.text,
    body: title ? plain.text : undefined,
    actions,
    details: plain.raw && plain.raw !== "cancelled" ? plain.raw : undefined,
    detailsLabel: "Technical details",
  });
}

// ---------------------------------------------------------------------------------------------
// Developer views: a task's own form and its raw event stream.

function compact(value, limit = 90) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * A tool call as a collapsible line: its name, arguments, and output. For developer views only:
 * a designed page never shows tools to its users.
 * @param {{name: string, arguments?: object, output?: string, isError?: boolean}} call A `task.tool` event.
 * @returns {HTMLDetailsElement}
 */
export function toolItem({ name, arguments: args, output, isError }) {
  return h(
    "details",
    { class: `tool${isError ? " error" : ""}` },
    h("summary", {}, h("span", { class: "tool-name", text: name }), h("code", { class: "tool-args", text: compact(args ?? {}) }), isError ? h("span", { class: "pill tone-bad", text: "error" }) : null),
    h("div", { class: "tool-body" }, h("h4", { text: "Arguments" }), h("pre", { text: pretty(args ?? {}) }), h("h4", { text: "Output" }), h("pre", { text: pretty(output ?? "") })),
  );
}

/**
 * A verdict as the verifier states it: valid or not, the score, the message and the raw details.
 * For developer views; a designed page uses {@link verdictBanner}.
 * @param {{valid: boolean, score?: number, message?: string, details?: object}} verdict
 * @returns {HTMLElement}
 */
export function verdictView({ valid, score, message, details }) {
  const hasDetails = details && typeof details === "object" && Object.keys(details).length > 0;
  return h(
    "section",
    { class: `verdict tone-${valid ? "ok" : "bad"}`, "aria-label": "Verdict" },
    h(
      "div",
      { class: "verdict-head" },
      h("span", { class: `pill tone-${valid ? "ok" : "bad"}`, text: valid ? "Valid" : "Not valid" }),
      typeof score === "number" ? h("span", { class: "score" }, h("meter", { min: 0, max: 1, value: score, "aria-label": "Score" }), `score ${Number(score.toFixed(3))}`) : null,
    ),
    message ? h("p", { class: "verdict-message", text: message }) : null,
    hasDetails ? disclosure({ summary: "Details" }, h("pre", { text: pretty(details) })) : null,
  );
}

/**
 * A titled block of text in a run's timeline.
 * @param {string} title
 * @param {string} content
 * @param {string} [className]
 * @returns {HTMLElement}
 */
export function block(title, content, className = "") {
  return h("section", { class: `block ${className}` }, h("h4", { text: title }), h("pre", { class: "prose", text: content }));
}

/**
 * Run and Cancel buttons with a live status line, for a form-driven run.
 * @param {{task: {id: string}, start: () => object, onEvent: (name: string, data: object) => void, onFinish?: () => void, label?: string}} options
 *   `start()` returns the task arguments (or throws to stop with its message); `onEvent` gets each
 *   task event; `onFinish` runs after `task.done` or a failed start.
 * @returns {{element: HTMLElement, run: () => Promise<void>}}
 */
export function runControls({ task, start, onEvent, onFinish, label = "Run" }) {
  const runButtonElement = h("button", { type: "submit", class: "button primary", text: label });
  const cancelButton = h("button", { type: "button", class: "button", text: "Cancel", hidden: true });
  const status = h("span", { class: "run-status", role: "status", "aria-live": "polite" });
  let runId = null;
  let timer = null;
  let began = 0;

  const setStatus = (text, tone = "") => {
    status.textContent = text;
    status.dataset.tone = tone;
  };
  const tick = () => setStatus(`Running… ${formatDuration((Date.now() - began) / 1000)}`, "busy");
  const finish = (text, tone) => {
    clearInterval(timer);
    runId = null;
    runButtonElement.disabled = false;
    cancelButton.hidden = true;
    cancelButton.disabled = false;
    setStatus(text, tone);
    onFinish?.();
  };

  async function run() {
    let args;
    try {
      args = start();
    } catch (problem) {
      setStatus(problem.message, "bad");
      return;
    }
    runButtonElement.disabled = true;
    began = Date.now();
    tick();
    timer = setInterval(tick, 1000);
    let outcome = { text: "Finished", tone: "" };
    try {
      runId = await startRun("runTask", { task: task.id, arguments: args }, (name, data) => {
        if (name === "task.verdict") outcome = data.valid ? { text: "Finished: valid", tone: "ok" } : { text: "Finished: not valid", tone: "bad" };
        if (name === "task.error") outcome = { text: "Failed", tone: "bad" };
        onEvent(name, data);
        if (name === "task.done") {
          const took = `${outcome.text} in ${formatDuration((Date.now() - began) / 1000)}`;
          finish(data.metrics ? `${took} · ${metricsLine(data.metrics)}` : took, outcome.tone);
        }
      });
      if (runButtonElement.disabled) cancelButton.hidden = false;
    } catch (problem) {
      onEvent("task.error", { message: problem.message });
      finish("Could not start", "bad");
    }
  }

  cancelButton.addEventListener("click", async () => {
    if (!runId) return;
    cancelButton.disabled = true;
    setStatus("Cancelling…", "busy");
    try {
      await request("cancel", { runId });
    } catch (problem) {
      cancelButton.disabled = false;
      setStatus(`Cancel failed: ${problem.message}`, "bad");
    }
  });

  return { element: h("div", { class: "run-controls" }, runButtonElement, cancelButton, status), run };
}

/**
 * The generic developer view of one task: its schema form, Run/Cancel, and the raw event stream
 * (tool calls included). Not for a plugin's users.
 * @param {{id: string, description: string, runner: string, tools: string[], reference: string|null, instructions: string, inputSchema?: object}} task A catalog task.
 * @param {{files?: {refresh: () => void}}} [ctx] `files.refresh()` is called after each run.
 * @returns {HTMLElement}
 */
export function taskView(task, ctx = {}) {
  const header = h("header", { class: "task-head" }, h("h2", {}, humanize(task.id), " ", h("span", { class: "pill tone-info", text: task.runner })), h("p", { class: "muted", text: task.description }));
  const about = disclosure(
    { summary: "How this task runs", className: "about" },
    h("p", {}, "Tools: ", task.tools.map((tool, index) => [index ? ", " : "", h("code", { text: tool })])),
    task.reference ? h("p", {}, "Reference: ", h("code", { text: task.reference })) : null,
    h("pre", { class: "prose", text: task.instructions }),
  );
  if (!task.inputSchema) {
    return h("article", { class: "card task" }, header, h("p", { class: "error-text", text: "The host's catalog gives no inputSchema for this task, so it has no form." }));
  }
  const form = schemaForm(task.inputSchema);
  const timeline = h("ol", { class: "timeline", "aria-label": "Run events" });
  const add = (node) => timeline.append(h("li", {}, node));
  const controls = runControls({
    task,
    start: () => {
      const args = form.read();
      timeline.replaceChildren();
      return args;
    },
    onEvent: (name, data) => {
      switch (name) {
        case "task.started":
          add(h("p", { class: "event", text: `Started ${data.task ?? task.id}` }));
          break;
        case "task.reference":
          add(h("p", { class: "event" }, "Pinned the reference ", h("code", { text: data.tool })));
          break;
        case "task.tool":
          add(toolItem(data));
          break;
        case "task.answer":
          add(block("Answer", data.text ?? "", "answer"));
          break;
        case "task.result":
          add(block("Result", pretty(data.response), "result"));
          break;
        case "task.verdict":
          add(verdictView(data));
          break;
        case "task.error":
          add(h("p", { class: "error-text", role: "alert", text: data.message }));
          break;
        case "task.done":
          break;
        default:
          add(h("p", { class: "event muted", text: name }));
      }
    },
    onFinish: () => ctx.files?.refresh(),
  });
  const formElement = h("form", { class: "task-form", novalidate: true }, form.element, controls.element);
  formElement.addEventListener("submit", (event) => {
    event.preventDefault();
    controls.run();
  });
  return h("article", { class: "card task" }, header, about, formElement, timeline);
}
