// The page's side of the `nanoagent.ui/v1` bridge: requests to the host frame and its events.
//
// The page has an opaque origin and no network, so everything goes through postMessage to
// `window.parent`. Only messages from `window.parent` carrying the protocol are read.

/** The bridge protocol every message carries. */
export const PROTOCOL = "nanoagent.ui/v1";

const pending = new Map(); // request id -> {resolve, reject, method}
const listeners = new Map(); // event name or "*" -> Set of handlers
const runs = new Map(); // runId -> handler of that run's events
const early = []; // run events that arrived before their run's request was answered
let starting = 0; // run requests awaiting their runId
let counter = 0;

/**
 * True when the page is framed by a host it can talk to.
 * @returns {boolean}
 */
export function hasHost() {
  return window.parent !== window;
}

function newId() {
  const random = new Uint32Array(2);
  crypto.getRandomValues(random);
  counter += 1;
  return `${counter.toString(36)}-${random[0].toString(36)}${random[1].toString(36)}`;
}

/**
 * Send `method` with `params` to the host.
 * @param {string} method e.g. "workspace.list".
 * @param {object} [params]
 * @returns {Promise<any>} The reply's `result`; rejects with its `error.message`.
 */
export function request(method, params = {}) {
  if (!hasHost()) {
    return Promise.reject(new Error("No NanoAgent host: this page must be shown inside the host's frame."));
  }
  const id = newId();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    window.parent.postMessage({ protocol: PROTOCOL, id, method, params }, "*");
  });
}

/**
 * Call `handler(data, message)` for every host event named `event` ("*" for all).
 * @param {string} event e.g. "host.theme".
 * @param {(data: object, message: object) => void} handler
 * @returns {() => void} Unsubscribes.
 */
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event).delete(handler);
}

/**
 * Start a streamed run (`runTask` or `prompt`) and call `onEvent(name, data)` for each of its
 * events, through its `*.done` event. Events the host sends before its reply are kept and
 * delivered once the reply names the run.
 * @param {"runTask"|"prompt"} method
 * @param {object} params
 * @param {(name: string, data: object) => void} onEvent
 * @returns {Promise<string>} The runId.
 */
export async function startRun(method, params, onEvent) {
  starting += 1;
  let result;
  try {
    result = await request(method, params);
  } finally {
    starting -= 1;
  }
  if (!result || typeof result.runId !== "string") {
    throw new Error(`The host's reply to ${method} has no runId.`);
  }
  runs.set(result.runId, onEvent);
  const mine = early.filter((message) => message.runId === result.runId);
  for (const message of mine) early.splice(early.indexOf(message), 1);
  if (starting === 0) early.length = 0;
  for (const message of mine) deliver(message);
  return result.runId;
}

function deliver(message) {
  const handler = runs.get(message.runId);
  if (!handler) return false;
  if (message.event.endsWith(".done")) runs.delete(message.runId);
  handler(message.event, message.data ?? {});
  return true;
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || typeof message !== "object" || message.protocol !== PROTOCOL) return;

  if (typeof message.id === "string") {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error !== undefined) {
      const text = message.error && typeof message.error.message === "string" ? message.error.message : "";
      waiting.reject(new Error(text || `The host failed ${waiting.method} without a message.`));
    } else {
      waiting.resolve(message.result);
    }
    return;
  }

  if (typeof message.event !== "string") return;
  for (const name of [message.event, "*"]) {
    for (const handler of listeners.get(name) ?? []) handler(message.data ?? {}, message);
  }
  if (typeof message.runId === "string" && !deliver(message) && starting > 0) early.push(message);
});
