// The Harness tab every plugin's page has (kit/shell.js): the person picks a harness and asks as in a Session, and one of
// the plugin's tasks is worked once by that harness on their own computer, as a benchmark case is.

import { startRun, request } from "./bridge.js";
import { h } from "./dom.js";
import { partRow } from "./loop.js";
import { PARTS, TYPES } from "./parts.js";
import { resultCard } from "./result.js";
import { runStats } from "./session.js";

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
];

// Rows of what a harness does that no run graph part names.
const ROW = {
  status: { label: "Harness", hue: "quiet", font: "plain" },
  tool: { label: "Plugin tool", hue: "task", font: "code" },
  command: { label: "Command", hue: "plain", font: "code" },
  answer: { label: "Answer", hue: "answer", font: "plain" },
};
const pre = (text) => h("pre", { class: "part-stream", text });

/** The rows a step (PluginFrame/harness.js `harnessStep`) shows. */
function stepRows(step) {
  switch (step.kind) {
    case "status":
      return [partRow(ROW.status, { text: step.text })];
    case "reply":
      return [
        step.text ? partRow(PARTS[TYPES.ASSISTANT], { whole: step.text }) : null,
        ...step.calls.map((call) => partRow(PARTS[TYPES.TOOL_CALL], { text: call.name, full: pre(call.arguments) })),
        step.error ? h("li", { class: "error-text", text: `The model call failed: ${typeof step.error === "string" ? step.error : JSON.stringify(step.error)}` }) : null,
      ];
    case "tool":
      return [partRow(ROW.tool, { text: step.name })];
    case "tool-result":
      return [partRow(PARTS[TYPES.TOOL_RESULT], { text: step.ok ? `${step.name} answered` : `${step.name} failed: ${step.error}` })];
    case "command":
      return [partRow(ROW.command, { text: step.argv.join(" ") })];
    case "result":
      return [
        step.outcome.status === "answered"
          ? partRow(ROW.answer, { text: "Gave its answer", full: pre(JSON.stringify(step.outcome.answer, null, 2)) })
          : partRow(ROW.answer, { text: step.outcome.status === "refused" ? `Refused: ${step.outcome.reason}` : `No answer: ${step.outcome.reason}` }),
      ];
    case "error":
      return [h("li", { class: "error-text", text: step.text })];
  }
  return [];
}

/**
 * What the session came to: the verifier's verdict on the answer, drawn as a Session's task result is (the plugin's renderer
 * or its output's JSON Schema), how the run ended, and its time, tokens and cost.
 */
function outcomeView(outcome, answer, task, renderer, send) {
  const pass = outcome.verdict === "Pass";
  const ended = h("p", { class: "muted", text: `${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""} · Verdict: ${pass ? "right" : outcome.verdict === "Fail" ? "wrong" : outcome.verdict}` });
  const stats = runStats({
    duration_s: outcome.elapsedMs === null ? null : outcome.elapsedMs / 1000,
    usage: { prompt_tokens: outcome.inputTokens, completion_tokens: outcome.outputTokens },
    cost: outcome.cost,
  });
  const verdict = { valid: pass, message: outcome.explanation || (pass ? "The plugin's verifier passed the answer." : `The plugin's verifier gave ${outcome.verdict}.`) };
  return h("div", { class: "harness-outcome" }, ended, stats, answer === null ? null : resultCard(task, { output: answer, verdict }, renderer, send));
}

/**
 * The Harness tab: a harness picker (and, for a plugin of several tasks, the task), the session's log as it runs, and what it
 * came to beside it. One session at a time: a new message starts a new session in place of the one shown.
 * @returns {HTMLElement}
 */
export function harnessPage(plugin, renderers) {
  let harness = HARNESSES[0][0];
  let task = plugin.tasks[0];
  let runId = null;
  const about = h("p", { class: "muted small-text" });
  const choices = HARNESSES.map(([id, label]) => h("button", { type: "button", class: "button small", "aria-pressed": String(id === harness), text: label, onclick: () => pick(id) }));
  function pick(id) {
    harness = id;
    for (const [index, button] of choices.entries()) button.setAttribute("aria-pressed", String(HARNESSES[index][0] === id));
    about.textContent = HARNESSES.find(([each]) => each === id)[2];
  }
  pick(harness);
  const taskPick =
    plugin.tasks.length > 1
      ? h("select", { class: "input", "aria-label": "Task", onchange: (event) => (task = plugin.tasks.find((one) => one.id === event.target.value)) }, plugin.tasks.map((one) => h("option", { value: one.id, text: one.description })))
      : null;
  const intro = h("div", { class: "chat-intro" }, h("img", { src: plugin.product.icon, alt: "" }), h("h1", { text: "Run a harness" }), h("p", { class: "muted", text: `Pick a harness and ask as in a Session: it works ${plugin.name}'s task once on your computer, and the plugin's verifier checks its answer.` }));
  const log = h("div", { class: "chat-log", role: "log", "aria-live": "polite" }, intro);
  const placeholder = `Tell ${plugin.name} what you need`;
  const input = h("textarea", { class: "input", rows: 2, placeholder, "aria-label": placeholder });
  const runButton = h("button", { type: "button", class: "button primary", text: "Run" });
  const stop = h("button", { type: "button", class: "button", text: "Stop", hidden: true });
  const empty = h("div", { class: "results-empty" }, h("p", { text: "The answer shows here" }), h("p", { class: "muted", text: "When the harness ends: its answer, right or wrong by the plugin's verifier, and its time, tokens and cost." }));
  const side = h("section", { class: "results-panel", "aria-label": "Outcome" }, empty);

  async function submit(typed) {
    const text = (typed ?? input.value).trim();
    if (!text || runButton.disabled) return;
    if (typed === undefined) input.value = "";
    const rows = h("ol", { class: "loop" }, partRow(PARTS[TYPES.USER_MESSAGE], { whole: text }));
    const waiting = h("p", { class: "typing", "aria-label": "Preparing the case" }, h("span"), h("span"), h("span"));
    const label = HARNESSES.find(([id]) => id === harness)[1];
    log.replaceChildren(h("p", { class: "muted small-text", text: `${label} · ${task.description}` }), rows, waiting);
    side.replaceChildren(empty);
    runButton.disabled = true;
    for (const button of choices) button.disabled = true;
    const fail = (message) => log.append(h("p", { class: "error-text", role: "alert", text: message }));
    const ran = task;
    let answer = null;
    const done = () => {
      runId = null;
      waiting.remove();
      runButton.disabled = false;
      for (const button of choices) button.disabled = false;
      stop.hidden = true;
      stop.disabled = false;
    };
    try {
      runId = await startRun("harness.run", { harness, task: ran.id, text }, (name, data) => {
        switch (name) {
          case "harness.step":
            if (data.kind === "result" && data.outcome.status === "answered") answer = data.outcome.answer;
            rows.append(...stepRows(data).filter(Boolean));
            break;
          case "harness.outcome":
            side.replaceChildren(outcomeView(data, answer, ran, renderers[ran.output], (more) => submit(more)));
            break;
          case "harness.error":
            fail(data.message);
            break;
          case "harness.done":
            done();
            break;
        }
        log.scrollTop = log.scrollHeight;
      });
      if (runButton.disabled) stop.hidden = false;
    } catch (problem) {
      fail(problem.message);
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
      log.append(h("p", { class: "error-text", role: "alert", text: `Stop failed: ${problem.message}` }));
    }
  });

  const head = h("div", { class: "harness-head" }, h("div", { class: "harness-pick", role: "group", "aria-label": "Harness" }, choices), about, taskPick);
  const chat = h("section", { class: "chat harness-chat", "aria-label": "Harness" }, head, log, h("div", { class: "chat-input" }, input, h("div", { class: "chat-buttons" }, stop, runButton)));
  return h("div", { class: "chat-page" }, chat, side);
}
