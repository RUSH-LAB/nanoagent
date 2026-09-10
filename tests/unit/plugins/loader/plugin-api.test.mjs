/**
 * src/server/plugin-api.js: what a plugin is handed, and what it is not.
 *
 * The point of the file is the boundary, so that is what this pins: a
 * capability the manifest did not ask for is absent, a path outside the
 * directory a capability covers is refused, and keys a plugin shares with the
 * server are namespaced so two plugins cannot collide over one.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {mockFs, PROJECT_ROOT} from '../../_harness.mjs';

const require = createRequire(import.meta.url);
const {API_VERSION, CAPABILITIES, buildPluginApi, processCapability, within} =
  require('../../../../src/server/plugin-api.js');

const at = rel => path.join(PROJECT_ROOT, rel);

/**
 * Content is one tree per organization, so "the directory a content capability
 * covers" is the caller's own workspace rather than the whole content tree. Two
 * workspaces here: the one REQ belongs to, and a neighbour, so a test can ask
 * what happens when a plugin reaches for the other.
 */
const ORG_ROOT = orgId => path.join(PROJECT_ROOT, 'content', orgId === 'o2' ? 'acme' : 'mochi');
const CONTENT_DIR = ORG_ROOT('o1');
const inContent = rel => path.join(CONTENT_DIR, rel);

/**
 * A stand-in for the server's ctx: the handful of fields the API reads, each
 * recording what the plugin did with it.
 */
function serverCtx(files = {}) {
  const calls = {json: [], cached: [], invalidateCache: [], rateLimit: []};
  const fs = mockFs(files);
  const domains = new Map();
  const collection = domain => {
    if (!domains.has(domain)) domains.set(domain, new Map());
    const values = domains.get(domain);
    return {
      list: () => [...values].map(([key, value]) => ({key, value})),
      values: () => [...values.values()],
      entries: () => Object.fromEntries(values),
      get: (_scope, key) => values.get(key),
      has: (_scope, key) => values.has(key),
      put: (_scope, key, value) => { values.set(key, structuredClone(value)); return value; },
      update: (_scope, key, transform) => {
        const next = transform(values.get(key));
        if (next === undefined) values.delete(key); else values.set(key, structuredClone(next));
        return next;
      },
      remove: (_scope, key) => values.delete(key),
      clear: () => { const count = values.size; values.clear(); return count; },
      count: () => values.size,
      replaceAll: (_scope, object) => { values.clear(); for (const [key, value] of Object.entries(object || {})) values.set(key, structuredClone(value)); },
    };
  };
  return {
    calls,
    fs,
    ctx: {
      fs,
      PROJECT_ROOT,
      // The server resolves the caller's workspace from the verified session
      // and hands it over the same way; a plugin never sees the organization
      // id, only the root it produced.
      contentRootFor: ORG_ROOT,
      CORS_ORIGIN: 'https://example.test',
      MAX_TEXT_LENGTH: 100,
      sanitizeText: s => String(s).trim(),
      json: (res, status, payload) => { calls.json.push({status, payload}); res.writableEnded = true; },
      readBody: async req => req.body,
      readRawBody: async req => Buffer.from(req.body || ''),
      documents: {
        snapshot: async scope => {
          const root = ORG_ROOT(scope.workspaceId);
          return [...fs._files.entries()]
            .filter(([file]) => file.startsWith(`${root}${path.sep}`))
            .map(([file, markdown]) => ({
              path: path.relative(root, file).split(path.sep).join('/'),
              markdown,
              updatedAt: '2026-08-31T00:00:00.000Z',
            }));
        },
      },
      collection,
      scopeFor: req => req?.context ?? null,
      cached: (key, ttl, compute) => { calls.cached.push({key, ttl}); return compute(); },
      invalidateCache: key => calls.invalidateCache.push(key),
      rateLimit: (key, perMinute) => { calls.rateLimit.push({key, perMinute}); return true; },
      pluginProvides: {references: {load: () => ({})}},
      ai: {complete: async request => ({text: request.prompt}), describe: () => ({available: true})},
    },
  };
}

const REQ = {
  socket: {remoteAddress: '127.0.0.1'},
  auth: {userId: 'u1', orgId: 'o1', orgRole: 'admin'},
  context: {userId: 'u1', workspaceId: 'o1', membershipId: 'm1', role: 'editor'},
};

function apiFor(requires, files = {}, name = 'demo') {
  const {ctx, calls, fs} = serverCtx(files);
  return {api: buildPluginApi({name, requires, ctx, req: REQ}), calls, fs};
}

describe('the always-there surface', () => {
  it('answers a request without any capability being asked for', () => {
    const {api, calls} = apiFor([]);
    const res = {writableEnded: false};
    api.respond(res, 200, {ok: true});
    assert.deepEqual(calls.json, [{status: 200, payload: {ok: true}}]);
    assert.equal(res.writableEnded, true);
  });

  it('reports the version it implements, which is what a manifest declares', () => {
    assert.equal(apiFor([]).api.apiVersion, API_VERSION);
  });

  it('streams with the server CORS header merged over the plugin headers', () => {
    const {api} = apiFor([]);
    let head = null;
    let body = null;
    api.stream({writeHead: (s, h) => { head = {status: s, headers: h}; }, end: b => { body = b; }},
      {status: 201, headers: {'Content-Type': 'text/plain'}, body: 'hi'});
    assert.deepEqual(head, {
      status: 201,
      headers: {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': 'https://example.test',
        'Access-Control-Allow-Credentials': 'true',
        'Vary': 'Origin',
      },
    });
    assert.equal(body, 'hi');
  });

  it('reflects the request origin for credentialed binary responses', () => {
    const {ctx} = serverCtx();
    ctx.CORS_ORIGIN = '*';
    const api = buildPluginApi({
      name: 'demo', requires: [], ctx,
      req: {...REQ, headers: {origin: 'http://localhost:3000'}},
    });
    let headers;
    api.stream({writeHead: (_status, value) => { headers = value; }, end() {}}, {body: 'pdf'});
    assert.equal(headers['Access-Control-Allow-Origin'], 'http://localhost:3000');
    assert.equal(headers['Access-Control-Allow-Credentials'], 'true');
  });

  it('reports the caller from the verified session, never from the request body', () => {
    const {api} = apiFor([]);
    assert.deepEqual({...api.caller}, {userId: 'u1', workspaceId: 'o1', role: 'editor'});
    assert.throws(() => { api.caller.userId = 'someone-else'; }, TypeError);
  });

  it('reports a null caller for an unauthenticated request rather than throwing', () => {
    const {ctx} = serverCtx();
    const api = buildPluginApi({name: 'demo', requires: [], ctx, req: {socket: {}}});
    assert.deepEqual({...api.caller}, {userId: null, workspaceId: null, role: null});
  });

  it('never turns a session active organization into plugin authority', () => {
    const {ctx} = serverCtx();
    const api = buildPluginApi({
      name: 'demo', requires: [], ctx,
      req: {socket: {}, auth: {userId: 'u1', orgId: 'stale-workspace', orgRole: 'owner'}},
    });
    assert.deepEqual({...api.caller}, {userId: null, workspaceId: null, role: null});
  });

  it('sees what other plugins publish, and nothing else of the server', () => {
    const {api} = apiFor([]);
    assert.equal(typeof api.shared.references.load, 'function');
    for (const leaked of ['fs', 'path', 'execFileSync', 'PROJECT_ROOT', 'loadJSON', 'saveJSON']) {
      assert.equal(api[leaked], undefined, `${leaked} must not be reachable from a plugin`);
    }
  });

  it('namespaces a rate-limit key, so two plugins cannot share one bucket', () => {
    const {api, calls} = apiFor([]);
    api.rateLimit('search:127.0.0.1', 10);
    assert.deepEqual(calls.rateLimit, [{key: 'demo:search:127.0.0.1', perMinute: 10}]);
  });
});

describe('capability gating', () => {
  it('omits every capability for a plugin that asks for none', () => {
    const {api} = apiFor([]);
    for (const absent of ['ai', 'blobs', 'cache', 'invalidateCache', 'content', 'exec', 'fetch', 'readBytes', 'records', 'storage']) {
      assert.equal(api[absent], undefined, `${absent} was granted without being asked for`);
    }
  });

  it('grants exactly what was asked for and nothing adjacent', () => {
    const {api} = apiFor(['cache']);
    assert.equal(typeof api.cache, 'function');
    assert.equal(typeof api.invalidateCache, 'function');
    assert.equal(api.content, undefined);
    assert.equal(api.fetch, undefined);
    assert.equal(api.storage, undefined);
  });

  it('grants a read-only content capability that cannot write', () => {
    const {api} = apiFor(['content:read']);
    assert.equal(typeof api.content.read, 'function');
    assert.equal(api.content.write, undefined);
  });

  it('does not implement the retired content:write capability', () => {
    const original = console.error;
    console.error = () => {};
    try {
      const {api} = apiFor(['content:write']);
      assert.equal(api.content, undefined);
    } finally {
      console.error = original;
    }
  });

  it('names an unknown capability on the console rather than granting it', () => {
    const said = [];
    const original = console.error;
    console.error = (...parts) => said.push(parts.join(' '));
    try {
      const {api} = apiFor(['database']);
      assert.equal(api.database, undefined);
    } finally {
      console.error = original;
    }
    assert.equal(said.length, 1);
    assert.match(said[0], /demo asks for unknown capabilities: database/);
  });

  it('lists every capability the surface implements', () => {
    assert.deepEqual([...CAPABILITIES],
      ['ai', 'blobs', 'cache', 'content:read', 'network', 'process', 'records', 'storage']);
    assert.throws(() => { CAPABILITIES.push('root'); }, TypeError);
  });

  it('namespaces cache keys under the plugin name', () => {
    const {api, calls} = apiFor(['cache']);
    assert.equal(api.cache('graph', 60000, () => 'computed'), 'computed');
    api.invalidateCache('graph');
    assert.deepEqual(calls.cached, [{key: 'demo:o1:graph', ttl: 60000}]);
    assert.deepEqual(calls.invalidateCache, ['demo:o1:graph']);
  });

  it('grants the AI provider without exposing the server AI object', async () => {
    const {api} = apiFor(['ai']);
    assert.deepEqual(await api.ai.complete({prompt: 'hello'}), {text: 'hello'});
    assert.deepEqual(api.ai.describe(), {available: true});
  });
});

describe('the process capability', () => {
  function fakeSpawn(record, result = {code: 0, stdout: 'ok', stderr: ''}) {
    return (command, args, options) => {
      record.push({command, args, options, input: ''});
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {end: input => { record[0].input = input; }};
      child.kill = () => {};
      queueMicrotask(() => {
        if (result.stdout) child.stdout.emit('data', result.stdout);
        if (result.stderr) child.stderr.emit('data', result.stderr);
        child.emit('close', result.code);
      });
      return child;
    };
  }

  it('runs only a declared command inside the plugin directory', async () => {
    const calls = [];
    const pluginDir = path.join(PROJECT_ROOT, 'plugins', 'lean-proofs');
    const exec = processCapability(pluginDir, ['lake'], fakeSpawn(calls));
    const result = await exec('lake', ['env', 'lean', '--stdin'], {cwd: 'proofs', input: '#check Nat'});
    assert.equal(result.ok, true);
    assert.equal(calls[0].options.cwd, path.join(pluginDir, 'proofs'));
    assert.equal(calls[0].input, '#check Nat');
    await assert.rejects(() => exec('sh', ['-c', 'anything']), /not declared/);
  });

  it('refuses a working directory outside the plugin', async () => {
    const exec = processCapability(path.join(PROJECT_ROOT, 'plugins', 'demo'), ['lake'], fakeSpawn([]));
    await assert.rejects(() => exec('lake', [], {cwd: '../../'}), /outside/);
  });
});

describe('the content capability', () => {
  const FILES = {
    [inContent('notes/one.md')]: 'first',
    [inContent('notes/_draft.md')]: 'skipped',
    [inContent('notes/deep/two.mdx')]: 'second',
    [inContent('notes/three.txt')]: 'not markdown',
    [path.join(ORG_ROOT('o2'), 'notes/other.md')]: 'another workspace',
    [at('secrets.env')]: 'TOKEN=hunter2',
  };

  it('reads a database document inside the caller\'s workspace', async () => {
    const {api} = apiFor(['content:read'], FILES);
    assert.equal(await api.content.read('notes/one.md'), 'first');
  });

  it('answers a missing document with null rather than an exception', async () => {
    const {api} = apiFor(['content:read'], FILES);
    assert.equal(await api.content.read('notes/absent.md'), null);
    assert.equal(await api.content.exists('notes/absent.md'), false);
    assert.equal(await api.content.stat('notes/absent.md'), null);
  });

  it('reports size and mtime from document metadata', async () => {
    const {api} = apiFor(['content:read'], FILES);
    const stat = await api.content.stat('notes/one.md');
    assert.equal(stat.size, 5);
    assert.equal(typeof stat.mtimeMs, 'number');
  });

  // Each of these resolves outside the workspace; the first two name the repo
  // root's own secrets.env, which is two levels above an organization's tree.
  const ESCAPES = [
    '../../secrets.env',
    'notes/../../../secrets.env',
    'notes/../../../../etc/passwd',
    '/etc/passwd',
  ];
  for (const escape of ESCAPES) {
    it(`refuses to read ${escape}`, async () => {
      const {api} = apiFor(['content:read'], FILES);
      await assert.rejects(() => api.content.read(escape), /outside the directory this plugin may use/);
    });
  }

  it('binds the repository query to the caller\'s verified workspace', async () => {
    // One ctx, two callers. The same relative path means a different file for
    // each, and neither of them can spell the other's.
    const {ctx} = serverCtx(FILES);
    const mine = buildPluginApi({name: 'demo', requires: ['content:read'], ctx, req: REQ});
    const theirs = buildPluginApi({
      name: 'demo', requires: ['content:read'], ctx,
      req: {
        ...REQ,
        auth: {...REQ.auth, orgId: 'o2'},
        context: {...REQ.context, workspaceId: 'o2', membershipId: 'm2'},
      },
    });
    assert.equal(await mine.content.read('notes/one.md'), 'first');
    assert.equal(await theirs.content.read('notes/one.md'), null);
    assert.equal(await theirs.content.read('notes/other.md'), 'another workspace');
    assert.equal(await mine.content.read('notes/other.md'), null);
  });

  it('cannot reach the neighbouring workspace, even named exactly', async () => {
    // The other tree is one level up and its name is no secret. What refuses
    // the reach is that a relative path cannot leave the root at all, which is
    // the same guard that refuses the escapes above.
    const {api, fs} = apiFor(['content:read'], FILES);
    const theirFile = '../acme/notes/other.md';
    await assert.rejects(() => api.content.read(theirFile), /outside the directory this plugin may use/);
    assert.equal(api.content.write, undefined);
    assert.equal(fs._files.get(path.join(ORG_ROOT('o2'), 'notes/other.md')), 'another workspace');
  });

  it('does not need a legacy content root', async () => {
    const {ctx} = serverCtx(FILES);
    delete ctx.contentRootFor;
    const api = buildPluginApi({name: 'demo', requires: ['content:read'], ctx, req: REQ});
    assert.equal(await api.content.read('notes/one.md'), 'first');
  });

  it('walks the caller\'s workspace recursively, skipping drafts and filtering by extension', async () => {
    const {api} = apiFor(['content:read'], FILES);
    assert.deepEqual((await api.content.walk('.', {extensions: ['.md', '.mdx']})).sort(),
      ['notes/deep/two.mdx', 'notes/one.md']);
  });

  it('walks everything when no extensions are named', async () => {
    const {api} = apiFor(['content:read'], FILES);
    assert.deepEqual((await api.content.walk('notes')).sort(),
      ['notes/deep/two.mdx', 'notes/one.md', 'notes/three.txt']);
  });

  it('never exposes a content writer', () => {
    const {api, fs} = apiFor(['content:read'], FILES);
    assert.equal(api.content.write, undefined);
    assert.equal(fs._files.get(inContent('notes/one.md')), 'first');
  });

  it('is frozen, so a plugin cannot widen its own capability', () => {
    const {api} = apiFor(['content:read'], FILES);
    assert.throws(() => { api.content.write = () => {}; }, TypeError);
  });
});

describe('the storage capability', () => {
  it('gives each plugin and workspace its own corner of var/', () => {
    const {api: mine} = apiFor(['storage'], {}, 'mine');
    const {api: yours} = apiFor(['storage'], {}, 'yours');
    assert.equal(mine.storage.dir, at('var/plugins/mine/workspaces/o1'));
    assert.equal(yours.storage.dir, at('var/plugins/yours/workspaces/o1'));
  });

  it('separates one plugin storage across workspaces', () => {
    const {ctx} = serverCtx();
    const mine = buildPluginApi({name: 'demo', requires: ['storage'], ctx, req: REQ});
    const theirs = buildPluginApi({
      name: 'demo', requires: ['storage'], ctx,
      req: {...REQ, context: {...REQ.context, workspaceId: 'o2', membershipId: 'm2'}},
    });
    assert.notEqual(mine.storage.dir, theirs.storage.dir);
    assert.equal(theirs.storage.dir, at('var/plugins/demo/workspaces/o2'));
  });

  it('round-trips a value, and answers an unwritten key with the fallback', () => {
    const {api} = apiFor(['storage']);
    assert.equal(api.storage.read('state', 'nothing yet'), 'nothing yet');
    api.storage.write('state', {seen: 3});
    assert.deepEqual(api.storage.read('state'), {seen: 3});
  });

  it('writes through a temporary file, so a crash cannot truncate the real one', () => {
    const {api, fs} = apiFor(['storage']);
    api.storage.write('state', {seen: 1});
    assert.equal(fs._files.has(at('var/plugins/demo/workspaces/o1/state.json.tmp')), false);
    assert.ok(fs._files.has(at('var/plugins/demo/workspaces/o1/state.json')));
  });

  it('flattens a key that would otherwise escape the plugin directory', () => {
    const {api, fs} = apiFor(['storage']);
    api.storage.write('../../../etc/passwd', {owned: true});
    // Every character a path separator could hide behind is replaced, so the
    // key lands as one flat filename inside the plugin's own directory.
    assert.deepEqual([...fs._files.keys()].filter(k => k.includes('passwd')),
      [at('var/plugins/demo/workspaces/o1/.._.._.._etc_passwd.json')]);
  });

  it('answers a corrupt file with the fallback rather than throwing', () => {
    const {api, fs} = apiFor(['storage']);
    fs._files.set(at('var/plugins/demo/workspaces/o1/state.json'), 'not json at all');
    assert.equal(api.storage.read('state', 'fallback'), 'fallback');
  });
});

describe('the records capability', () => {
  it('binds plugin collections to the verified workspace scope', () => {
    const {api} = apiFor(['records']);
    const papers = api.records.collection('papers');
    papers.put('paper-1', {title: 'One'});
    assert.deepEqual(papers.get('paper-1'), {title: 'One'});
    assert.deepEqual(papers.entries(), {'paper-1': {title: 'One'}});
  });

  it('refuses collection names that could escape their namespace', () => {
    const {api} = apiFor(['records']);
    assert.throws(() => api.records.collection('../other'), /invalid record collection/);
  });
});

describe('the blobs capability', () => {
  it('returns an opaque asset id while storing content-addressed bytes below the workspace prefix', async () => {
    const {api, fs} = apiFor(['blobs']);
    const bytes = Buffer.from('%PDF-test');
    const stored = await api.blobs.put(bytes, '.pdf');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.match(stored.key, /^[a-f0-9-]{36}$/);
    assert.equal(stored.sha256, digest);
    assert.deepEqual([...fs._files.keys()].filter(file => file.endsWith(`${digest}.pdf`)), [
      path.join(PROJECT_ROOT, 'var', 'objects', 'o1', 'assets', stored.key, `${digest}.pdf`),
    ]);
    assert.equal((await api.blobs.read(stored.key)).toString(), '%PDF-test');
    assert.equal(api.blobs.provider, 'local');
  });

  it('exposes the raw request body only with blob access', async () => {
    const {ctx} = serverCtx();
    const req = {...REQ, body: '%PDF-body'};
    const api = buildPluginApi({name: 'demo', requires: ['blobs'], ctx, req});
    assert.equal((await api.readBytes()).toString(), '%PDF-body');
  });
});

describe('the network capability', () => {
  it('refuses a protocol that is not http or https', async () => {
    const {api} = apiFor(['network']);
    await assert.rejects(() => api.fetch('file:///etc/passwd'), /unsupported protocol/);
  });

  const LOOPBACK = [
    'http://localhost:3001/api/users',
    'http://127.0.0.1:3001/api/users',
    'http://127.0.0.2:3001/api/users',
    // URL reports an IPv6 host with its brackets still attached.
    'http://[::1]:3001/api/users',
  ];
  for (const target of LOOPBACK) {
    it(`refuses to call back into this server at ${target}`, async () => {
      const {api} = apiFor(['network']);
      await assert.rejects(() => api.fetch(target), /may not call back into this server/);
    });
  }

  it('passes an outbound request through with an abort signal attached', async () => {
    const {api} = apiFor(['network']);
    const original = globalThis.fetch;
    let seen = null;
    globalThis.fetch = async (target, init) => { seen = {target: String(target), init}; return {ok: true}; };
    try {
      const reply = await api.fetch('https://api.example.test/x', {headers: {'User-Agent': 'MochiLab/1.0'}});
      assert.deepEqual(reply, {ok: true});
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(seen.target, 'https://api.example.test/x');
    assert.deepEqual(seen.init.headers, {'User-Agent': 'MochiLab/1.0'});
    assert.ok(seen.init.signal instanceof AbortSignal);
  });

  it('aborts a request that outlasts the timeout the caller set', async () => {
    const {api} = apiFor(['network']);
    const original = globalThis.fetch;
    globalThis.fetch = (target, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
    });
    try {
      await assert.rejects(() => api.fetch('https://slow.example.test/x', {timeoutMs: 5}), /aborted/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('within', () => {
  const root = '/srv/content';

  it('resolves a path inside the root', () => {
    assert.equal(within(root, 'notes/a.md', 'path'), '/srv/content/notes/a.md');
  });

  it('treats the root itself as inside it', () => {
    assert.equal(within(root, '.', 'path'), root);
  });

  it('refuses a sibling directory whose name merely starts the same way', () => {
    assert.throws(() => within(root, '../content-secrets/x', 'path'), /outside the directory/);
  });

  it('names what was refused, so the error says which argument was wrong', () => {
    assert.throws(() => within(root, '../x', 'key'), /^Error: key is outside the directory/);
  });

  it('treats a null or undefined relative path as the root', () => {
    assert.equal(within(root, null, 'path'), root);
    assert.equal(within(root, undefined, 'path'), root);
  });
});
