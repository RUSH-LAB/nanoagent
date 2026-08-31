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
import path from 'node:path';
import {createRequire} from 'node:module';
import {mockFs, PROJECT_ROOT} from '../../_harness.mjs';

const require = createRequire(import.meta.url);
const {API_VERSION, CAPABILITIES, buildPluginApi, within} =
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
      cached: (key, ttl, compute) => { calls.cached.push({key, ttl}); return compute(); },
      invalidateCache: key => calls.invalidateCache.push(key),
      rateLimit: (key, perMinute) => { calls.rateLimit.push({key, perMinute}); return true; },
      pluginProvides: {references: {load: () => ({})}},
    },
  };
}

const REQ = {socket: {remoteAddress: '127.0.0.1'}, auth: {userId: 'u1', orgId: 'o1', orgRole: 'admin'}};

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
      headers: {'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': 'https://example.test'},
    });
    assert.equal(body, 'hi');
  });

  it('reports the caller from the verified session, never from the request body', () => {
    const {api} = apiFor([]);
    assert.deepEqual({...api.caller}, {userId: 'u1', orgId: 'o1', orgRole: 'admin'});
    assert.throws(() => { api.caller.userId = 'someone-else'; }, TypeError);
  });

  it('reports a null caller for an unauthenticated request rather than throwing', () => {
    const {ctx} = serverCtx();
    const api = buildPluginApi({name: 'demo', requires: [], ctx, req: {socket: {}}});
    assert.deepEqual({...api.caller}, {userId: null, orgId: null, orgRole: null});
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
    for (const absent of ['cache', 'invalidateCache', 'content', 'fetch', 'storage']) {
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

  it('treats content:write as including the read half', () => {
    const {api} = apiFor(['content:write']);
    assert.equal(typeof api.content.read, 'function');
    assert.equal(typeof api.content.write, 'function');
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
      ['cache', 'content:read', 'content:write', 'network', 'storage']);
    assert.throws(() => { CAPABILITIES.push('root'); }, TypeError);
  });

  it('namespaces cache keys under the plugin name', () => {
    const {api, calls} = apiFor(['cache']);
    assert.equal(api.cache('graph', 60000, () => 'computed'), 'computed');
    api.invalidateCache('graph');
    assert.deepEqual(calls.cached, [{key: 'demo:graph', ttl: 60000}]);
    assert.deepEqual(calls.invalidateCache, ['demo:graph']);
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

  it('reads a file inside the caller\'s workspace', () => {
    const {api} = apiFor(['content:read'], FILES);
    assert.equal(api.content.read('notes/one.md'), 'first');
  });

  it('answers a missing file with null rather than an exception', () => {
    const {api} = apiFor(['content:read'], FILES);
    assert.equal(api.content.read('notes/absent.md'), null);
    assert.equal(api.content.exists('notes/absent.md'), false);
    assert.equal(api.content.stat('notes/absent.md'), null);
  });

  it('reports size and mtime, which is what a memo needs', () => {
    const {api} = apiFor(['content:read'], FILES);
    const stat = api.content.stat('notes/one.md');
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
    it(`refuses to read ${escape}`, () => {
      const {api} = apiFor(['content:read'], FILES);
      assert.throws(() => api.content.read(escape), /outside the directory this plugin may use/);
    });
    it(`refuses to write ${escape}`, () => {
      const {api, fs} = apiFor(['content:write'], FILES);
      assert.throws(() => api.content.write(escape, 'owned'), /outside the directory this plugin may use/);
      assert.equal(fs._files.get(at('secrets.env')), 'TOKEN=hunter2');
    });
  }

  it('roots the capability at the caller\'s workspace, not at the content tree', () => {
    // One ctx, two callers. The same relative path means a different file for
    // each, and neither of them can spell the other's.
    const {ctx} = serverCtx(FILES);
    const mine = buildPluginApi({name: 'demo', requires: ['content:read'], ctx, req: REQ});
    const theirs = buildPluginApi({
      name: 'demo', requires: ['content:read'], ctx,
      req: {...REQ, auth: {...REQ.auth, orgId: 'o2'}},
    });
    assert.equal(mine.content.read('notes/one.md'), 'first');
    assert.equal(theirs.content.read('notes/one.md'), null);
    assert.equal(theirs.content.read('notes/other.md'), 'another workspace');
    assert.equal(mine.content.read('notes/other.md'), null);
  });

  it('cannot reach the neighbouring workspace, even named exactly', () => {
    // The other tree is one level up and its name is no secret. What refuses
    // the reach is that a relative path cannot leave the root at all, which is
    // the same guard that refuses the escapes above.
    const {api, fs} = apiFor(['content:write'], FILES);
    const theirFile = '../acme/notes/other.md';
    assert.throws(() => api.content.read(theirFile), /outside the directory this plugin may use/);
    assert.throws(() => api.content.write(theirFile, 'owned'), /outside the directory this plugin may use/);
    assert.equal(fs._files.get(path.join(ORG_ROOT('o2'), 'notes/other.md')), 'another workspace');
  });

  it('falls back to the primary workspace when the server names no root', () => {
    // A ctx with no contentRootFor is not something the server builds, but the
    // fallback is what keeps a plugin working under one, so it is pinned to the
    // primary organization rather than to the whole content tree.
    const {ctx} = serverCtx(FILES);
    delete ctx.contentRootFor;
    const api = buildPluginApi({name: 'demo', requires: ['content:read'], ctx, req: REQ});
    assert.equal(api.content.read('notes/one.md'), 'first');
  });

  it('walks the caller\'s workspace recursively, skipping drafts and filtering by extension', () => {
    const {api} = apiFor(['content:read'], FILES);
    // Underscore-prefixed drafts and the .txt are both gone; order is whatever
    // the filesystem lists, which is why the pair is compared sorted.
    assert.deepEqual(api.content.walk('.', {extensions: ['.md', '.mdx']}).sort(),
      ['notes/deep/two.mdx', 'notes/one.md']);
  });

  it('walks everything when no extensions are named', () => {
    const {api} = apiFor(['content:read'], FILES);
    assert.deepEqual(api.content.walk('notes').sort(),
      ['notes/deep/two.mdx', 'notes/one.md', 'notes/three.txt']);
  });

  it('writes inside content/, creating the directory it needs', () => {
    const {api, fs} = apiFor(['content:write'], FILES);
    api.content.write('fresh/dir/new.md', 'written');
    assert.equal(fs._files.get(inContent('fresh/dir/new.md')), 'written');
  });

  it('drops the caches the server derives from content, which the plugin never names', () => {
    const {api, calls} = apiFor(['content:write'], FILES);
    api.content.write('notes/one.md', 'edited');
    assert.deepEqual(calls.invalidateCache, ['stats', 'search']);
  });

  it('refuses a write larger than the cap, leaving the file alone', () => {
    const {api, fs} = apiFor(['content:write'], FILES);
    assert.throws(() => api.content.write('notes/one.md', 'x'.repeat(5 * 1024 * 1024 + 1)), /too large/);
    assert.equal(fs._files.get(inContent('notes/one.md')), 'first');
  });

  it('is frozen, so a plugin cannot widen its own capability', () => {
    const {api} = apiFor(['content:read'], FILES);
    assert.throws(() => { api.content.write = () => {}; }, TypeError);
  });
});

describe('the storage capability', () => {
  it('gives each plugin its own corner of var/', () => {
    const {api: mine} = apiFor(['storage'], {}, 'mine');
    const {api: yours} = apiFor(['storage'], {}, 'yours');
    assert.equal(mine.storage.dir, at('var/plugins/mine'));
    assert.equal(yours.storage.dir, at('var/plugins/yours'));
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
    assert.equal(fs._files.has(at('var/plugins/demo/state.json.tmp')), false);
    assert.ok(fs._files.has(at('var/plugins/demo/state.json')));
  });

  it('flattens a key that would otherwise escape the plugin directory', () => {
    const {api, fs} = apiFor(['storage']);
    api.storage.write('../../../etc/passwd', {owned: true});
    // Every character a path separator could hide behind is replaced, so the
    // key lands as one flat filename inside the plugin's own directory.
    assert.deepEqual([...fs._files.keys()].filter(k => k.includes('passwd')),
      [at('var/plugins/demo/.._.._.._etc_passwd.json')]);
  });

  it('answers a corrupt file with the fallback rather than throwing', () => {
    const {api, fs} = apiFor(['storage']);
    fs._files.set(at('var/plugins/demo/state.json'), 'not json at all');
    assert.equal(api.storage.read('state', 'fallback'), 'fallback');
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
