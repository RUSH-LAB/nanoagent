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
 * The line an ended session prints in its terminal: that it ended (a free-form Terminal session, which nothing scores), or right or
 * wrong by the plugin's verifier when it gave an answer (or that it ran out of its time, sessions.wall_time_ms), then time, tokens
 * and cost.
 */
export function outcomeText(outcome) {
  const verdict = outcome.reason === "timed_out"
    ? "Session time limit reached"
    : outcome.ended
    ? "Session ended"
    : !outcome.scored
    ? `No verdict: no answer to score (${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""})`
    : outcome.verdict === "Pass" ? "Right" : outcome.verdict === "Fail" ? "Wrong" : outcome.verdict;
  const tokens = outcome.inputTokens === null ? "—" : thousands((outcome.inputTokens ?? 0) + (outcome.outputTokens ?? 0));
  return [verdict, formatSeconds(outcome.elapsedMs === null ? null : outcome.elapsedMs / 1000), `${tokens} tokens`, formatCost(outcome.cost)].join(" · ");
}

/**
 * The Harness tab: only the terminal, a free-form Terminal session that starts when the tab is first shown, in the plugin (with its
 * first task's tools, as `nanoagent harness` picks the task by default): the member runs any agent there and prompts it themselves.
 * Leaving the shell (exit, Ctrl-D) ends the session; its time, tokens and cost print in the terminal, and Enter then starts a new one
 * there.
 * @returns {HTMLElement}
 */
export function harnessPage(plugin) {
  const task = plugin.tasks[0];
  let runId = null;
  let ended = false;
  const screen = h("div", { class: "harness-terminal" });

  const terminal = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000, theme: { background: "#14161b" } });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => params.some((mode) => ALTERNATE_SCREEN.has(mode)));
  // What the person types, and the terminal's size, go to the shell while its session runs; once it ended, Enter starts another.
  const send = (method, params) => runId && request(method, { runId, ...params }).catch((problem) => terminal.write(`\x1b[31m${problem.message}\x1b[0m\r\n`));
  terminal.onData((data) => {
    if (ended && data === "\r") start();
    else send("harness.input", { data });
  });
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
    ended = false;
    terminal.reset();
    let preparing = false;
    const done = () => {
      runId = null;
      ended = true;
      terminal.write("Press Enter to start a new one.");
    };
    try {
      const id = await startRun("harness.run", { harness: "shell", task: task.id }, (name, data) => {
        switch (name) {
          case "harness.preparing":
            preparing = true;
            terminal.write(`\r\x1b[KPreparing your computer (${Math.round(data.done / 1e6)} of ${Math.round(data.total / 1e6)} MB): the session starts once it is ready`);
            break;
          case "harness.output":
            if (preparing) terminal.write("\r\x1b[K");
            preparing = false;
            terminal.write(bytes(data.data));
            break;
          case "harness.outcome":
            terminal.write(`\r\n\x1b[1m${outcomeText(data)}\x1b[0m\r\n`);
            break;
          case "harness.error":
            terminal.write(`\r\n\x1b[31m${data.message}\x1b[0m\r\n`);
            break;
          case "harness.done":
            done();
            break;
        }
      });
      // A session that ended while it started (its events came with the reply) has nothing left to send to.
      if (!ended) {
        runId = id;
        send("harness.resize", { rows: terminal.rows, cols: terminal.cols });
        terminal.focus();
      }
    } catch (problem) {
      terminal.write(`\x1b[31m${problem.message}\x1b[0m\r\n`);
      done();
    }
  }

  return h("section", { class: "harness-page", "aria-label": "Harness" }, screen);
}
