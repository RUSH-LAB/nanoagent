// Chat with the plugin's agent over `prompt`: every plugin's Session page (kit/shell.js).

import { request, startRun } from "./bridge.js";
import { h } from "./dom.js";
import { markdown } from "./markdown.js";
import { currentSession, metricsLine } from "./session.js";

/**
 * A conversation with the plugin's agent. Answers are shown as Markdown. Each of the agent's
 * tools is one of the plugin's tasks, and each task it ran shows its result above the answer, as
 * `render` draws it; a task that failed says why. The host keeps the conversation with the
 * session, task results included, so a resumed session shows it again and continues it. Each
 * answer says what it cost and how long it took.
 * @param {object} options
 * @param {Node} options.intro What the empty log shows.
 * @param {string} options.placeholder The message box's placeholder.
 * @param {Record<string, (result: {output: unknown, verdict: object}, call: {send: (text: string) => void}) => Node>} options.render
 *   One renderer per task id: it draws what the task returned. `send` sends a message as if the
 *   person typed it, e.g. from a card's button.
 * @returns {{element: HTMLElement}}
 */
export function chatPanel({ intro, placeholder, render }) {
  const log = h("div", { class: "chat-log", role: "log", "aria-live": "polite" }, intro);
  const input = h("textarea", { class: "input", rows: 2, placeholder, "aria-label": placeholder });
  const sendButton = h("button", { type: "button", class: "button primary", text: "Send" });
  const stop = h("button", { type: "button", class: "button", text: "Stop", hidden: true });
  let runId = null;
  let fresh = true;

  /** A task call's result as its renderer draws it, or why the task failed. */
  const toolResult = ({ name, output, isError }) => {
    if (!render[name]) return h("p", { class: "error-text", text: `The agent called ${name}, which is not one of the plugin's tasks.` });
    if (isError) return h("p", { class: "error-text", text: `${name} failed: ${output}` });
    return h("div", { class: "tool-result" }, render[name](JSON.parse(output), { send: (text) => submit(text) }));
  };
  const clearIntro = () => {
    if (fresh) log.replaceChildren();
    fresh = false;
  };
  for (const { prompt, answer, tools = [] } of currentSession()?.chat ?? []) {
    clearIntro();
    log.append(h("div", { class: "message user" }, h("p", { text: prompt })), h("div", { class: "turn" }, tools.map(toolResult), h("div", { class: "message agent" }, markdown(answer))));
  }

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
          case "chat.tool":
            results.append(toolResult(data));
            break;
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
    element: h("section", { class: "chat", "aria-label": "Chat" }, log, h("div", { class: "chat-input" }, input, h("div", { class: "chat-buttons" }, stop, sendButton))),
  };
}
