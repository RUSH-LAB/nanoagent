// Chat with the plugin's agent over `prompt`: every plugin's Session page (kit/shell.js).

import { request, startRun } from "./bridge.js";
import { h, icon } from "./dom.js";
import { markdown } from "./markdown.js";
import { currentSession, metricsLine } from "./session.js";

/**
 * A conversation with the plugin's agent. Answers are shown as Markdown. Each of the agent's
 * tools is one of the plugin's tasks; each task it ran shows as a chip above the answer, with
 * whether it passed its check, and picking the chip draws its result with `show`, beside the
 * chat; the latest result is drawn as it arrives. A task that failed says why. The host keeps the
 * conversation with the session, task results included, so a resumed session shows it again,
 * its latest result drawn, and continues it. Each answer says what it cost and how long it took.
 * @param {object} options
 * @param {Node} options.intro What the empty log shows.
 * @param {string} options.placeholder The message box's placeholder.
 * @param {Record<string, {label: string, title: string, draw: (result: {output: unknown, verdict: object}, call: {send: (text: string) => void}) => Node}>} options.tasks
 *   One entry per task id: its chip's `label` and `title`, and `draw`, which draws what the task
 *   returned. `send` sends a message as if the person typed it, e.g. from a card's button.
 * @param {(node: Node) => void} options.show Draws a task's result beside the chat.
 * @returns {{element: HTMLElement, busy: () => boolean}} `busy` is true while a message is being answered.
 */
export function chatPanel({ intro, placeholder, tasks, show }) {
  const log = h("div", { class: "chat-log", role: "log", "aria-live": "polite" }, intro);
  const input = h("textarea", { class: "input", rows: 2, placeholder, "aria-label": placeholder });
  const sendButton = h("button", { type: "button", class: "button primary", text: "Send" });
  const stop = h("button", { type: "button", class: "button", text: "Stop", hidden: true });
  let runId = null;
  let fresh = true;

  let picked = null;
  /** Marks `chip` picked and draws its task's result beside the chat. */
  const pick = (chip) => {
    picked?.setAttribute("aria-pressed", "false");
    picked = chip;
    chip.setAttribute("aria-pressed", "true");
    chip.draw();
  };
  /** A task call as a chip that draws its result, or why the task failed. */
  const toolResult = ({ name, output, isError }) => {
    const task = tasks[name];
    if (!task) return h("p", { class: "error-text", text: `The agent called ${name}, which is not one of the plugin's tasks.` });
    if (isError) return h("p", { class: "error-text", text: `${task.label} failed: ${output}` });
    const result = JSON.parse(output);
    const valid = result.verdict.valid;
    const chip = h(
      "button",
      { type: "button", class: valid ? "result-chip" : "result-chip bad", "aria-pressed": "false", title: task.title },
      icon(valid ? "check" : "error", { size: 14, label: valid ? "Checked" : "Check failed" }),
      h("span", { text: task.label }),
    );
    chip.draw = () => show(task.draw(result, { send: (text) => submit(text) }));
    chip.addEventListener("click", () => pick(chip));
    return chip;
  };
  const clearIntro = () => {
    if (fresh) log.replaceChildren();
    fresh = false;
  };
  for (const { prompt, answer, tools = [] } of currentSession()?.chat ?? []) {
    clearIntro();
    log.append(h("div", { class: "message user" }, h("p", { text: prompt })), h("div", { class: "turn" }, h("div", { class: "tool-results" }, tools.map(toolResult)), h("div", { class: "message agent" }, markdown(answer))));
  }
  const chips = log.querySelectorAll(".result-chip");
  if (chips.length) pick(chips[chips.length - 1]);

  const scroll = () => {
    log.scrollTop = log.scrollHeight;
  };
  async function submit(typed) {
    const text = (typed ?? input.value).trim();
    if (!text || sendButton.disabled) return;
    clearIntro();
    if (typed === undefined) input.value = "";
    log.append(h("div", { class: "message user" }, h("p", { text })));
    const reply = h("div", { class: "message agent" }, h("p", { class: "typing", "aria-label": "The agent is replying" }, h("span"), h("span"), h("span")));
    const results = h("div", { class: "tool-results" });
    const turn = h("div", { class: "turn" }, results, reply);
    log.append(turn);
    scroll();
    sendButton.disabled = true;
    let streamed = "";
    let started = false;
    const write = (value) => {
      started = true;
      reply.replaceChildren(markdown(value));
    };
    const done = () => {
      runId = null;
      sendButton.disabled = false;
      stop.hidden = true;
      stop.disabled = false;
      if (!started) reply.remove();
    };
    try {
      runId = await startRun("prompt", { text }, (name, data) => {
        switch (name) {
          case "chat.delta":
            streamed += data.text ?? "";
            write(streamed);
            break;
          case "chat.tool": {
            const shown = toolResult(data);
            results.append(shown);
            if (shown.matches(".result-chip")) pick(shown);
            break;
          }
          case "chat.answer":
            write(data.text ?? "");
            if (data.metrics) reply.append(h("p", { class: "message-metrics", text: metricsLine(data.metrics) }));
            break;
          case "chat.error":
            turn.append(h("p", { class: "error-text", role: "alert", text: data.message === "cancelled" ? "Stopped." : data.message }));
            break;
          case "chat.done":
            done();
            break;
        }
        scroll();
      });
      if (sendButton.disabled) stop.hidden = false;
    } catch (problem) {
      turn.append(h("p", { class: "error-text", role: "alert", text: problem.message }));
      done();
    }
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  sendButton.addEventListener("click", () => submit());
  stop.addEventListener("click", async () => {
    if (!runId) return;
    stop.disabled = true;
    try {
      await request("cancel", { runId });
    } catch (problem) {
      stop.disabled = false;
      log.append(h("p", { class: "error-text", role: "alert", text: `Stop failed: ${problem.message}` }));
    }
  });

  return {
    busy: () => sendButton.disabled,
    element: h("section", { class: "chat", "aria-label": "Chat" }, log, h("div", { class: "chat-input" }, input, h("div", { class: "chat-buttons" }, stop, sendButton))),
  };
}
