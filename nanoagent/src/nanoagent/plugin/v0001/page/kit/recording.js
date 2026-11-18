// A Harness tab session's recording, opened from the dashboard (kit/session.js): read-only, it cannot be resumed. What each harness
// that worked in it took, read and cost; each terminal replayed from what it wrote; its model calls by the agent that made each, a
// call's request and response read when it is opened (`recording.payload`) and shown as the Leaderboard's traces are; and the commands
// the process record shows, with their timings.

import { request } from "./bridge.js";
import { dataTable, disclosure, statItems } from "./display.js";
import { h } from "./dom.js";
import { block } from "./leaderboard.js";
import { formatCost, formatSeconds, thousands } from "./session.js";
import { Terminal } from "./vendor/xterm/xterm.mjs";

const bytes = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
const known = (figure, format) => (figure.count ? format(figure.sum) : "—");
const count = (value) => (value === null ? "—" : thousands(value));

/** One harness's figures in the session, as stats. */
const harnessStats = ({ harness, usage }) => h(
  "div",
  { class: "recording-harness" },
  h("div", { class: "leaderboard-label", text: harness }),
  h("dl", { class: "stats leaderboard-figures" }, statItems([
    ["End-to-End Latency", known(usage.durationS, formatSeconds)], ["Model Time", known(usage.modelS, formatSeconds)],
    ["Input Tokens", known(usage.inputTokens, thousands)], ["Output Tokens", known(usage.outputTokens, thousands)], ["Cost", known(usage.cost, formatCost)],
  ])),
);

/** A terminal replayed from everything it wrote, which can only be read. */
function replay({ terminal, data }, element) {
  const screen = h("div", { class: "harness-terminal recording-terminal" });
  element.append(h("div", { class: "leaderboard-label", text: `Terminal ${terminal + 1}` }), screen);
  const shown = new Terminal({ disableStdin: true, cols: 120, rows: 24, scrollback: 100000, fontSize: 12, theme: { background: "#14161b" } });
  shown.open(screen);
  shown.write(bytes(data));
}

/** One model call: its agent, model and figures, and its request and response once it is opened. */
function modelCall(attemptId, call, index, status) {
  const body = h("div", { class: "leaderboard-trace" });
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    loaded = true;
    body.replaceChildren(h("p", { class: "muted small-text", text: "Reading the call…" }));
    try {
      const [sent, answered] = await Promise.all([call.request, call.response].map((sha256) => (sha256 ? request("recording.payload", { attemptId, sha256 }) : null)));
      body.replaceChildren(...[block("prompt", sent?.text), block("response", answered?.text)].filter(Boolean));
    } catch (problem) {
      loaded = false;
      body.replaceChildren();
      status.textContent = problem.message;
    }
  };
  return disclosure(
    {
      summary: `${index + 1} · ${call.agent} · ${call.model ?? "model"}`,
      hint: `${formatSeconds(call.durationS)} · ${count(call.inputTokens)} in / ${count(call.outputTokens)} out · ${formatCost(call.cost)}`,
      onToggle: (opened) => opened && load(),
    },
    body,
  );
}

/**
 * The recording of the member's Harness session `attemptId`, read when made.
 * @returns {HTMLElement}
 */
export function recording(attemptId) {
  const status = h("p", { class: "error-text", role: "alert" });
  const element = h("div", { class: "recording" }, status, h("p", { class: "muted small-text", text: "Reading the recording…" }));
  request("recording", { attemptId }).then(
    ({ session, terminals }) => {
      element.replaceChildren(status, ...session.harnesses.map(harnessStats));
      const screens = h("div", { class: "recording-terminals" });
      element.append(screens);
      for (const one of terminals) replay(one, screens);
      element.append(
        h("h4", { text: `Model calls (${session.calls.length})` }),
        h("div", { class: "leaderboard-cases" }, session.calls.map((call, index) => modelCall(attemptId, call, index, status))),
        h("h4", { text: `Commands (${session.commands.length})` }),
        dataTable({
          columns: [
            { key: "command", label: "Command", primary: true, value: (command) => command.argv.join(" ") },
            { key: "startS", label: "Start", numeric: true, render: (command) => formatSeconds(command.startS) },
            { key: "durationS", label: "Time", numeric: true, render: (command) => formatSeconds(command.durationS) },
            { key: "exitCode", label: "Exit", numeric: true, render: (command) => (command.exitCode === null ? "—" : String(command.exitCode)) },
          ],
          rows: session.commands,
          sort: { key: "startS" },
          caption: "The commands the session ran, with their timings",
          empty: "No commands recorded.",
          limit: 100,
        }).element,
      );
    },
    (problem) => element.replaceChildren(status, h("p", { class: "error-text", text: problem.message })),
  );
  return element;
}
