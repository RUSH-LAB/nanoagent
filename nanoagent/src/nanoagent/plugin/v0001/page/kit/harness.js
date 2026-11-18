// The Harness tab every plugin's page has (kit/shell.js): the person picks a harness and asks, and one of the plugin's tasks
// is worked by that harness on their own computer, as a benchmark case is, on a terminal they work in: the harness's own
// screen, live, which they type at until it ends. Terminal is a plain shell there, where they bring their own agent and save it
// (`rush save`) as a harness of theirs, which the picker then offers too.

import { startRun, request } from "./bridge.js";
import { h } from "./dom.js";
import { formatCost, formatSeconds, thousands } from "./session.js";
import { Terminal } from "./vendor/xterm/xterm.mjs";
import { FitAddon } from "./vendor/xterm/addon-fit.mjs";

/**
 * The harnesses the tab runs, NanoAgent's reference harness first: each one's id (the reference harness RUSH builds), its name
 * here, and how it works the task. The way it works follows from the harness: RUSH works with the task's own tools, every other
 * harness from the coding prompt with its own.
 */
export const HARNESSES = [
  ["nanoagent", "RUSH", "Works the task with the plugin's own tools, as the Session's agent does."],
  ["claude-code", "Claude Code", "Codes its answer with its own tools from the task's prompt."],
  ["codex", "Codex", "Codes its answer with its own tools from the task's prompt."],
  ["pi", "PI", "Codes its answer with its own tools from the task's prompt."],
  ["dsh", "DSH", "Codes its answer with its own tools from the task's prompt."],
  ["hermes", "Hermes", "Codes its answer with its own tools from the task's prompt."],
  ["shell", "Terminal", "A shell in the task's workspace, the model a call away through RUSH: run any agent, leave answer.json, exit. `rush save <name>` keeps it."],
];

// Leaving the alternate screen (DEC private modes 47, 1047 and 1049): a full-screen program's last screen stays shown when it ends.
const ALTERNATE_SCREEN = new Set([47, 1047, 1049]);
const bytes = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

/** The status line of an ended session: right or wrong by the plugin's verifier when it gave an answer, then time, tokens and cost. */
export function outcomeText(outcome) {
  const verdict = !outcome.scored
    ? `No answer to score (${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""})`
    : outcome.verdict === "Pass" ? "Right" : outcome.verdict === "Fail" ? "Wrong" : outcome.verdict;
  const tokens = outcome.inputTokens === null ? "—" : thousands((outcome.inputTokens ?? 0) + (outcome.outputTokens ?? 0));
  return [verdict, formatSeconds(outcome.elapsedMs === null ? null : outcome.elapsedMs / 1000), `${tokens} tokens`, formatCost(outcome.cost)].join(" · ");
}

/**
 * The Harness tab: a harness picker (and, for a plugin of several tasks, the task) and the request that opens a session, the
 * harness's terminal, and one status line. One session at a time; Stop ends it, as the harness exiting does.
 * @returns {HTMLElement}
 */
export function harnessPage(plugin) {
  let harness = HARNESSES[0][0];
  let task = plugin.tasks[0];
  let runId = null;
  const about = h("p", { class: "muted small-text" });
  // The reference harnesses, then the person's own as RUSH lists them.
  const options = [...HARNESSES];
  const button = ([id, label]) => h("button", { type: "button", class: "button small", "aria-pressed": String(id === harness), text: label, onclick: () => pick(id) });
  const choices = options.map(button);
  const pickRow = h("div", { class: "harness-pick", role: "group", "aria-label": "Harness" }, choices);
  function pick(id) {
    harness = id;
    for (const [index, choice] of choices.entries()) choice.setAttribute("aria-pressed", String(options[index][0] === id));
    about.textContent = options.find(([each]) => each === id)[2];
  }
  pick(harness);
  request("harness.saved")
    .then(({ harnesses }) => {
      for (const saved of harnesses) {
        const option = [saved.name, saved.name, `Your harness, saved from a Terminal session (version ${saved.version}): runs what you saved, from the task's prompt.`];
        options.push(option);
        choices.push(button(option));
        pickRow.append(choices.at(-1));
      }
    })
    .catch((problem) => (status.textContent = problem.message));
  const taskPick =
    plugin.tasks.length > 1
      ? h("select", { class: "input", "aria-label": "Task", onchange: (event) => (task = plugin.tasks.find((one) => one.id === event.target.value)) }, plugin.tasks.map((one) => h("option", { value: one.id, text: one.description })))
      : null;
  const placeholder = `What to ask ${plugin.name} first; then type in the terminal`;
  const input = h("textarea", { class: "input", rows: 1, placeholder, "aria-label": placeholder });
  const runButton = h("button", { type: "button", class: "button primary", text: "Start" });
  const stop = h("button", { type: "button", class: "button", text: "Stop", hidden: true });
  const status = h("p", { class: "harness-status muted small-text", role: "status", text: `Pick a harness and ask: it works ${plugin.name}'s task on your computer, on the terminal below, where you go on typing.` });
  const screen = h("div", { class: "harness-terminal" });

  const terminal = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000, theme: { background: "#14161b" } });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => params.some((mode) => ALTERNATE_SCREEN.has(mode)));
  // What the person types, and the terminal's size, go to the harness while its session runs.
  const send = (method, params) => runId && request(method, { runId, ...params }).catch((problem) => (status.textContent = problem.message));
  terminal.onData((data) => send("harness.input", { data }));
  terminal.onResize(({ rows, cols }) => send("harness.resize", { rows, cols }));
  // The terminal opens once its tab is first shown, the size it measures by, and fits its box from then on.
  let opened = false;
  new ResizeObserver(() => {
    if (!screen.offsetParent) return;
    if (!opened) terminal.open(screen);
    opened = true;
    fit.fit();
  }).observe(screen);

  async function submit() {
    const text = input.value.trim();
    if (!text || runButton.disabled) return;
    const label = options.find(([id]) => id === harness)[1];
    terminal.reset();
    status.textContent = `${label} · ${task.description} · starting: the first session of a harness builds it`;
    runButton.disabled = true;
    for (const button of choices) button.disabled = true;
    let started = false;
    const done = () => {
      runId = null;
      runButton.disabled = false;
      for (const button of choices) button.disabled = false;
      stop.hidden = true;
      stop.disabled = false;
    };
    try {
      runId = await startRun("harness.run", { harness, task: task.id, text }, (name, data) => {
        switch (name) {
          case "harness.output":
            if (!started) {
              started = true;
              status.textContent = `${label} · ${task.description} · running: type in the terminal; Stop ends the session`;
            }
            terminal.write(bytes(data.data));
            break;
          case "harness.outcome":
            status.textContent = `${label} · ${outcomeText(data)}`;
            break;
          case "harness.error":
            status.textContent = data.message;
            break;
          case "harness.done":
            done();
            break;
        }
      });
      if (runButton.disabled) {
        input.value = "";
        stop.hidden = false;
        send("harness.resize", { rows: terminal.rows, cols: terminal.cols });
        terminal.focus();
      }
    } catch (problem) {
      status.textContent = problem.message;
      done();
    }
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  runButton.addEventListener("click", () => submit());
  stop.addEventListener("click", async () => {
    if (!runId) return;
    stop.disabled = true;
    try {
      await request("harness.cancel", { runId });
    } catch (problem) {
      stop.disabled = false;
      status.textContent = `Stop failed: ${problem.message}`;
    }
  });

  const head = h("div", { class: "harness-head" }, pickRow, about, taskPick);
  const ask = h("div", { class: "harness-ask" }, input, stop, runButton);
  return h("section", { class: "harness-page", "aria-label": "Harness" }, head, ask, screen, status);
}
