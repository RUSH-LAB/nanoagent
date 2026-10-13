'use strict';

/**
 * Members' own computers, each running NanoAgent for its member (Mochi Lab).
 *
 * A computer dials in: it opens a WebSocket to /api/runner signed in as its
 * member, and from then on that member's runs go down that socket
 * (runner/protocol.js): every run is on the member's own computer. Mochi cannot reach a laptop, so the laptop reaches
 * Mochi. Settings → AI sets the computer's API keys the same way: Mochi passes
 * them on and keeps nothing, and the computer says only which are set. One
 * computer per member: a second replaces the first. The sockets are
 * this process's, like every other live connection here (fs/events.js).
 */
const crypto = require('crypto');
const {WebSocketServer} = require('ws');
const {PATH, pickHeaders} = require('../runner/protocol');
const {createNanoAgentGateway, RUNNER_OFFLINE} = require('./ai');

// A plugin package travels in one frame.
const MAX_PAYLOAD = 64 * 1024 * 1024;
const PING_MS = 25_000;
const REPLACED = 4000;
// The close code a server shutting down sends, so each Mochi Lab dials its replacement.
const GOING_AWAY = 1001;
const NULL_BODY = new Set([101, 204, 205, 304]);
// What a key's name and value may be, as Mochi Lab's supervisor checks them again.
const KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const KEY_LENGTH = 1000;
// A hint is ten characters and an ellipsis (desktop supervisor.rs key_hint); a longer one is cut.
const HINT_LENGTH = 16;

/**
 * The computer's `hello` list of keys, as {env, label, set, hint}; anything else
 * is dropped. A hint is how a set key begins and ends, never the key.
 */
function keyList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50)
    .filter(key => KEY_NAME.test(key?.env) && typeof key.label === 'string')
    .map(key => ({
      env: key.env,
      label: key.label.slice(0, 100),
      set: key.set === true,
      hint: key.set === true && typeof key.hint === 'string' ? key.hint.slice(0, HINT_LENGTH) : null,
    }));
}

/** `fetch`, made by the computer behind `entry`'s socket. */
function socketFetch(entry) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) return reject(signal.reason);
    if (entry.closed) return reject(new Error('Mochi Lab disconnected'));
    const id = crypto.randomUUID();
    let stream;
    let answered = false;
    const body = new ReadableStream({
      start: controller => { stream = controller; },
      cancel: () => finish({type: 'abort', id}),
    });
    const onAbort = () => fail(signal.reason, {type: 'abort', id});
    function finish(frame) {
      entry.pending.delete(id);
      signal?.removeEventListener('abort', onAbort);
      if (frame && !entry.closed) entry.socket.send(JSON.stringify(frame));
    }
    function fail(error, frame) {
      finish(frame);
      if (!answered) reject(error);
      else try { stream.error(error); } catch { /* already closed */ }
    }
    entry.pending.set(id, {
      head(status, headers) {
        answered = true;
        resolve(new Response(NULL_BODY.has(status) ? null : body, {status, headers}));
      },
      chunk: data => stream.enqueue(new Uint8Array(Buffer.from(data, 'base64'))),
      end() {
        finish();
        stream.close();
      },
      fail,
    });
    signal?.addEventListener('abort', onAbort, {once: true});
    const {pathname, search} = new URL(url);
    entry.socket.send(JSON.stringify({
      type: 'request',
      id,
      method: init.method ?? 'GET',
      path: pathname + search,
      headers: pickHeaders(init.headers),
      ...(init.body === undefined ? {} : {body: Buffer.from(init.body).toString('base64')}),
    }));
  });
}

/**
 * `memberKeys` (postgres/member-keys.js) holds the keys members gave Mochi
 * itself: a member with no computer connected runs on the hosted NanoAgent
 * with them, and with neither, every run is refused.
 */
function createRunners({resolveIdentity, memberKeys = null, env = process.env}) {
  const connected = new Map();
  const offline = createNanoAgentGateway({endpoint: {error: RUNNER_OFFLINE}, local: true});
  const sockets = new WebSocketServer({noServer: true, maxPayload: MAX_PAYLOAD});

  function attach(userId, socket) {
    const entry = {socket, device: null, keys: [], pending: new Map(), closed: false};
    entry.gateway = createNanoAgentGateway({endpoint: {url: 'http://runner'}, fetchImpl: socketFetch(entry), local: true});
    connected.get(userId)?.socket.close(REPLACED, 'Another Mochi Lab signed in as this account');
    connected.set(userId, entry);
    const ping = setInterval(() => socket.ping(), PING_MS);
    socket.on('message', raw => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return socket.close(1003, 'Frames are JSON');
      }
      if (frame?.type === 'hello') {
        entry.device = typeof frame.device === 'string' ? frame.device.slice(0, 100) : null;
        entry.keys = keyList(frame.keys);
        return;
      }
      const call = entry.pending.get(frame?.id);
      if (!call) return;
      if (frame.type === 'head') call.head(frame.status, frame.headers);
      else if (frame.type === 'chunk') call.chunk(frame.data);
      else if (frame.type === 'end') call.end();
      else if (frame.type === 'saved') call.saved();
      else if (frame.type === 'error') call.fail(new Error(String(frame.message)));
    });
    socket.on('close', () => {
      clearInterval(ping);
      entry.closed = true;
      for (const call of entry.pending.values()) call.fail(new Error('Mochi Lab disconnected'));
      if (connected.get(userId) === entry) connected.delete(userId);
    });
    socket.on('error', () => socket.terminate());
  }

  return Object.freeze({
    /**
     * Take an HTTP upgrade to PATH, signed in by a bearer token only: a page in
     * a browser carries an Origin and the member's cookie, and could otherwise
     * register itself as their computer.
     */
    async upgrade(req, socket, head) {
      socket.on('error', () => socket.destroy());
      const refuse = (status, text) => {
        socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      if (new URL(req.url, 'http://mochi').pathname !== PATH) return refuse(404, 'Not Found');
      if (req.headers.origin || !/^Bearer /i.test(req.headers.authorization ?? '')) return refuse(403, 'Forbidden');
      const headers = {...req.headers};
      delete headers.cookie;
      const resolved = await resolveIdentity({headers});
      if (!resolved.ok) return refuse(401, 'Unauthorized');
      sockets.handleUpgrade(req, socket, head, client => attach(resolved.identity.userId, client));
    },

    /** The NanoAgent on the member's computer while it is connected, else null. */
    computer(userId) {
      return connected.get(userId)?.gateway ?? null;
    },

    /** Whether the member's computer is connected, what it calls itself, and which keys it holds. */
    status(userId) {
      const entry = connected.get(userId);
      return entry ? {connected: true, device: entry.device, keys: entry.keys} : {connected: false, device: null, keys: []};
    },

    /**
     * Set (a key) or remove (null) API keys on the member's computer, by the
     * names its `hello` listed; its runs use them as soon as it answers.
     */
    async saveKeys(userId, changes) {
      const entry = connected.get(userId);
      if (!entry) return {error: 'Mochi Lab is not connected', status: 409};
      const names = new Set(entry.keys.map(key => key.env));
      const pairs = changes && typeof changes === 'object' && !Array.isArray(changes) ? Object.entries(changes) : [];
      if (!pairs.length) return {error: 'changes must name at least one key', status: 400};
      for (const [name, value] of pairs) {
        if (!names.has(name)) return {error: `${name} is not a key Mochi Lab holds`, status: 400};
        if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > KEY_LENGTH)) {
          return {error: `${name} must be a key, or null to remove it`, status: 400};
        }
      }
      const id = crypto.randomUUID();
      try {
        await new Promise((saved, fail) => {
          entry.pending.set(id, {saved, fail});
          entry.socket.send(JSON.stringify({type: 'keys', id, changes: Object.fromEntries(pairs)}));
        });
      } catch (error) {
        return {error: error.message, status: entry.closed ? 502 : 400};
      } finally {
        entry.pending.delete(id);
      }
      return {value: {saved: true}};
    },

    /**
     * The NanoAgent the member's runs go to: their computer's while it is
     * connected, else the hosted one with the keys they gave Mochi, else one
     * refusing every call.
     */
    async aiFor(userId) {
      const computer = connected.get(userId)?.gateway;
      if (computer) return computer;
      const keys = userId && memberKeys ? await memberKeys.values(userId) : {};
      if (!keys.OPENROUTER_API_KEY) return offline;
      return createNanoAgentGateway({env, keys, local: true});
    },

    /**
     * Let every computer go, for a shutdown: an upgraded socket is not the HTTP
     * server's any more, so `server.close()` alone would wait on it for ever.
     */
    close() {
      for (const entry of connected.values()) entry.socket.close(GOING_AWAY, 'Mochi is restarting');
    },
  });
}

module.exports = {createRunners, socketFetch, MAX_PAYLOAD};
