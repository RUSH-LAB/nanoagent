/**
 * Mochi Lab's relay: this computer's NanoAgent, lent to its member's runs on
 * Mochi (server/runner.js). It signs in as the member, dials Mochi, and makes
 * each request Mochi sends against the NanoAgent beside it, streaming the
 * response back (runner/protocol.js). Mochi never reaches this computer; the
 * relay reaches Mochi, and only the routes the protocol allows reach NanoAgent.
 *
 * The desktop supervisor runs it with:
 *   MOCHI_SITE_URL        the Mochi it serves
 *   NANOAGENT_URL         the NanoAgent beside it, and NANOAGENT_API_TOKEN, its bearer token
 *   RUNNER_CREDENTIALS    where the member's session token is kept (mode 0600)
 *   RUNNER_DEVICE         what Settings → AI calls this computer
 *   RUNNER_KEYS           which API keys Mochi Lab holds: [{env, label, set}], as JSON
 * and reads what happens as JSON lines on stdout:
 *   {"event": "sign-in", "url", "code"}   open url in a browser and approve code
 *   {"event": "connected"}                runs may come
 *   {"event": "disconnected", "reason"}   reconnecting
 *   {"event": "keys", "id", "changes"}    apply these keys: answer {"id", "error"} on stdin,
 *                                         error null once NanoAgent has them
 * and writes {"keys": [{env, label, set}]} on stdin whenever which keys are set changes.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const {PATH, allowed, pickHeaders} = createRequire(import.meta.url)('./protocol.js');

const CLIENT_ID = 'mochi-desktop';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
// What Mochi sends when another computer signs in as this member (server/runner.js).
const REPLACED = 4000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const say = event => process.stdout.write(`${JSON.stringify(event)}\n`);

async function post(site, route, body) {
  const response = await fetch(`${site}${route}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: site},
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return {status: response.status, data};
}

/** The device-authorization grant, as cli/mochi.mjs signs in: a session token for the member. */
async function signIn(site) {
  const {status, data: code} = await post(site, '/api/auth/device/code', {client_id: CLIENT_ID});
  if (status !== 200) throw new Error(`Mochi refused a sign-in code (${status}): ${code.error ?? ''}`);
  say({event: 'sign-in', url: code.verification_uri_complete, code: code.user_code});
  let interval = code.interval * 1000;
  for (;;) {
    await sleep(interval);
    let answer;
    try {
      answer = await post(site, '/api/auth/device/token', {grant_type: DEVICE_GRANT, device_code: code.device_code, client_id: CLIENT_ID});
    } catch {
      continue;
    }
    if (answer.data.access_token) return answer.data.access_token;
    if (answer.data.error === 'slow_down') interval += 5000;
    else if (answer.data.error !== 'authorization_pending' && answer.status < 502) {
      throw new Error(`Sign-in failed: ${answer.data.error_description ?? answer.data.error ?? answer.status}`);
    }
  }
}

/** Make one request Mochi sent against NanoAgent, streaming its response down `socket`. */
async function relay(frame, {socket, nanoagent, nanoagentToken, running}) {
  const send = message => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
  if (!allowed(frame.method, frame.path)) {
    return send({type: 'error', id: frame.id, message: `${frame.method} ${frame.path} is not for this computer`});
  }
  const controller = new AbortController();
  running.set(frame.id, controller);
  try {
    const response = await fetch(`${nanoagent}${frame.path}`, {
      method: frame.method,
      headers: {...pickHeaders(frame.headers), ...(nanoagentToken ? {Authorization: `Bearer ${nanoagentToken}`} : {})},
      ...(frame.body === undefined ? {} : {body: Buffer.from(frame.body, 'base64')}),
      signal: controller.signal,
    });
    send({type: 'head', id: frame.id, status: response.status, headers: pickHeaders(response.headers)});
    for await (const chunk of response.body ?? []) send({type: 'chunk', id: frame.id, data: Buffer.from(chunk).toString('base64')});
    send({type: 'end', id: frame.id});
  } catch (error) {
    if (!controller.signal.aborted) send({type: 'error', id: frame.id, message: `NanoAgent on this computer: ${error.message}`});
  } finally {
    running.delete(frame.id);
  }
}

/**
 * One connection to Mochi, open until it closes: resolves with its close code.
 * Requests run side by side; Mochi's `abort` stops one, and a closed socket all.
 * `keys` is which API keys this computer holds, `saveKeys(changes)` applies new
 * ones, and `onKeys(listener)` hears which are set whenever that changes, to
 * tell Mochi again.
 */
export function connect({site, nanoagent, nanoagentToken, token, device, keys = [], saveKeys, onKeys, onEvent = say}) {
  return new Promise(resolve => {
    const url = new URL(PATH, site);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, {headers: {Authorization: `Bearer ${token}`}});
    const running = new Map();
    const send = message => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
    let current = keys;
    const unlisten = onKeys?.(list => {
      current = list;
      send({type: 'hello', device, keys: current});
    });
    socket.onopen = () => {
      send({type: 'hello', device, keys: current});
      onEvent({event: 'connected'});
    };
    socket.onmessage = ({data}) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (frame.type === 'request') relay(frame, {socket, nanoagent, nanoagentToken, running});
      else if (frame.type === 'abort') running.get(frame.id)?.abort();
      else if (frame.type === 'keys') {
        saveKeys(frame.changes).then(
          () => send({type: 'saved', id: frame.id}),
          error => send({type: 'error', id: frame.id, message: error.message}),
        );
      }
    };
    let ended = false;
    const end = result => {
      if (ended) return;
      ended = true;
      unlisten?.();
      for (const controller of running.values()) controller.abort();
      resolve(result);
    };
    socket.onclose = ({code, reason}) => end({code, reason});
    // A connection that never opens (Mochi unreachable, or the upgrade refused) fires only
    // `error` in Node, never `close`.
    socket.onerror = () => end({code: 1006, reason: 'Could not reach Mochi'});
  });
}

async function readToken(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')).token ?? null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Whether Mochi still knows `token`: true, false, or null when Mochi cannot be reached. */
async function signedIn(site, token) {
  try {
    const response = await fetch(`${site}/api/auth/get-session`, {headers: {Authorization: `Bearer ${token}`}});
    if (!response.ok) return null;
    return Boolean((await response.json())?.user);
  } catch {
    return null;
  }
}

/**
 * The supervisor's keys: applying new ones (asked on stdout, answered on
 * stdin), and hearing which are set (on stdin) whenever that changes.
 */
function supervisorKeys() {
  const waiting = new Map();
  const listeners = new Set();
  let next = 0;
  readline.createInterface({input: process.stdin}).on('line', line => {
    const {id, error, keys} = JSON.parse(line);
    if (keys) return listeners.forEach(listener => listener(keys));
    const call = waiting.get(id);
    waiting.delete(id);
    if (error) call?.reject(new Error(error));
    else call?.resolve();
  });
  return {
    saveKeys: changes => new Promise((resolve, reject) => {
      next += 1;
      waiting.set(next, {resolve, reject});
      say({event: 'keys', id: next, changes});
    }),
    onKeys(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function main(env) {
  const site = new URL(env.MOCHI_SITE_URL).origin;
  const credentials = env.RUNNER_CREDENTIALS;
  const options = {
    site,
    nanoagent: env.NANOAGENT_URL.replace(/\/$/, ''),
    nanoagentToken: env.NANOAGENT_API_TOKEN,
    device: env.RUNNER_DEVICE || os.hostname(),
    ...supervisorKeys(),
  };
  // Which keys are set, for each connection's hello, kept as the supervisor says it changes.
  let keys = JSON.parse(env.RUNNER_KEYS);
  options.onKeys(list => { keys = list; });
  let token = await readToken(credentials);
  for (let attempt = 0; ; attempt += 1) {
    if (token && await signedIn(site, token) === false) {
      await fs.rm(credentials, {force: true});
      token = null;
    }
    if (!token) {
      token = await signIn(site);
      await fs.mkdir(path.dirname(credentials), {recursive: true, mode: 0o700});
      await fs.writeFile(credentials, `${JSON.stringify({site, token})}\n`, {mode: 0o600});
    }
    const opened = Date.now();
    const {code, reason} = await connect({...options, keys, token});
    say({event: 'disconnected', reason: String(reason || code)});
    // Another computer took this member's runs; this one stops.
    if (code === REPLACED) return;
    if (Date.now() - opened > 60_000) attempt = 0;
    await sleep(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]);
  }
}

// As a URL the path is escaped ("Application Support" is Application%20Support), so compare paths.
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  main(process.env).catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
