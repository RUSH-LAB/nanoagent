// The Harness tab every plugin's page has (kit/shell.js): the person's own terminals on their computer, in the harness VM, in the
// workspace of one case of the plugin's task, with the model a call away through RUSH (which records every call) and the
// reference CLIs installed. They run any agent there; when they leave the shell, the answer.json it left is scored as a
// benchmark case is, and `rush save <name>` there keeps what they built as a harness of theirs.

import { startRun, request } from "./bridge.js";
import { h, icon } from "./dom.js";
import { formatCost, formatSeconds, thousands } from "./session.js";
import { Terminal } from "./vendor/xterm/xterm.mjs";
import { FitAddon } from "./vendor/xterm/addon-fit.mjs";

// The terminals one session opens at most (RUSH keeps 32: ids 0 to 31).
const MAX_TERMINALS = 32;
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
 * The Harness tab: a free-form Terminal session that starts when the tab is first shown, in the plugin (with its first task's tools,
 * as `nanoagent harness` picks the task by default): the member runs any agent there and prompts it themselves. As in an editor's
 * terminal panel, they open more terminals in the same VM and workspace ("+"), switch between them by their tabs and close one (×);
 * a terminal whose shell they leave (exit, Ctrl-D) closes too. The session ends with its last terminal; its time, tokens and cost
 * print there, and Enter then starts a new one.
 * @returns {HTMLElement}
 */
export function harnessPage(plugin) {
  const task = plugin.tasks[0];
  let runId = null;
  let ended = false;
  let next = 0;  // the id the next terminal opened gets
  let active = null;
  const views = new Map();  // by terminal id: {id, terminal, fit, screen, tab}
  const screens = h("div", { class: "harness-screens" });
  const add = h("button", { type: "button", class: "harness-tab-add", "aria-label": "New terminal", title: "New terminal", onclick: () => openAnother() }, icon("plus", { size: 15 }));
  const tabs = h("div", { class: "harness-tabs", role: "tablist", "aria-label": "Terminals" }, add);

  const send = (method, params, view) => runId && request(method, { runId, ...params }).catch((problem) => view.terminal.write(`\x1b[31m${problem.message}\x1b[0m\r\n`));

  /** A terminal's view, its tab and screen, shown at once (xterm measures its size by the shown screen). */
  function view(id) {
    const screen = h("div", { class: "harness-terminal" });
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000, theme: { background: "#14161b" } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const label = `Terminal ${id + 1}`;
    const tab = h("div", { class: "harness-tab", role: "tab", onclick: () => show(id) },
      h("span", { text: label }),
      h("button", {
        type: "button", class: "harness-tab-close", "aria-label": `Close ${label}`, title: `Close ${label}`,
        onclick: (event) => { event.stopPropagation(); close(id); },
      }, icon("close", { size: 13 })));
    const entry = { id, terminal, fit, screen, tab };
    views.set(id, entry);
    screens.append(screen);
    tabs.insertBefore(tab, add);
    show(id);
    terminal.open(screen);
    fit.fit();
    terminal.onData((data) => {
      if (ended && data === "\r") start();
      else send("harness.input", { terminal: id, data }, entry);
    });
    return entry;
  }

  function show(id) {
    active = id;
    for (const entry of views.values()) {
      const shown = entry.id === id;
      entry.screen.hidden = !shown;
      entry.tab.setAttribute("aria-selected", String(shown));
    }
    const entry = views.get(id);
    if (entry.terminal.element) {
      entry.fit.fit();
      entry.terminal.focus();
    }
  }

  function remove(id) {
    const entry = views.get(id);
    views.delete(id);
    entry.terminal.dispose();
    entry.screen.remove();
    entry.tab.remove();
    if (active === id && views.size) show([...views.keys()].at(-1));
  }

  // "+": another terminal of the running session, the size the panel measures, its output followed from its first byte.
  async function openAnother() {
    if (!runId || ended || next >= MAX_TERMINALS) return;
    const id = next++;
    const entry = view(id);
    updateAdd();
    const { rows, cols } = entry.terminal;
    await send("harness.open", { terminal: id, rows, cols }, entry);
    entry.terminal.onResize((size) => send("harness.resize", { terminal: id, ...size }, entry));
  }

  // ×: the worker ends the terminal's processes; its tab goes when RUSH says it ended (harness.closed), the session with its last.
  function close(id) {
    if (runId && !ended) send("harness.close", { terminal: id }, views.get(id));
    else if (views.size > 1) remove(id);
  }

  function updateAdd() {
    add.disabled = !runId || ended || next >= MAX_TERMINALS;
  }

  // The first terminal opens once the tab is first shown, the size it measures by, and starts its first session then.
  let opened = false;
  new ResizeObserver(() => {
    if (!screens.offsetParent) return;
    if (!opened) {
      opened = true;
      start();
      return;
    }
    if (active !== null) views.get(active).fit.fit();
  }).observe(screens);

  async function start() {
    for (const id of [...views.keys()]) remove(id);
    ended = false;
    runId = null;
    next = 1;
    const first = view(0);
    first.terminal.onResize((size) => send("harness.resize", { terminal: 0, ...size }, first));
    updateAdd();
    let preparing = false;
    // What the session says as a whole (its outcome, an error) is told in the terminal shown.
    const shown = () => views.get(active).terminal;
    const done = () => {
      runId = null;
      ended = true;
      updateAdd();
      shown().write("Press Enter to start a new one.");
    };
    try {
      const id = await startRun("harness.run", { harness: "shell", task: task.id }, (name, data) => {
        switch (name) {
          case "harness.preparing":  // shown only while something downloads; otherwise the terminal just opens
            if (!data.total) break;
            preparing = true;
            first.terminal.write(`\r\x1b[KPreparing your computer (${Math.round(data.done / 1e6)} of ${Math.round(data.total / 1e6)} MB): the session starts once it is ready`);
            break;
          case "harness.output": {
            const entry = views.get(data.terminal);
            if (!entry) break;
            if (preparing) entry.terminal.write("\r\x1b[K");
            preparing = false;
            entry.terminal.write(bytes(data.data));
            break;
          }
          case "harness.closed":  // the last terminal stays, for the session's outcome
            if (views.has(data.terminal) && views.size > 1) remove(data.terminal);
            break;
          case "harness.outcome":
            shown().write(`\r\n\x1b[1m${outcomeText(data)}\x1b[0m\r\n`);
            break;
          case "harness.error":
            shown().write(`\r\n\x1b[31m${data.message}\x1b[0m\r\n`);
            break;
          case "harness.done":
            done();
            break;
        }
      });
      // A session that ended while it started (its events came with the reply) has nothing left to send to.
      if (!ended) {
        runId = id;
        updateAdd();
        send("harness.resize", { terminal: 0, rows: first.terminal.rows, cols: first.terminal.cols }, first);
        first.terminal.focus();
      }
    } catch (problem) {
      shown().write(`\x1b[31m${problem.message}\x1b[0m\r\n`);
      done();
    }
  }

  return h("section", { class: "harness-page", "aria-label": "Harness" }, tabs, screens);
}
