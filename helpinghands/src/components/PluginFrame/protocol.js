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
const PATH_LIMIT = 1000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit;

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
  'runTask': ({task, arguments: args}) => {
    if (!isText(task, 100)) return 'runTask needs a task id';
    return isObject(args) ? null : 'runTask needs arguments as an object';
  },
  'prompt': ({text}) => (typeof text === 'string' && text.trim() && text.length <= PROMPT_LIMIT
    ? null
    : `prompt needs text of 1 to ${PROMPT_LIMIT} characters`),
  'cancel': ({runId}) => (typeof runId === 'string' && runId ? null : 'cancel needs a runId'),
  'sessions.list': () => null,
  'session.get': ({id}) => (SESSION_ID.test(id ?? '') ? null : 'session.get needs a session id'),
  'session.start': () => null,
  'session.resume': ({id}) => (SESSION_ID.test(id ?? '') ? null : 'session.resume needs a session id'),
  'session.save': ({state, title}) => {
    if (state === undefined) return 'session.save needs state';
    return title === undefined || typeof title === 'string' ? null : 'session.save needs title as a string';
  },
  'workspace.list': () => null,
  'workspace.read': ({path}) => (isText(path, PATH_LIMIT) ? null : 'workspace.read needs a path'),
  'workspace.write': ({path, text, base64}) => {
    if (!isText(path, PATH_LIMIT)) return 'workspace.write needs a path';
    return (typeof text === 'string') !== (typeof base64 === 'string')
      ? null
      : 'workspace.write needs either text or base64';
  },
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
 * A task run's event from NanoAgent (`{type, runId, ...fields}`) as a bridge
 * event `{event, data}`, its fields without the type and NanoAgent's run id,
 * which the host's own run id replaces. Null for anything but `task.*`.
 */
export function taskEvent(data) {
  if (!isObject(data) || typeof data.type !== 'string' || !data.type.startsWith('task.')) return null;
  const {type, runId: _runId, ...fields} = data;
  return {event: type, data: fields};
}

/**
 * One event of /api/ai/stream as a bridge event `{event, data, final}`; `final`
 * marks the answer or the failure that ends the run. Null for the lifecycle
 * events the protocol has no counterpart for.
 */
export function chatEvent({event, data}) {
  if (event === 'delta') return {event: 'chat.delta', data: {text: data.text}};
  if (event === 'agent' && (data?.type === 'tool.completed' || data?.type === 'tool.failed')) {
    return {
      event: 'chat.tool',
      data: {
        name: data.call.name,
        arguments: data.call.arguments,
        output: data.call.output,
        isError: data.type === 'tool.failed',
      },
    };
  }
  if (event === 'done') {
    return {event: 'chat.answer', data: {text: data.text, metrics: answerMetrics(data)}, final: true};
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

export function bytesToBase64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/** The bytes of a base64 string; throws on one that is not base64. */
export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
