// The Harness tab every plugin's page has (kit/shell.js): the person's own terminal on their computer, in the harness VM, in the
// workspace of one case of the plugin's task, with the model a call away through RUSH (which records every call) and the
// reference CLIs installed. They run any agent there; when they leave the shell, the answer.json it left is scored as a
// benchmark case is, and `rush save <name>` there keeps what they built as a harness of theirs.

import { startRun, request } from "./bridge.js";
import { h } from "./dom.js";
import { formatCost, formatSeconds, thousands } from "./session.js";
import { Terminal } from "./vendor/xterm/xterm.mjs";
import { FitAddon } from "./vendor/xterm/addon-fit.mjs";

// Leaving the alternate screen (DEC private modes 47, 1047 and 1049): a full-screen program's last screen stays shown when it ends.
const ALTERNATE_SCREEN = new Set([47, 1047, 1049]);
const bytes = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

/**
 * The status line of an ended session: right or wrong by the plugin's verifier when it gave an answer (or that it ran out of its
 * time, sessions.wall_time_ms), then time, tokens and cost.
 */
export function outcomeText(outcome) {
  const verdict = outcome.reason === "timed_out"
    ? "Session time limit reached"
    : !outcome.scored
    ? `No verdict: no answer to score (${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""})`
    : outcome.verdict === "Pass" ? "Right" : outcome.verdict === "Fail" ? "Wrong" : outcome.verdict;
  const tokens = outcome.inputTokens === null ? "—" : thousands((outcome.inputTokens ?? 0) + (outcome.outputTokens ?? 0));
  return [verdict, formatSeconds(outcome.elapsedMs === null ? null : outcome.elapsedMs / 1000), `${tokens} tokens`, formatCost(outcome.cost)].join(" · ");
}

/**
 * The Harness tab: the terminal, opened when the tab is first shown and again by Start, and one status line; Stop ends the
 * session, as leaving the shell does. The case is the task's input as the plugin's model fills it from the task's description
 * (the shell's prompt.md and request.json show it); a plugin of several tasks picks the task.
 * @returns {HTMLElement}
 */
export function harnessPage(plugin) {
  let task = plugin.tasks[0];
  let runId = null;
  const taskPick =
    plugin.tasks.length > 1
      ? h("select", { class: "input", "aria-label": "Task", onchange: (event) => (task = plugin.tasks.find((one) => one.id === event.target.value)) }, plugin.tasks.map((one) => h("option", { value: one.id, text: one.description })))
      : null;
  const runButton = h("button", { type: "button", class: "button primary", text: "Start" });
  const stop = h("button", { type: "button", class: "button", text: "Stop", hidden: true });
  const status = h("p", { class: "harness-status muted small-text", role: "status", text: `A terminal on your computer in ${plugin.name}'s task: run any agent, leave answer.json, exit to be scored.` });
  const screen = h("div", { class: "harness-terminal" });

  const terminal = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000, theme: { background: "#14161b" } });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => params.some((mode) => ALTERNATE_SCREEN.has(mode)));
  // What the person types, and the terminal's size, go to the shell while its session runs.
  const send = (method, params) => runId && request(method, { runId, ...params }).catch((problem) => (status.textContent = problem.message));
  terminal.onData((data) => send("harness.input", { data }));
  terminal.onResize(({ rows, cols }) => send("harness.resize", { rows, cols }));
  // The terminal opens once its tab is first shown, the size it measures by, and starts its first session then.
  let opened = false;
  new ResizeObserver(() => {
    if (!screen.offsetParent) return;
    if (!opened) {
      terminal.open(screen);
      opened = true;
      fit.fit();
      start();
      return;
    }
    fit.fit();
  }).observe(screen);

  async function start() {
    if (runButton.disabled) return;
    terminal.reset();
    status.textContent = `${task.description} · starting the terminal`;
    runButton.disabled = true;
    if (taskPick) taskPick.disabled = true;
    let started = false;
    const done = () => {
      runId = null;
      runButton.disabled = false;
      if (taskPick) taskPick.disabled = false;
      stop.hidden = true;
      stop.disabled = false;
    };
    try {
      runId = await startRun("harness.run", { harness: "shell", task: task.id, text: task.description }, (name, data) => {
        switch (name) {
          case "harness.preparing":
            status.textContent = `${task.description} · preparing your computer (${Math.round(data.done / 1e6)} of ${Math.round(data.total / 1e6)} MB): the session starts once it is ready`;
            break;
          case "harness.output":
            if (!started) {
              started = true;
              status.textContent = `${task.description} · running: exit the shell, or Stop, to end the session`;
            }
            terminal.write(bytes(data.data));
            break;
          case "harness.outcome":
            status.textContent = outcomeText(data);
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
        stop.hidden = false;
        send("harness.resize", { rows: terminal.rows, cols: terminal.cols });
        terminal.focus();
      }
    } catch (problem) {
      status.textContent = problem.message;
      done();
    }
  }

  runButton.addEventListener("click", () => start());
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

  const head = h("div", { class: "harness-head" }, taskPick, h("div", { class: "harness-ask" }, stop, runButton));
  return h("section", { class: "harness-page", "aria-label": "Harness" }, head, screen, status);
}
