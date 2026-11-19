/**
 * The bridge protocol `nanoagent.ui/v1` between a plugin's page and RUSH, as
 * pure functions: which messages the host accepts, what a request's params
 * must be, the messages it sends back, and how a run's server-sent events
 * become bridge events. The host that uses them is ./host.js.
 */

export const PROTOCOL = 'nanoagent.ui/v1';

// What /api/ai/stream accepts: a prompt of 50 000 characters, and 24 earlier
// messages of 10 000 characters each.
const PROMPT_LIMIT = 50_000;
export const HISTORY_LIMIT = 24;
export const MESSAGE_LIMIT = 10_000;
// What one harness.input may carry: a paste into the terminal (RUSH takes 128 KiB of bytes; a character is up to 3 of them).
const TYPED_LIMIT = 40_000;
// What a Harness tab session may run: a reference harness (server/benchmark/harness.js REFERENCE_HARNESSES) or one the member saved
// from a Terminal session, each named as the harness contract names a harness; RUSH says which names it knows.
const HARNESS_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// A Harness tab session's terminals: 0 the first, then each one the page opens (RUSH keeps 32).
const isTerminal = terminal => Number.isInteger(terminal) && terminal >= 0 && terminal < 32;
const isSize = (rows, cols) => [rows, cols].every(n => Number.isInteger(n) && n >= 1 && n <= 1000);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The page's request carried by a `message` event, or null for anything the
 * host ignores: a message from any window but the plugin's frame, another
 * protocol's, or one without an id to answer.
 */
export function requestFrom(event, frameWindow) {
  if (!frameWindow || event.source !== frameWindow) return null;
  const message = event.data;
  if (!isObject(message) || message.protocol !== PROTOCOL) return null;
  if (typeof message.id !== 'string' || !message.id) return null;
  return {id: message.id, method: message.method, params: message.params};
}

const PARAMS = {
  'describe': () => null,
  'prompt': ({text}) => (typeof text === 'string' && text.trim() && text.length <= PROMPT_LIMIT
    ? null
    : `prompt needs text of 1 to ${PROMPT_LIMIT} characters`),
  'follow': () => null,
  'cancel': ({runId}) => (typeof runId === 'string' && runId ? null : 'cancel needs a runId'),
  'sessions.list': () => null,
  'session.get': ({id}) => (UUID.test(id ?? '') ? null : 'session.get needs a session id'),
  'session.start': () => null,
  'session.resume': ({id}) => (UUID.test(id ?? '') ? null : 'session.resume needs a session id'),
  'session.shown': ({id}) => (id === null || UUID.test(id ?? '') ? null : 'session.shown needs a session id or null'),
  'session.archive': ({id, archived}) => (UUID.test(id ?? '') && typeof archived === 'boolean'
    ? null
    : 'session.archive needs a session id and archived, true or false'),
  'terminal.archive': ({attemptId, archived}) => (UUID.test(attemptId ?? '') && typeof archived === 'boolean'
    ? null
    : 'terminal.archive needs an attempt id and archived, true or false'),
  // The Terminal (`shell`) is free-form, so it takes no task and no text, and may resume an ended session (its id) or start an agent's
  // CLI in its first terminal (`start`, its command); any other harness works the text to a task.
  'harness.run': ({harness, task, text, resume, start}) => (HARNESS_NAME.test(harness ?? '')
    && (harness === 'shell'
      ? task === undefined && text === undefined && (resume === undefined ? start === undefined || HARNESS_NAME.test(start ?? '') : UUID.test(resume ?? '') && start === undefined)
      : typeof task === 'string' && task && typeof text === 'string' && text.trim() && text.length <= PROMPT_LIMIT && resume === undefined && start === undefined)
    ? null
    : `harness.run needs a harness name and, but for shell, which takes neither (and may take the id of a session to resume, or else an agent's CLI command to start), a task id and text of 1 to ${PROMPT_LIMIT} characters`),
  'harness.cancel': ({runId}) => (typeof runId === 'string' && runId ? null : 'harness.cancel needs a runId'),
  'harness.input': ({runId, terminal, data}) => (typeof runId === 'string' && runId && isTerminal(terminal) && typeof data === 'string' && data && data.length <= TYPED_LIMIT
    ? null
    : `harness.input needs a runId, a terminal (0 to 31) and data, what was typed, of 1 to ${TYPED_LIMIT} characters`),
  'harness.resize': ({runId, terminal, rows, cols}) => (typeof runId === 'string' && runId && isTerminal(terminal) && isSize(rows, cols)
    ? null
    : 'harness.resize needs a runId, a terminal (0 to 31) and its rows and cols, each 1 to 1000'),
  'harness.open': ({runId, terminal, rows, cols}) => (typeof runId === 'string' && runId && isTerminal(terminal) && terminal > 0 && isSize(rows, cols)
    ? null
    : 'harness.open needs a runId, a new terminal (1 to 31) and its rows and cols, each 1 to 1000'),
  'harness.close': ({runId, terminal}) => (typeof runId === 'string' && runId && isTerminal(terminal)
    ? null
    : 'harness.close needs a runId and a terminal (0 to 31)'),
  'leaderboard': () => null,
  'leaderboard.trace': ({attemptId}) => (UUID.test(attemptId ?? '') ? null : 'leaderboard.trace needs an attempt id'),
  'plugin.version': ({version}) => (version === null || (typeof version === 'string' && version)
    ? null
    : 'plugin.version needs version, a published version or null'),
};

export const METHODS = Object.keys(PARAMS);

/** Why a request cannot be carried out, or null when it can. */
export function invalidRequest({method, params}) {
  if (!Object.hasOwn(PARAMS, method)) return `Unknown method: ${String(method)}`;
  if (!isObject(params)) return 'params must be an object';
  return PARAMS[method](params);
}

export const reply = (id, result) => ({protocol: PROTOCOL, id, result});
export const failure = (id, message) => ({protocol: PROTOCOL, id, error: {message}});
export const runEvent = (event, runId, data) => ({protocol: PROTOCOL, event, runId, data});
export const themeEvent = theme => ({protocol: PROTOCOL, event: 'host.theme', data: {theme}});

/**
 * One event of /api/ai/stream as a bridge event `{event, data, final}`; `final`
 * marks the answer or the failure that ends the run. Null for the lifecycle
 * events the protocol has no counterpart for.
 */
export function chatEvent({event, data}) {
  if (event === 'delta') return {event: 'chat.delta', data: {text: data.text}};
  if (event === 'agent' && data?.type === 'reasoning.delta') return {event: 'chat.reasoning', data: {text: data.text}};
  if (event === 'agent' && data?.type === 'tool.started') {
    return {event: 'chat.tool.started', data: {id: data.call.id, name: data.call.name}};
  }
  if (event === 'agent' && data?.type === 'tool.progress') {
    return {event: 'chat.tool.progress', data: {id: data.call.id, name: data.call.name, event: data.event, data: data.data}};
  }
  if (event === 'agent' && data?.type === 'graph.patch') return {event: 'chat.graph', data: {patch: data.patch}};
  if (event === 'agent' && data?.type === 'graph.completed') return {event: 'chat.graph', data: {graph: data.graph}};
  if (event === 'agent' && (data?.type === 'tool.completed' || data?.type === 'tool.failed')) {
    return {
      event: 'chat.tool',
      data: {
        id: data.call.id,
        name: data.call.name,
        arguments: data.call.arguments,
        output: data.call.output,
        isError: data.type === 'tool.failed',
      },
    };
  }
  if (event === 'done') {
    return {event: 'chat.answer', data: {text: data.text, metrics: data.metrics ?? null, version: data.version ?? null}, final: true};
  }
  if (event === 'error') return {event: 'chat.error', data: {message: data.error}, final: true};
  return null;
}

/** The conversation a prompt continues: the most recent turns, each within the server's limit. */
export function promptHistory(turns) {
  return turns
    .flatMap(({prompt, answer}) => [
      {role: 'user', content: prompt.slice(0, MESSAGE_LIMIT)},
      {role: 'assistant', content: answer.slice(0, MESSAGE_LIMIT)},
    ])
    .slice(-HISTORY_LIMIT);
}
