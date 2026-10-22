'use strict';

/**
 * Members' own computers, each running NanoAgent for its member (RUSH Lab).
 *
 * A computer dials in: it opens a WebSocket to /api/runner signed in as its
 * member, and from then on that member's runs go down that socket
 * (runner/protocol.js): every run is on the member's own computer. RUSH cannot reach a laptop, so the laptop reaches
 * RUSH. Settings → AI sets the computer's API keys, and the addresses of the
 * member's own vLLM and SGLang servers, the same way: RUSH passes them on and
 * keeps nothing, and the computer says only which are set. One
 * computer per member: a second replaces the first. The sockets are
 * this process's, like every other live connection here (fs/events.js).
 *
 * Plugin pages come from the computer too. Their frame carries no session, so
 * a page's address names the computer by `page`, a random id of its connection.
 */
const crypto = require('crypto');
const {WebSocketServer} = require('ws');
const {PATH, HOLD_MS, SERVER_URLS, isServerUrl, pickHeaders} = require('../runner/protocol');
const {createNanoAgentGateway, RUNNER_OFFLINE} = require('./ai');

// A plugin package travels in one frame.
const MAX_PAYLOAD = 64 * 1024 * 1024;
const PING_MS = 25_000;
const REPLACED = 4000;
// The close code a server shutting down sends, so each RUSH Lab dials its replacement.
const GOING_AWAY = 1001;
const OUTDATED = 'RUSH Lab on your computer is out of date for plugin runs. It updates itself once nothing runs; or quit it and open it again.';
const NULL_BODY = new Set([101, 204, 205, 304]);
// What a key's name and value may be, as RUSH Lab's lab.mjs checks them again.
const KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const KEY_LENGTH = 1000;
// A hint is ten characters and an ellipsis (runner/lab.mjs keyHint); a longer one is cut.
const HINT_LENGTH = 16;

/**
 * The computer's `hello` list of keys, as {env, label, set, hint}; anything else
 * is dropped. A hint is how a set key begins and ends, never the key; a server's
 * address (SERVER_URLS) is no secret, and its hint is the whole address.
 */
function keyList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50)
    .filter(key => KEY_NAME.test(key?.env) && typeof key.label === 'string')
    .map(key => ({
      env: key.env,
      label: key.label.slice(0, 100),
      set: key.set === true,
      hint: key.set === true && typeof key.hint === 'string'
        ? key.hint.slice(0, SERVER_URLS.includes(key.env) ? KEY_LENGTH : HINT_LENGTH)
        : null,
    }));
}

/** An error of the member's computer or its connection, which a run reports as it is. */
const gone = message => Object.assign(new Error(message), {code: 'runner'});

/**
 * `fetch`, made by the computer behind `entry`'s socket. With `init.run`
 * (`{id, resume}`), the request is a held one (runner/protocol.js) by that id,
 * started, or with `resume` taken up again from its first frame; a held call
 * outlives the socket, and follows the computer to its next one (`call.entry`).
 * `init.files` (`{workspace, plugin}`) makes it a plugin run on the member's files
 * there, which the computer keeps (runner/run-files.mjs).
 */
function socketFetch(entry) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) return reject(signal.reason);
    if (entry.closed) return reject(gone('RUSH Lab disconnected'));
    // COMPAT(run-files): an engine from before run-files.mjs would run the plugin on an empty folder.
    if (init.files && entry.files === false) return reject(gone(OUTDATED));
    const id = init.run?.id ?? crypto.randomUUID();
    let stream;
    let answered = false;
    const body = new ReadableStream({
      start: controller => { stream = controller; },
      cancel: () => finish({type: 'abort', id}),
    });
    const onAbort = () => fail(signal.reason, {type: 'abort', id});
    function finish(frame) {
      call.entry.pending.delete(id);
      call.leftAway?.();
      signal?.removeEventListener('abort', onAbort);
      if (frame && !call.entry.closed) call.entry.socket.send(JSON.stringify(frame));
    }
    function fail(error, frame) {
      finish(frame);
      if (!answered) reject(error);
      else try { stream.error(error); } catch { /* already closed */ }
    }
    const call = {
      entry,
      hold: Boolean(init.run),
      // How many of its frames came, for a held call to resume after.
      frames: 0,
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
    };
    entry.pending.set(id, call);
    signal?.addEventListener('abort', onAbort, {once: true});
    if (init.run?.resume) {
      entry.socket.send(JSON.stringify({type: 'resume', id, from: 0}));
      return;
    }
    const {pathname, search} = new URL(url);
    entry.socket.send(JSON.stringify({
      type: 'request',
      id,
      method: init.method ?? 'GET',
      path: pathname + search,
      headers: pickHeaders(init.headers),
      ...(init.body === undefined ? {} : {body: Buffer.from(init.body).toString('base64')}),
      ...(init.run ? {hold: true} : {}),
      ...(init.files ? {files: init.files} : {}),
    }));
  });
}

/**
 * `openrouterKeys` (openrouter-keys.js), when RUSH gives members an OpenRouter
 * key: a computer that connects without one is given one.
 */
function createRunners({resolveIdentity, openrouterKeys = null}) {
  const connected = new Map();
  const pages = new Map();
  // Held calls whose computer went away, by id: {userId, call, timer}, until it is back.
  const away = new Map();
  let onRuns = () => {};
  const offline = createNanoAgentGateway({endpoint: {error: RUNNER_OFFLINE}, local: true});
  const sockets = new WebSocketServer({noServer: true, maxPayload: MAX_PAYLOAD});

  function attach(userId, socket) {
    // `runs`: the held requests the computer said it has, once it has said hello.
    // `files`: whether it keeps plugin runs' files (runner/run-files.mjs), once it has said hello.
    const entry = {socket, page: crypto.randomUUID(), device: null, since: new Date().toISOString(), keys: [], pending: new Map(), closed: false, runs: null, files: null};
    entry.gateway = createNanoAgentGateway({endpoint: {url: 'http://runner'}, fetchImpl: socketFetch(entry), local: true});
    // The connection before is done with now, not once its socket closes: one that died closes
    // only after a while, and the hello this one sends takes up its held calls (claimAway).
    const previous = connected.get(userId);
    if (previous) {
      detach(userId, previous);
      previous.socket.close(REPLACED, 'Another RUSH Lab signed in as this account');
    }
    connected.set(userId, entry);
    pages.set(entry.page, entry);
    const ping = setInterval(() => socket.ping(), PING_MS);
    socket.on('message', raw => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return socket.close(1003, 'Frames are JSON');
      }
      if (frame?.type === 'hello') {
        // A hello again is the computer saying its keys changed: a key the member removed stays removed.
        const first = !entry.greeted;
        entry.greeted = true;
        entry.device = typeof frame.device === 'string' ? frame.device.slice(0, 100) : null;
        entry.keys = keyList(frame.keys);
        entry.files = frame.files === true;
        if (first) giveKey(userId, entry);
        const runs = Array.isArray(frame.runs) ? frame.runs.filter(id => typeof id === 'string') : [];
        entry.runs = new Set(runs);
        claimAway(userId);
        return onRuns(userId, runs.filter(id => !entry.pending.has(id)));
      }
      const call = entry.pending.get(frame?.id);
      if (!call) return;
      call.frames += 1;
      if (frame.type === 'head') call.head(frame.status, frame.headers);
      else if (frame.type === 'chunk') call.chunk(frame.data);
      else if (frame.type === 'end') call.end();
      else if (frame.type === 'saved') call.saved();
      else if (frame.type === 'error') call.fail(gone(String(frame.message)));
    });
    socket.on('close', () => {
      clearInterval(ping);
      detach(userId, entry);
    });
    socket.on('error', error => {
      console.error('[runner] A computer\'s connection failed:', error.message);
      socket.terminate();
    });
  }

  /**
   * `entry` is not the member's connection any more: its calls fail, but a held one waits for the
   * computer to come back, for HOLD_MS. Once only: at its socket's close, or sooner when another
   * connection of the member's replaces it.
   */
  function detach(userId, entry) {
    if (entry.closed) return;
    entry.closed = true;
    for (const [id, call] of entry.pending) {
      if (!call.hold) {
        call.fail(gone('RUSH Lab disconnected'));
        continue;
      }
      entry.pending.delete(id);
      const timer = setTimeout(() => call.fail(gone(`RUSH Lab disconnected, and was not back within ${HOLD_MS / 60_000} minutes`)), HOLD_MS);
      // Waiting keeps no process up: one shutting down lets its calls go.
      timer.unref();
      // A call that ends while its computer is away (it is cancelled) is not waited for any more.
      call.leftAway = () => {
        clearTimeout(timer);
        away.delete(id);
        call.leftAway = null;
      };
      away.set(id, {userId, call});
    }
    if (connected.get(userId) === entry) connected.delete(userId);
    pages.delete(entry.page);
    // The computer may be back already, its hello heard before this socket's close.
    claimAway(userId);
  }

  /** An OpenRouter key from RUSH, saved on the member's computer when it holds none of its own. */
  function giveKey(userId, entry) {
    const slot = entry.keys.find(key => key.env === openrouterKeys?.ENV);
    if (!slot || slot.set) return;
    openrouterKeys.give(userId)
      .then(key => !entry.closed && api.saveKeys(userId, {[slot.env]: key}))
      .then(result => { if (result?.error) throw new Error(result.error); })
      .catch(error => console.error(`[runner] Could not give ${userId} an OpenRouter key:`, error.message));
  }

  /**
   * Hand each held call of the member's whose computer went away to the
   * computer connected now, once it has said which held requests it has
   * (`hello`): a call goes on from the frames it had, or fails when the
   * computer does not have it any more. The held requests this process has no
   * call for (it started since) go to `onRuns`, from the hello.
   */
  function claimAway(userId) {
    const entry = connected.get(userId);
    if (!entry || entry.closed || !entry.runs) return;
    for (const [id, {userId: owner, call}] of away) {
      if (owner !== userId) continue;
      call.leftAway();
      if (!entry.runs.has(id)) {
        call.fail(gone('RUSH Lab stopped while answering'));
        continue;
      }
      call.entry = entry;
      entry.pending.set(id, call);
      entry.socket.send(JSON.stringify({type: 'resume', id, from: call.frames}));
    }
  }

  const api = Object.freeze({
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

    /** The `page` id plugin pages address the member's connected computer by, else null. */
    page(userId) {
      return connected.get(userId)?.page ?? null;
    },

    /** The NanoAgent of the computer whose connection has the `page` id, else null. */
    byPage(page) {
      return pages.get(page)?.gateway ?? null;
    },

    /** Whether the member's computer is connected, what it calls itself, and which keys it holds. */
    status(userId) {
      const entry = connected.get(userId);
      return entry ? {connected: true, device: entry.device, since: entry.since, keys: entry.keys} : {connected: false, device: null, since: null, keys: []};
    },

    /**
     * Set (a key) or remove (null) API keys on the member's computer, by the
     * names its `hello` listed; its runs use them as soon as it answers.
     */
    async saveKeys(userId, changes) {
      const entry = connected.get(userId);
      if (!entry) return {error: 'RUSH Lab is not connected', status: 409};
      const names = new Set(entry.keys.map(key => key.env));
      const pairs = changes && typeof changes === 'object' && !Array.isArray(changes) ? Object.entries(changes) : [];
      if (!pairs.length) return {error: 'changes must name at least one key', status: 400};
      for (const [name, value] of pairs) {
        if (!names.has(name)) return {error: `${name} is not a key RUSH Lab holds`, status: 400};
        if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > KEY_LENGTH)) {
          return {error: `${name} must be a key, or null to remove it`, status: 400};
        }
        if (value !== null && SERVER_URLS.includes(name) && !isServerUrl(value.trim())) {
          return {error: `${name} must be an http:// or https:// address, without credentials, query or fragment`, status: 400};
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
     * Hear, from each computer that says hello, which held requests it has that
     * this process has no call for: `listener(userId, ids)`.
     */
    onRuns(listener) {
      onRuns = listener;
    },

    /** Tell the member's computer RUSH has kept what the held request `id` did, if it is connected. */
    release(userId, id) {
      const entry = connected.get(userId);
      if (entry && !entry.closed) entry.socket.send(JSON.stringify({type: 'release', id}));
    },

    /** The NanoAgent the member's runs go to: their computer's, refusing every call while it is not connected. */
    async aiFor(userId) {
      return connected.get(userId)?.gateway ?? offline;
    },

    /**
     * Let every computer go, for a shutdown: an upgraded socket is not the HTTP
     * server's any more, so `server.close()` alone would wait on it for ever.
     */
    close() {
      for (const entry of connected.values()) entry.socket.close(GOING_AWAY, 'RUSH is restarting');
    },
  });
  return api;
}

module.exports = {createRunners, socketFetch, MAX_PAYLOAD};
