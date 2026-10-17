import {describe, it, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {connect} from '../../../src/runner/relay.mjs';

const require = createRequire(import.meta.url);
const {createRunners, CLOUD_PAGE} = require('../../../src/server/runner.js');
const {RUNNER_OFFLINE, createNanoAgentGateway} = require('../../../src/server/ai.js');
const {createCloudRuns} = require('../../../src/server/cloud-runs.js');
const {createPreferences} = require('../../../src/server/preferences.js');
const {createAppRuns} = require('../../../src/server/app-runs.js');
const {fakeSessions, SESSION} = await import('../_harness.mjs');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const until = async test => {
  for (let i = 0; i < 200 && !test(); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(test(), 'timed out');
};

/** A NanoAgent on "the member's computer": records what it was asked, answers a run as SSE. */
function fakeNanoAgent() {
  const seen = [];
  // Each 'slow' run ends when its finisher is called.
  const finishers = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = {method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks), closed: false};
    seen.push(call);
    res.on('close', () => { call.closed = true; });
    if (req.url === '/v1/runs' || /^\/v1\/workspaces\/[^/]+\/installs\/[^/]+\/runs$/.test(req.url)) {
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      res.write('data: {"type":"delta","kind":"content","text":"hello "}\n\n');
      if (JSON.parse(call.body).input === 'hang') return;
      if (JSON.parse(call.body).input === 'slow') {
        finishers.push(() => res.end('data: {"type":"delta","kind":"content","text":"world"}\n\ndata: {"type":"done","answer":"hello world"}\n\n'));
        return;
      }
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
  return {server, seen, finishers};
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
    assert.ok(Date.parse(runners.status('u1').since));
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
    const {page, gateway} = await runners.hostFor('u1');
    assert.match(page, /^[0-9a-f-]{36}$/);
    assert.equal(gateway, runners.computer('u1'));
    const file = await runners.byPage(page).installUiFile('a'.repeat(64), '0123456789abcdef', 'index.html');
    assert.equal(file.value.toString(), '<!doctype html>');
    assert.equal(file.headers.get('content-security-policy'), "default-src 'none'");
    assert.equal(file.headers.get('cache-control'), 'immutable');
    assert.equal(nano.seen[0].url, `/v1/installs/${'a'.repeat(64)}/ui/0123456789abcdef/index.html`);
    assert.equal(runners.byPage('another-page'), null);
    dropComputers();
    await until(() => !runners.status('u1').connected);
    assert.equal(runners.byPage(page), null);
    assert.equal(await runners.hostFor('u1'), null);
  });

  it('refuses a run while the member\'s computer is not connected, rather than running it elsewhere', async () => {
    const result = await (await runners.aiFor('u1')).stream({input: 'hi'});
    assert.deepEqual(result, {error: RUNNER_OFFLINE, status: 503});
    assert.deepEqual(await (await runners.aiFor(null)).stream({input: 'hi'}), {error: RUNNER_OFFLINE, status: 503});
    assert.deepEqual(runners.status('u1'), {connected: false, device: null, since: null, keys: []});
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

  it('gives a computer without an OpenRouter key Mochi\'s, once a connection, and none to one with its own', async () => {
    const given = [];
    runners = createRunners({
      resolveIdentity: async () => ({ok: true, identity: {userId: 'u1'}}),
      openrouterKeys: {ENV: 'OPENROUTER_API_KEY', give: async userId => { given.push(userId); return 'sk-or-mochi'; }},
    });
    const kept = [];
    let announce;
    let set = false;
    const keys = () => [{env: 'OPENROUTER_API_KEY', label: 'OpenRouter', set}];
    await dialIn('member-token', {
      keys: keys(),
      saveKeys: async changes => {
        kept.push(changes);
        set = changes.OPENROUTER_API_KEY !== null;
        announce(keys());
      },
      onKeys: listener => { announce = listener; },
    });
    await until(() => runners.status('u1').keys[0]?.set);
    assert.deepEqual(given, ['u1']);
    assert.deepEqual(kept, [{OPENROUTER_API_KEY: 'sk-or-mochi'}]);
    // Removed, it stays removed: the hello that says so is not a new connection.
    assert.deepEqual(await runners.saveKeys('u1', {OPENROUTER_API_KEY: null}), {value: {saved: true}});
    await until(() => !runners.status('u1').keys[0].set);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(given, ['u1']);

    dropComputers();
    await until(() => !runners.status('u1').connected);
    set = true;
    await dialIn('member-token', {keys: keys(), saveKeys: async () => {}, onKeys: () => {}});
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(given, ['u1']);
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
    assert.deepEqual(await running, {error: 'RUSH Lab disconnected', status: 503});
    await closed;
    assert.equal(runners.status('u1').connected, false);
  });

  it('keeps a held run going while its computer reconnects, every delta once', async () => {
    const held = new Map();
    const {closed} = await dialIn('member-token', {held});
    const deltas = [];
    const running = (await runners.aiFor('u1')).stream({input: 'slow', run: {id: 'run-1'}, onDelta: text => deltas.push(text)});
    await until(() => deltas.length === 1);
    dropComputers();
    await closed;
    await until(() => !runners.status('u1').connected);
    await dialIn('member-token', {held});
    // NanoAgent's run went on all along.
    assert.equal(nano.seen[0].closed, false);
    nano.finishers[0]();
    assert.equal((await running).text, 'hello world');
    assert.deepEqual(deltas, ['hello ', 'world']);
    // Released once Mochi kept it.
    runners.release('u1', 'run-1');
    await until(() => !held.has('run-1'));
  });

  it('hands a held run its computer still has to a server started since, from its first frame', async () => {
    const held = new Map();
    const {closed} = await dialIn('member-token', {held});
    const gone = new AbortController();
    const before = (await runners.aiFor('u1')).stream({input: 'slow', run: {id: 'run-1'}, signal: gone.signal});
    await until(() => held.get('run-1')?.frames.length === 2);
    // The server restarts: its runners go, and new ones take the next connection.
    runners.close();
    await closed;
    const heard = [];
    runners = createRunners({resolveIdentity: async () => ({ok: true, identity: {userId: 'u1'}})});
    runners.onRuns((userId, ids) => heard.push([userId, ids]));
    await dialIn('member-token', {held});
    assert.deepEqual(heard, [['u1', ['run-1']]]);
    const deltas = [];
    const resumed = (await runners.aiFor('u1')).stream({run: {id: 'run-1', resume: true}, onDelta: text => deltas.push(text)});
    nano.finishers[0]();
    assert.equal((await resumed).text, 'hello world');
    assert.deepEqual(deltas, ['hello ', 'world']);
    assert.equal(nano.seen.length, 1);
    // The old process's call, which a real restart takes with it.
    gone.abort();
    await before;
  });

  it('finishes a plugin run in the Mochi started since, keeping its turn, from the computer that held it', async () => {
    const held = new Map();
    const sessions = fakeSessions();
    const agentSync = {prepare: async () => ({workspace: 'folder-1', sent: {}}), finish: async () => {}};
    const aiMeter = {record: async () => {}};
    const appRunsOn = on => {
      const runs = createAppRuns({sessions, agentSync, runners: on, aiMeter});
      on.onRuns((userId, ids) => runs.adopt(userId, ids));
      return runs;
    };
    const {closed} = await dialIn('member-token', {held});
    const first = appRunsOn(runners);
    await first.start({userId: 'u1', workspaceId: 'lab'}, {pluginId: 'echo', sessionId: SESSION, prompt: 'slow', request: {input: 'slow', install: 'a'.repeat(64)}, ai: await runners.aiFor('u1')});
    await until(() => [...held.values()][0]?.frames.length === 2);
    runners.close();
    await closed;
    runners = createRunners({resolveIdentity: async () => ({ok: true, identity: {userId: 'u1'}})});
    appRunsOn(runners);
    await dialIn('member-token', {held});
    nano.finishers[0]();
    await until(() => sessions.turns.length);
    assert.deepEqual(sessions.turns.map(({prompt, answer, error}) => ({prompt, answer, error})), [{prompt: 'slow', answer: 'hello world', error: null}]);
    assert.equal(sessions.rows.size, 0);
    await until(() => held.size === 0);
    assert.equal(nano.seen.filter(call => call.method === 'POST').length, 1);
    // The old process's run, which a real restart takes with it.
    await first.cancel({userId: 'u1', workspaceId: 'lab'}, SESSION);
  });

  it('fails a held run at once when a new Mochi Lab without it says hello before the old one\'s socket closes', async () => {
    await dialIn('member-token', {held: new Map()});
    const deltas = [];
    const running = (await runners.aiFor('u1')).stream({input: 'slow', run: {id: 'run-1'}, onDelta: text => deltas.push(text)});
    await until(() => deltas.length);
    // Another Mochi Lab signs in: Mochi replaces the first, whose close it hears after the new hello.
    relays.push(connect({site, nanoagent: nanoUrl, token: 'member-token', device: 'desktop', held: new Map(), onEvent: () => {}}));
    assert.deepEqual(await running, {error: 'RUSH Lab stopped while answering', status: 503});
    nano.finishers[0]();
  });

  it('fails a held run when its computer comes back without it', async () => {
    const {closed} = await dialIn('member-token', {held: new Map()});
    const running = (await runners.aiFor('u1')).stream({input: 'slow', run: {id: 'run-1'}, onDelta: dropComputers});
    await closed;
    await dialIn('member-token', {held: new Map()});
    assert.deepEqual(await running, {error: 'RUSH Lab stopped while answering', status: 503});
    nano.finishers[0]();
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

describe('RUSH Lab cloud beside members\' own computers (server/runner.js, cloud-runs.js)', () => {
  let mochi; let site; let laptop; let laptopUrl; let cloudNano; let cloudUrl; let preferences; let runners; let relays; let sockets;

  /** The SQLite preferences the unit suites use, on a scratch database of their own. */
  function scratchPreferences() {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE user_preferences ("userId" TEXT PRIMARY KEY, "value" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)');
    return createPreferences({db});
  }

  /** Runners whose RUSH Lab cloud is Mochi's own NanoAgent at cloudUrl, offered when `env` says so. */
  function runnersWith(env) {
    const gateway = createNanoAgentGateway({env: {NANOAGENT_URL: cloudUrl, NANOAGENT_API_TOKEN: 'cloud-secret'}});
    return createRunners({
      resolveIdentity: async ({headers}) => (headers.authorization === 'Bearer member-token' && !headers.cookie
        ? {ok: true, identity: {userId: 'u1'}}
        : {ok: false, status: 401, error: 'Not signed in'}),
      cloud: createCloudRuns({env, gateway, preferences}),
    });
  }

  beforeEach(async () => {
    relays = [];
    sockets = [];
    preferences = scratchPreferences();
    laptop = fakeNanoAgent();
    laptopUrl = await listen(laptop.server);
    cloudNano = fakeNanoAgent();
    cloudUrl = await listen(cloudNano.server);
    runners = runnersWith({CLOUD_RUNS: 'on'});
    mochi = http.createServer((req, res) => res.writeHead(404).end());
    mochi.on('upgrade', (req, socket, head) => {
      sockets.push(socket);
      runners.upgrade(req, socket, head);
    });
    site = await listen(mochi);
  });

  afterEach(async () => {
    sockets.forEach(socket => socket.destroy());
    for (const server of [mochi, laptop.server, cloudNano.server]) server.closeAllConnections();
    await Promise.all([mochi, laptop.server, cloudNano.server].map(server => new Promise(resolve => server.close(resolve))));
    await Promise.all(relays);
  });

  async function dialIn() {
    let opened = false;
    relays.push(connect({site, nanoagent: laptopUrl, nanoagentToken: 'laptop-secret', token: 'member-token', device: 'laptop', onEvent: () => { opened = true; }}));
    await until(() => opened && runners.status('u1').device === 'laptop');
  }

  it('sends a cloud member\'s plugin run to RUSH Lab cloud, with Mochi\'s token, and streams it back', async () => {
    preferences.merge('u1', {runner: 'cloud'});
    const ai = await runners.appsFor('u1');
    assert.equal(ai.local, false);
    const deltas = [];
    const result = await ai.stream({input: 'hi', onDelta: text => deltas.push(text)});
    assert.equal(result.text, 'hello world');
    assert.deepEqual(deltas, ['hello ', 'world']);
    assert.deepEqual(cloudNano.seen.map(call => [call.method, call.url, call.authorization]), [['POST', '/v1/runs', 'Bearer cloud-secret']]);
    assert.deepEqual(laptop.seen, []);
  });

  it('keeps a cloud member\'s plugin runs in RUSH Lab cloud while their computer is connected too', async () => {
    preferences.merge('u1', {runner: 'cloud'});
    await dialIn();
    assert.equal(runners.status('u1').connected, true);
    const result = await (await runners.appsFor('u1')).stream({input: 'hi'});
    assert.equal(result.text, 'hello world');
    assert.equal(cloudNano.seen.length, 1);
    assert.deepEqual(laptop.seen, []);
  });

  it('keeps a cloud member\'s other AI calls on their own computer: RUSH Lab cloud runs only plugins', async () => {
    preferences.merge('u1', {runner: 'cloud'});
    assert.deepEqual(await (await runners.aiFor('u1')).stream({input: 'inline'}), {error: RUNNER_OFFLINE, status: 503});
    await dialIn();
    const ai = await runners.aiFor('u1');
    assert.equal(ai.local, true);
    assert.equal((await ai.stream({input: 'inline'})).text, 'hello world');
    assert.equal(laptop.seen.length, 1);
    assert.deepEqual(cloudNano.seen, []);
  });

  it('runs the plugins of a member who has not chosen on their computer, refused while it is not connected', async () => {
    const ai = await runners.appsFor('u1');
    assert.equal(ai.local, true);
    assert.deepEqual(await ai.stream({input: 'hi'}), {error: RUNNER_OFFLINE, status: 503});
    assert.deepEqual(await ai.installPackage('a'.repeat(64), Buffer.from('x')), {error: RUNNER_OFFLINE, status: 503});
    assert.equal(await runners.hostFor('u1'), null);
    assert.deepEqual(cloudNano.seen, []);
    assert.deepEqual(laptop.seen, []);
  });

  it('refuses the run of a member who chose their computer while it is not connected, rather than send it to RUSH Lab cloud', async () => {
    preferences.merge('u1', {runner: 'computer'});
    assert.deepEqual(await (await runners.appsFor('u1')).stream({input: 'hi'}), {error: RUNNER_OFFLINE, status: 503});
    assert.equal(await runners.hostFor('u1'), null);
    assert.deepEqual(cloudNano.seen, []);
  });

  it('runs on the member\'s computer once they choose it and it is connected', async () => {
    preferences.merge('u1', {runner: 'computer'});
    await dialIn();
    const ai = await runners.appsFor('u1');
    assert.equal(ai.local, true);
    assert.equal((await ai.stream({input: 'hi'})).text, 'hello world');
    assert.deepEqual(laptop.seen.map(call => [call.method, call.url, call.authorization]), [['POST', '/v1/runs', 'Bearer laptop-secret']]);
    assert.deepEqual(cloudNano.seen, []);
  });

  it('sends each plugin run where the member chose when it starts', async () => {
    await dialIn();
    preferences.merge('u1', {runner: 'computer'});
    await (await runners.appsFor('u1')).stream({input: 'first'});
    preferences.merge('u1', {runner: 'cloud'});
    await (await runners.appsFor('u1')).stream({input: 'second'});
    preferences.merge('u1', {runner: 'computer'});
    await (await runners.appsFor('u1')).stream({input: 'third'});
    const inputs = calls => calls.map(call => JSON.parse(call.body).input);
    assert.deepEqual(inputs(laptop.seen), ['first', 'third']);
    assert.deepEqual(inputs(cloudNano.seen), ['second']);
  });

  it('installs a cloud member\'s plugins on RUSH Lab cloud and serves their pages under its one page id', async () => {
    preferences.merge('u1', {runner: 'cloud'});
    const host = await runners.hostFor('u1');
    assert.equal(host.page, CLOUD_PAGE);
    assert.match(CLOUD_PAGE, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const data = Buffer.from(Array.from({length: 70_000}, (_, i) => i % 256));
    const put = await host.gateway.installPackage('a'.repeat(64), data);
    assert.equal(put.value.plugin.bytes, data.length);
    const file = await runners.byPage(CLOUD_PAGE).installUiFile('a'.repeat(64), '0123456789abcdef', 'index.html');
    assert.equal(file.value.toString(), '<!doctype html>');
    assert.equal(file.headers.get('content-security-policy'), "default-src 'none'");
    assert.deepEqual(cloudNano.seen.map(call => [call.method, call.url, call.authorization]), [
      ['PUT', `/v1/installs/${'a'.repeat(64)}`, 'Bearer cloud-secret'],
      ['GET', `/v1/installs/${'a'.repeat(64)}/ui/0123456789abcdef/index.html`, 'Bearer cloud-secret'],
    ]);
    assert.deepEqual(cloudNano.seen[0].body, data);
    assert.deepEqual(laptop.seen, []);
  });

  it('gives a computer member their connection\'s page, never RUSH Lab cloud\'s', async () => {
    await dialIn();
    const host = await runners.hostFor('u1');
    assert.notEqual(host.page, CLOUD_PAGE);
    assert.equal(host.gateway, runners.computer('u1'));
    assert.equal(runners.byPage(host.page), host.gateway);
  });

  it('offers nothing of RUSH Lab cloud where it is not offered: computers only, and no cloud page', async () => {
    runners = runnersWith({});
    preferences.merge('u1', {runner: 'cloud'});
    assert.equal(runners.byPage(CLOUD_PAGE), null);
    assert.equal(await runners.hostFor('u1'), null);
    assert.deepEqual(await (await runners.appsFor('u1')).stream({input: 'hi'}), {error: RUNNER_OFFLINE, status: 503});
    assert.deepEqual(cloudNano.seen, []);
  });

  it('keeps the computer\'s own status: RUSH Lab cloud is not a connected computer', async () => {
    preferences.merge('u1', {runner: 'cloud'});
    assert.deepEqual(runners.status('u1'), {connected: false, device: null, since: null, keys: []});
    await dialIn();
    assert.equal(runners.status('u1').connected, true);
    assert.equal(runners.status('u1').device, 'laptop');
  });

  it('sends nobody signed in nowhere', async () => {
    assert.equal(await runners.hostFor(null), null);
    assert.deepEqual(await (await runners.appsFor(null)).stream({input: 'hi'}), {error: RUNNER_OFFLINE, status: 503});
    assert.deepEqual(cloudNano.seen, []);
  });
});
