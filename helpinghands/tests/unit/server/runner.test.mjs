import {describe, it, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {connect} from '../../../src/runner/relay.mjs';

const require = createRequire(import.meta.url);
const {createRunners} = require('../../../src/server/runner.js');
const {RUNNER_OFFLINE} = require('../../../src/server/ai.js');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const until = async test => {
  for (let i = 0; i < 200 && !test(); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(test(), 'timed out');
};

/** A NanoAgent on "the member's computer": records what it was asked, answers a run as SSE. */
function fakeNanoAgent() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = {method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks), closed: false};
    seen.push(call);
    res.on('close', () => { call.closed = true; });
    if (req.url === '/v1/runs') {
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      res.write('data: {"type":"delta","kind":"content","text":"hello "}\n\n');
      if (JSON.parse(call.body).input === 'hang') return;
      res.end('data: {"type":"delta","kind":"content","text":"world"}\n\ndata: {"type":"done","answer":"hello world","cost":0.01}\n\n');
      return;
    }
    if (req.method === 'GET' && /^\/v1\/installs\/[^/]+\/ui\//.test(req.url)) {
      res.writeHead(200, {'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'immutable'});
      return res.end('<!doctype html>');
    }
    if (req.method === 'PUT' && req.url.startsWith('/v1/installs/')) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({plugin: {id: 'echo', bytes: call.body.length}}));
    }
    res.writeHead(404, {'Content-Type': 'application/json'}).end('{"error":"not here"}');
  });
  return {server, seen};
}

describe('a member\'s own computer (server/runner.js, runner/relay.mjs)', () => {
  let mochi; let site; let nano; let nanoUrl; let runners; let relays; let sockets;
  // Upgraded sockets leave the HTTP server's books, so the suite drops them itself.
  const dropComputers = () => sockets.forEach(socket => socket.destroy());

  beforeEach(async () => {
    relays = [];
    sockets = [];
    runners = createRunners({
      resolveIdentity: async ({headers}) => (headers.authorization === 'Bearer member-token' && !headers.cookie
        ? {ok: true, identity: {userId: 'u1'}}
        : {ok: false, status: 401, error: 'Not signed in'}),
    });
    mochi = http.createServer((req, res) => res.writeHead(404).end());
    mochi.on('upgrade', (req, socket, head) => {
      sockets.push(socket);
      runners.upgrade(req, socket, head);
    });
    site = await listen(mochi);
    nano = fakeNanoAgent();
    nanoUrl = await listen(nano.server);
  });

  afterEach(async () => {
    dropComputers();
    mochi.closeAllConnections();
    nano.server.closeAllConnections();
    await Promise.all([new Promise(resolve => mochi.close(resolve)), new Promise(resolve => nano.server.close(resolve))]);
    await Promise.all(relays);
  });

  async function dialIn(token = 'member-token', options = {}) {
    let opened = false;
    const closed = connect({site, nanoagent: nanoUrl, nanoagentToken: 'nano-secret', token, device: 'laptop', ...options, onEvent: event => {
      opened = true;
      options.onEvent?.(event);
    }});
    relays.push(closed);
    await until(() => opened && runners.status('u1').device === 'laptop');
    // In an object: an async function returning the promise itself would wait for it.
    return {closed};
  }

  it('sends a member\'s run to their computer, with its NanoAgent\'s token, and streams it back', async () => {
    await dialIn();
    const ai = await runners.aiFor('u1');
    assert.equal(ai.local, true);
    const deltas = [];
    const result = await ai.stream({input: 'hi', onDelta: text => deltas.push(text)});
    assert.equal(result.text, 'hello world');
    assert.deepEqual(deltas, ['hello ', 'world']);
    assert.equal(nano.seen[0].url, '/v1/runs');
    assert.equal(nano.seen[0].authorization, 'Bearer nano-secret');
  });

  it('carries a package\'s bytes intact', async () => {
    await dialIn();
    const data = Buffer.from(Array.from({length: 70_000}, (_, i) => i % 256));
    const put = await (await runners.aiFor('u1')).installPackage('a'.repeat(64), data);
    assert.equal(put.value.plugin.bytes, data.length);
    assert.deepEqual(nano.seen[0].body, data);
  });

  it('serves a plugin page from the computer its connection\'s page id names, with its own policy, until it leaves', async () => {
    await dialIn();
    const page = runners.page('u1');
    assert.match(page, /^[0-9a-f-]{36}$/);
    const file = await runners.byPage(page).installUiFile('a'.repeat(64), '0123456789abcdef', 'index.html');
    assert.equal(file.value.toString(), '<!doctype html>');
    assert.equal(file.headers.get('content-security-policy'), "default-src 'none'");
    assert.equal(file.headers.get('cache-control'), 'immutable');
    assert.equal(nano.seen[0].url, `/v1/installs/${'a'.repeat(64)}/ui/0123456789abcdef/index.html`);
    assert.equal(runners.byPage('another-page'), null);
    dropComputers();
    await until(() => !runners.status('u1').connected);
    assert.equal(runners.byPage(page), null);
    assert.equal(runners.page('u1'), null);
  });

  it('refuses a run while the member\'s computer is not connected, rather than running it elsewhere', async () => {
    const result = await (await runners.aiFor('u1')).stream({input: 'hi'});
    assert.deepEqual(result, {error: RUNNER_OFFLINE, status: 503});
    assert.deepEqual(await (await runners.aiFor(null)).stream({input: 'hi'}), {error: RUNNER_OFFLINE, status: 503});
    assert.deepEqual(runners.status('u1'), {connected: false, device: null, keys: []});
  });

  it('sets the computer\'s API keys by the names it listed, and hears which are set now', async () => {
    const kept = [];
    let announce;
    await dialIn('member-token', {
      keys: [{env: 'OPENROUTER_API_KEY', label: 'OpenRouter', set: false}],
      // As the supervisor does: which keys are set, said before the answer.
      saveKeys: async changes => {
        if (changes.OPENROUTER_API_KEY === 'two words') throw new Error('OPENROUTER_API_KEY must be one key, without spaces');
        kept.push(changes);
        announce([{env: 'OPENROUTER_API_KEY', label: 'OpenRouter', set: true, hint: 'sk-or-…cdef'}]);
      },
      onKeys: listener => { announce = listener; },
    });
    assert.deepEqual(runners.status('u1').keys, [{env: 'OPENROUTER_API_KEY', label: 'OpenRouter', set: false, hint: null}]);
    assert.deepEqual(await runners.saveKeys('u1', {OPENROUTER_API_KEY: 'sk-1'}), {value: {saved: true}});
    assert.deepEqual(kept, [{OPENROUTER_API_KEY: 'sk-1'}]);
    assert.deepEqual(runners.status('u1').keys[0], {env: 'OPENROUTER_API_KEY', label: 'OpenRouter', set: true, hint: 'sk-or-…cdef'});
    assert.deepEqual(await runners.saveKeys('u1', {OPENROUTER_API_KEY: 'two words'}), {error: 'OPENROUTER_API_KEY must be one key, without spaces', status: 400});
    assert.equal((await runners.saveKeys('u1', {OPENAI_API_KEY: 'sk-2'})).status, 400);
    assert.equal((await runners.saveKeys('u1', {})).status, 400);
    assert.equal(kept.length, 1);
    assert.equal((await runners.saveKeys('u2', {OPENROUTER_API_KEY: 'sk-1'})).status, 409);
  });

  it('cancels the run on the computer when the caller hangs up', async () => {
    await dialIn();
    const controller = new AbortController();
    const running = (await runners.aiFor('u1')).stream({input: 'hang', signal: controller.signal, onDelta: () => controller.abort()});
    assert.equal((await running).status, 499);
    await until(() => nano.seen[0]?.closed);
  });

  it('fails a run in flight when the computer drops off', async () => {
    const {closed} = await dialIn();
    const running = (await runners.aiFor('u1')).stream({input: 'hang', onDelta: dropComputers});
    assert.equal((await running).status, 502);
    await closed;
    assert.equal(runners.status('u1').connected, false);
  });

  it('lets the computer reach only what runs need: never the marketplace', async () => {
    await dialIn();
    const listed = await (await runners.aiFor('u1')).packages();
    assert.equal(listed.status, 502);
    assert.deepEqual(nano.seen, []);
  });

  it('ends a connection that never opens, so the relay can try again', async () => {
    assert.equal((await connect({site: 'http://127.0.0.1:1', nanoagent: nanoUrl, token: 'member-token', onEvent: () => {}})).code, 1006);
    assert.equal((await connect({site, nanoagent: nanoUrl, token: 'stolen', onEvent: () => {}})).code, 1006);
  });

  it('keeps one computer per member: a second replaces the first', async () => {
    const {closed: first} = await dialIn();
    relays.push(connect({site, nanoagent: nanoUrl, token: 'member-token', device: 'desktop', onEvent: () => {}}));
    assert.equal((await first).code, 4000);
    await until(() => runners.status('u1').device === 'desktop');
  });

  it('lets every computer go when the server shuts down, so each dials the next one', async () => {
    const {closed} = await dialIn();
    runners.close();
    assert.equal((await closed).code, 1001);
    await until(() => !runners.status('u1').connected);
  });

  it('takes a computer signed in by bearer token only: no browser page, no cookie, no bad token', async () => {
    const upgrade = headers => new Promise(resolve => {
      const req = http.request(`${site}/api/runner`, {headers: {Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers}});
      req.on('response', response => resolve(response.statusCode));
      req.on('upgrade', response => { response.socket.destroy(); resolve(101); });
      req.end();
    });
    assert.equal(await upgrade({Authorization: 'Bearer member-token'}), 101);
    assert.equal(await upgrade({Authorization: 'Bearer member-token', Origin: 'https://evil.example'}), 403);
    assert.equal(await upgrade({Cookie: 'session=member'}), 403);
    assert.equal(await upgrade({Authorization: 'Bearer member-token', Cookie: 'session=member'}), 101);
    assert.equal(await upgrade({Authorization: 'Bearer stolen'}), 401);
  });
});
