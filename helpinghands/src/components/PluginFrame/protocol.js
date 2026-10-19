/**
 * The bridge protocol `nanoagent.ui/v1` between a plugin's page and Mochi, as
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
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  'session.get': ({id}) => (SESSION_ID.test(id ?? '') ? null : 'session.get needs a session id'),
  'session.start': () => null,
  'session.resume': ({id}) => (SESSION_ID.test(id ?? '') ? null : 'session.resume needs a session id'),
  'session.archive': ({id, archived}) => (SESSION_ID.test(id ?? '') && typeof archived === 'boolean'
    ? null
    : 'session.archive needs a session id and archived, true or false'),
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
    return {event: 'chat.answer', data: {text: data.text, metrics: answerMetrics(data), version: data.version ?? null}, final: true};
  }
  if (event === 'error') return {event: 'chat.error', data: {message: data.error}, final: true};
  return null;
}

/**
 * What an answer cost and how long it took, in the shape a task's `task.done`
 * reports it, or null when the server sent no metrics.
 */
function answerMetrics({model, cost, usage, metrics}) {
  if (!metrics) return null;
  return {
    model: model ?? null,
    cost: cost ?? metrics.cost ?? null,
    usage: usage ?? metrics.usage ?? {},
    ttft_s: metrics.ttft_s ?? null,
    generation_s: metrics.generation_s ?? null,
    duration_s: metrics.duration_s ?? null,
  };
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
