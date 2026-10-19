import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadRoute, makeCtx, invoke, fakeSessions, appRunsFor, SESSION} from '../../_harness.mjs';

const routes = loadRoute('apps');
const context = {workspaceId: 'test-org', userId: 'test-user', membershipId: 'member-1', role: 'owner'};
const SHA = 'a'.repeat(64);
// The connection of the member's computer that plugin pages are addressed by (server/runner.js).
const PAGE = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const APP = {id: 'echo', name: 'Echo', version: '1.0.0', tasks: [], tools: [], readme: '# Echo\n', sha256: SHA, source: 'nanoagent'};

/** The workspace file system, as one map of path to bytes, recording what it was asked. */
function fakeFs(files = {}) {
  const stored = new Map(Object.entries(files).map(([path, body]) => [path, Buffer.from(body)]));
  return {
    stored,
    writes: [],
    async list(_scope, {prefix}) {
      return [...stored].filter(([path]) => path.startsWith(`${prefix}/`)).map(([path, body]) => ({path, kind: 'file', size: body.length}));
    },
    async read(_scope, path) { return stored.has(path) ? {node: {path}, body: stored.get(path)} : null; },
    async write(_scope, path, body, options) {
      this.writes.push([path, body.toString(), options]);
      stored.set(path, body);
      return {path, size: body.length};
    },
    async transaction(_scope, operation) {
      return operation({nodeAt: async () => ({}), mkdir: async () => {}, setAccess: async () => {}});
    },
  };
}

/** The workspace's apps (workspace-apps.js), one added, `echo`, which opens installed as SHA. */
function fakeApps(overrides = {}) {
  const calls = [];
  return {
    calls,
    list: async () => ({value: [APP]}),
    add: async (context, id) => { calls.push(['add', id]); return {value: APP}; },
    tag: async (context, id, tags) => { calls.push(['tag', id, tags]); return id === 'echo'; },
    remove: async (context, id) => { calls.push(['remove', id]); return id === 'echo'; },
    refusal: async () => ({value: null}),
    open: async (context, id) => {
      calls.push(['open', id]);
      return {value: {...APP, id, uiVersion: '0123456789abcdef'}};
    },
    ...overrides,
  };
}

/** A ctx whose member's computer is connected, its NanoAgent `ai`. */
function ctxWith(ai, fs = fakeFs()) {
  const ctx = makeCtx();
  ctx.ai = {...ctx.ai, ...ai};
  ctx.runners = {
    ...ctx.runners,
    computer: userId => (userId === context.userId ? ctx.ai : null),
    page: userId => (userId === context.userId ? PAGE : null),
    byPage: page => (page === PAGE ? ctx.ai : null),
  };
  ctx.workspaceFs = fs;
  ctx.sessions = fakeSessions();
  ctx.appRuns = appRunsFor(ctx);
  ctx.workspaceApps = fakeApps();
  return ctx;
}

describe('NanoAgent apps', () => {
  it('lists the plugins the workspace added', async () => {
    const listed = await invoke(routes, {method: 'GET', path: '/api/apps', ctx: ctxWith({}), requestContext: context});
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.payload, {apps: [APP]});
  });

  it('relays an unreachable NanoAgent instead of an empty list', async () => {
    const ctx = ctxWith({});
    ctx.workspaceApps.list = async () => ({error: 'Could not reach NanoAgent.', status: 502});
    const listed = await invoke(routes, {method: 'GET', path: '/api/apps', ctx, requestContext: context});
    assert.equal(listed.status, 502);
    assert.equal(listed.payload.error, 'Could not reach NanoAgent.');
  });

  it('opens an added app installed on the member\'s computer, for any member', async () => {
    const ctx = ctxWith({});
    const on = [];
    const open = ctx.workspaceApps.open;
    ctx.workspaceApps.open = async (context, id, computer) => { on.push(computer); return open(context, id); };
    const opened = await invoke(routes, {method: 'GET', path: '/api/apps/echo', ctx, requestContext: {...context, role: 'viewer'}});
    assert.equal(opened.status, 200);
    assert.equal(opened.payload.app.sha256, SHA);
    assert.equal(opened.payload.app.computer, PAGE);
    assert.deepEqual(on, [ctx.ai]);
    assert.deepEqual(ctx.workspaceApps.calls, [['open', 'echo']]);
    ctx.workspaceApps.open = async () => ({error: 'This workspace has no plugin named nope', status: 404});
    assert.equal((await invoke(routes, {method: 'GET', path: '/api/apps/nope', ctx, requestContext: context})).status, 404);
    assert.equal((await invoke(routes, {method: 'GET', path: '/api/apps/Not%20an%20id', ctx, requestContext: context})).status, 404);
  });

  it('lets a member of any role install and uninstall a plugin', async () => {
    const ctx = ctxWith({});
    const added = await invoke(routes, {method: 'PUT', path: '/api/apps/echo', ctx, requestContext: context});
    assert.equal(added.status, 200);
    assert.deepEqual(added.payload, {app: APP});
    const removed = await invoke(routes, {method: 'DELETE', path: '/api/apps/echo', ctx, requestContext: context});
    assert.deepEqual(removed.payload, {removed: 'echo'});
    assert.equal((await invoke(routes, {method: 'DELETE', path: '/api/apps/other', ctx, requestContext: context})).status, 404);
    for (const method of ['PUT', 'DELETE']) {
      assert.equal((await invoke(routes, {method, path: '/api/apps/echo', ctx, requestContext: {...context, role: 'viewer'}})).status, 200);
    }
    assert.deepEqual(ctx.workspaceApps.calls, [['add', 'echo'], ['remove', 'echo'], ['remove', 'other'], ['add', 'echo'], ['remove', 'echo']]);
  });

  it('prepares the workspace\'s apps on the member\'s computer, answering at once', async () => {
    const ctx = ctxWith({});
    const prepared = [];
    ctx.workspaceApps.prepare = async (_context, on) => { prepared.push(on); return {value: []}; };
    const answer = await invoke(routes, {method: 'POST', path: '/api/app-installs', ctx, requestContext: {...context, role: 'viewer'}});
    assert.equal(answer.status, 202);
    assert.deepEqual(prepared, [ctx.ai]);
  });

  it('neither opens nor prepares an app while the member\'s computer is not connected', async () => {
    const ctx = ctxWith({});
    ctx.runners.computer = () => null;
    ctx.workspaceApps.prepare = async () => assert.fail('must not install anywhere');
    for (const [method, path] of [['GET', '/api/apps/echo'], ['POST', '/api/app-installs']]) {
      const result = await invoke(routes, {method, path, ctx, requestContext: context});
      assert.equal(result.status, 503, path);
      assert.match(result.payload.error, /RUSH Lab on your computer is not connected/);
    }
    assert.deepEqual(ctx.workspaceApps.calls, []);
  });

  it('lets a member tag their plugin, with a short list of short names', async () => {
    const ctx = ctxWith({});
    const tag = (body, role = 'owner', id = 'echo') => invoke(routes, {method: 'PATCH', path: `/api/apps/${id}`, body, ctx, requestContext: {...context, role}});
    const tagged = await tag({tags: [' Writing ', 'Daily', 'Writing']});
    assert.equal(tagged.status, 200);
    assert.deepEqual(tagged.payload, {tags: ['Writing', 'Daily']});
    assert.equal((await tag({tags: []})).status, 200);
    for (const body of [{}, {tags: 'Writing'}, {tags: ['']}, {tags: ['x'.repeat(41)]}, {tags: Array.from({length: 11}, (_, i) => `t${i}`)}]) {
      assert.equal((await tag(body)).status, 400);
    }
    assert.equal((await tag({tags: ['x']}, 'owner', 'other')).status, 404);
    assert.equal((await tag({tags: ['x']}, 'viewer')).status, 200);
    assert.deepEqual(ctx.workspaceApps.calls, [['tag', 'echo', ['Writing', 'Daily']], ['tag', 'echo', []], ['tag', 'other', ['x']], ['tag', 'echo', ['x']]]);
  });

  it('relays a plugin the marketplace does not have', async () => {
    const ctx = ctxWith({});
    ctx.workspaceApps.add = async () => ({error: 'No plugin named nope in the marketplace', status: 404});
    const added = await invoke(routes, {method: 'PUT', path: '/api/apps/nope', ctx, requestContext: context});
    assert.equal(added.status, 404);
  });

  it('lists only the caller\'s own folder for the plugin', async () => {
    const fs = fakeFs({'home/test-user/Plugins/echo/files/attention/ms.tex': '\\section{}', 'home/other/Plugins/echo/files/x.md': 'not yours'});
    const listed = await invoke(routes, {method: 'GET', path: '/api/agent-files', query: '?plugin=echo', ctx: ctxWith({}, fs), requestContext: context});
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.payload, {files: [{path: 'attention/ms.tex', size: 10}]});
  });

  it('refuses agent files without a plugin to name the folder', async () => {
    for (const query of ['', '?plugin=../x', '?plugin=Echo']) {
      const result = await invoke(routes, {method: 'GET', path: '/api/agent-files', query, ctx: ctxWith({}, fakeFs()), requestContext: context});
      assert.equal(result.status, 400);
    }
  });

  it('serves text as plain text and never as HTML', async () => {
    const fs = fakeFs({'home/test-user/Plugins/echo/files/attention/ms.tex': '\\section{Intro}', 'home/test-user/Plugins/echo/files/page.html': '<script>x</script>'});
    for (const path of ['attention/ms.tex', 'page.html']) {
      const served = await invoke(routes, {method: 'GET', path: '/api/agent-files/content', query: `?plugin=echo&path=${path}`, ctx: ctxWith({}, fs), requestContext: context});
      assert.equal(served.res.written.status, 200);
      assert.equal(served.res.written.headers['Content-Type'], 'text/plain; charset=utf-8');
      assert.equal(served.res.written.headers['X-Content-Type-Options'], 'nosniff');
    }
  });

  it('sends a viewable file as an attachment when asked to download it', async () => {
    const fs = fakeFs({'home/test-user/Plugins/echo/files/notes/a.txt': 'text'});
    const served = await invoke(routes, {
      method: 'GET', path: '/api/agent-files/content', query: '?plugin=echo&path=notes/a.txt&download=1', ctx: ctxWith({}, fs), requestContext: context,
    });
    assert.equal(served.res.written.headers['Content-Disposition'], 'attachment; filename="a.txt"');
  });

  it('reports a missing file', async () => {
    const result = await invoke(routes, {method: 'GET', path: '/api/agent-files/content', query: '?plugin=echo&path=nope.md', ctx: ctxWith({}), requestContext: context});
    assert.equal(result.status, 404);
  });

  it('saves a file to the caller\'s folder for the plugin, refusing to replace one when creating', async () => {
    const fs = fakeFs();
    const ctx = ctxWith({}, fs);
    ctx.readRawBody = async () => Buffer.from('hello');
    const created = await invoke(routes, {
      method: 'PUT', path: '/api/agent-files/content', query: '?plugin=echo&path=notes/a.md&create=1', ctx, requestContext: context,
    });
    assert.equal(created.status, 200);
    assert.deepEqual(created.payload, {path: 'notes/a.md', size: 5});
    await invoke(routes, {method: 'PUT', path: '/api/agent-files/content', query: '?plugin=echo&path=notes/a.md', ctx, requestContext: context});
    assert.deepEqual(fs.writes, [
      ['home/test-user/Plugins/echo/files/notes/a.md', 'hello', {baseRev: 0}],
      ['home/test-user/Plugins/echo/files/notes/a.md', 'hello', {}],
    ]);
  });

  it('lets a viewer change their own folder for the plugin', async () => {
    const result = await invoke(routes, {method: 'PUT', path: '/api/agent-files/content', query: '?plugin=echo&path=a.txt', ctx: ctxWith({}, fakeFs()), requestContext: {...context, role: 'viewer'}});
    assert.equal(result.status, 200);
  });

  it('refuses agent files without the workspace file system', async () => {
    const ctx = ctxWith({}, null);
    const result = await invoke(routes, {method: 'GET', path: '/api/agent-files', query: '?plugin=echo', ctx, requestContext: context});
    assert.equal(result.status, 409);
    assert.equal(result.payload.code, 'fs-disabled');
  });
});

/** Run `load` with the GitHub OAuth values server/auth.js requires at load. */
function withGithubEnv(load) {
  const env = {GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret'};
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return load();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('an app\'s own page', () => {
  const require = createRequire(import.meta.url);
  const {isPublicPath} = withGithubEnv(() => require('../../../../src/server/auth.js'));
  const {isGlobalApiPath} = require('../../../../src/server/workspace-context.js');
  const CSP = "default-src 'self'; connect-src 'none'";
  const CACHE = 'public, max-age=31536000, immutable';
  const page = (body, headers = {'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': CACHE}) =>
    ({value: Buffer.from(body), headers: new Headers(headers)});

  it('serves a ui/ file to anyone, with NanoAgent\'s content type and Content-Security-Policy', async () => {
    const asked = [];
    const ctx = ctxWith({installUiFile: async (...args) => { asked.push(args); return page('<!doctype html>'); }});
    const served = await invoke(routes, {method: 'GET', path: `/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/js/app%20main.js`, ctx, auth: null});
    assert.deepEqual(asked, [[SHA, '0123456789abcdef', 'js/app main.js']]);
    assert.equal(served.written.status, 200);
    assert.equal(served.written.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(served.written.headers['Content-Security-Policy'], CSP);
    assert.equal(served.written.headers['Cache-Control'], CACHE);
    assert.equal(served.written.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(served.written.body.toString(), '<!doctype html>');
    assert.equal(isPublicPath(`/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/index.html`), true);
    assert.equal(isGlobalApiPath(`/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/index.html`), true);
    assert.equal(isPublicPath('/api/apps/arxiv-source/sessions'), false);
    assert.equal(isGlobalApiPath('/api/apps/arxiv-source/sessions'), false);
  });

  it('refuses any path that could leave ui/', async () => {
    const ctx = ctxWith({installUiFile: async () => assert.fail('must not ask NanoAgent')});
    for (const path of [
      `/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/../nanoagent.yaml`,
      `/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/%2e%2e/nanoagent.yaml`,
      `/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/a/%2E%2E/%2E%2E/x`,
      `/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/..%2Fnanoagent.yaml`,
      `/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/a%5C..%5Cx`,
      `/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/a//b`,
      `/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/./index.html`,
      `/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/%zz`,
      `/api/apps/arxiv-source/ui/${PAGE}/0123456789abcdef/index.html`,
      `/api/apps/${'A'.repeat(64)}/ui/${PAGE}/0123456789abcdef/index.html`,
      `/api/apps/${SHA}/ui/${PAGE}/latest/index.html`,
      `/api/apps/${SHA}/ui/not-a-page/0123456789abcdef/index.html`,
    ]) {
      const result = await invoke(routes, {method: 'GET', path, ctx, auth: null});
      assert.equal(result.status, 404, path);
    }
  });

  it('relays a missing file and refuses one sent without its policy or caching', async () => {
    const missing = await invoke(routes, {
      method: 'GET', path: `/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/nope.js`, auth: null,
      ctx: ctxWith({installUiFile: async () => ({error: 'not found', status: 404})}),
    });
    assert.equal(missing.status, 404);
    const unguarded = await invoke(routes, {
      method: 'GET', path: `/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/index.html`, auth: null,
      ctx: ctxWith({installUiFile: async () => page('<script>', {'content-type': 'text/html'})}),
    });
    assert.equal(unguarded.status, 502);
    assert.equal(unguarded.written, null);
    const uncached = await invoke(routes, {
      method: 'GET', path: `/api/apps/${SHA}/ui/${PAGE}/0123456789abcdef/index.html`, auth: null,
      ctx: ctxWith({installUiFile: async () => page('<script>', {'content-type': 'text/html', 'content-security-policy': CSP})}),
    });
    assert.equal(uncached.status, 502);
  });

  it('serves a page only from the computer that opened it, while it is connected', async () => {
    const ctx = ctxWith({installUiFile: async () => assert.fail('must not ask another NanoAgent')});
    const gone = await invoke(routes, {method: 'GET', path: `/api/apps/${SHA}/ui/${'f'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/0123456789abcdef/index.html`, ctx, auth: null});
    assert.equal(gone.status, 503);
    assert.match(gone.payload.error, /not connected any more/);
  });
});

describe('an app\'s sessions', () => {
  const PATH = '/api/apps/echo/sessions';

  it('lists, starts and reads back the caller\'s sessions', async () => {
    const ctx = ctxWith({});
    const listed = await invoke(routes, {method: 'GET', path: PATH, ctx, requestContext: context});
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.payload.sessions.map(session => session.id), [SESSION]);
    const started = await invoke(routes, {method: 'POST', path: PATH, ctx, requestContext: context});
    assert.equal(started.payload.session.id, SESSION);
    assert.deepEqual(ctx.sessions.created, ['echo']);
    const read = await invoke(routes, {method: 'GET', path: `${PATH}/${SESSION}`, ctx, requestContext: context});
    assert.deepEqual(read.payload.session.calls, []);
  });

  it('starts no session with a version NanoAgent refuses, whose sessions it still lists, reads and archives', async () => {
    const ctx = ctxWith({});
    ctx.workspaceApps.refusal = async () => ({value: 'the package is refused: made for 0.6'});
    const started = await invoke(routes, {method: 'POST', path: PATH, ctx, requestContext: context});
    assert.equal(started.status, 409);
    assert.match(started.payload.error, /^echo is outdated: /);
    assert.deepEqual(ctx.sessions.created, []);
    assert.equal((await invoke(routes, {method: 'GET', path: PATH, ctx, requestContext: context})).status, 200);
    assert.equal((await invoke(routes, {method: 'GET', path: `${PATH}/${SESSION}`, ctx, requestContext: context})).status, 200);
    assert.equal((await invoke(routes, {method: 'PATCH', path: `${PATH}/${SESSION}`, body: {archived: true}, ctx, requestContext: context})).status, 200);
  });

  it('refuses to change a session, and any id that is not one', async () => {
    const ctx = ctxWith({});
    const put = await invoke(routes, {method: 'PUT', path: `${PATH}/${SESSION}`, body: {title: 'x'}, ctx, requestContext: context});
    assert.equal(put.status, 405);
    assert.equal((await invoke(routes, {method: 'GET', path: `${PATH}/not-an-id`, ctx, requestContext: context})).status, 404);
  });

  it('archives and restores one of the caller\'s sessions', async () => {
    const ctx = ctxWith({});
    const archived = await invoke(routes, {method: 'PATCH', path: `${PATH}/${SESSION}`, body: {archived: true}, ctx, requestContext: context});
    assert.equal(archived.status, 200);
    assert.ok(archived.payload.session.archivedAt);
    const restored = await invoke(routes, {method: 'PATCH', path: `${PATH}/${SESSION}`, body: {archived: false}, ctx, requestContext: context});
    assert.equal(restored.payload.session.archivedAt, null);
    assert.deepEqual(ctx.sessions.archived.map(one => one.archived), [true, false]);
    const bad = await invoke(routes, {method: 'PATCH', path: `${PATH}/${SESSION}`, body: {archived: 'yes'}, ctx, requestContext: context});
    assert.equal(bad.status, 400);
  });

  it('says which session is answering a message, which its page follows to the end or cancels', async () => {
    const ctx = ctxWith({});
    let finish;
    let cancelled = false;
    ctx.ai.stream = ({onDelta, signal}) => new Promise(resolve => {
      onDelta('Sav');
      signal.addEventListener('abort', () => { cancelled = true; resolve({error: 'The AI request was cancelled.', status: 499}); });
      finish = () => resolve({text: 'Saved.'});
    });
    await ctx.appRuns.start(context, {pluginId: 'echo', sessionId: SESSION, prompt: 'save 1706.03762', request: {install: SHA}});
    const listed = await invoke(routes, {method: 'GET', path: PATH, ctx, requestContext: context});
    assert.deepEqual(listed.payload.sessions.map(session => session.running), [true]);
    const read = await invoke(routes, {method: 'GET', path: `${PATH}/${SESSION}`, ctx, requestContext: context});
    assert.deepEqual(read.payload.session.running, {prompt: 'save 1706.03762'});
    await new Promise(resolve => setImmediate(resolve));
    const following = invoke(routes, {method: 'GET', path: `${PATH}/${SESSION}/run`, ctx, requestContext: context});
    await new Promise(resolve => setImmediate(resolve));
    finish();
    const followed = await following;
    assert.equal(followed.res.written.headers['Content-Type'], 'text/event-stream');
    assert.deepEqual(followed.res.writes.map(write => write.split('\n')[0]), ['event: delta', 'event: done']);
    const gone = await invoke(routes, {method: 'GET', path: `${PATH}/${SESSION}/run`, ctx, requestContext: context});
    assert.equal(gone.status, 404);
    assert.equal((await invoke(routes, {method: 'GET', path: `${PATH}/${SESSION}`, ctx, requestContext: context})).payload.session.running, null);

    await ctx.appRuns.start(context, {pluginId: 'echo', sessionId: SESSION, prompt: 'again', request: {install: SHA}});
    await new Promise(resolve => setImmediate(resolve));
    const stopped = await invoke(routes, {method: 'DELETE', path: `${PATH}/${SESSION}/run`, ctx, requestContext: context});
    assert.equal(stopped.status, 200);
    assert.equal(cancelled, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ctx.sessions.turns.map(({prompt, error}) => [prompt, error]), [['save 1706.03762', null], ['again', 'The AI request was cancelled.']]);
  });

  it('lets a viewer read and start their own sessions', async () => {
    const ctx = ctxWith({});
    const viewer = {...context, role: 'viewer'};
    assert.equal((await invoke(routes, {method: 'GET', path: PATH, ctx, requestContext: viewer})).status, 200);
    assert.equal((await invoke(routes, {method: 'POST', path: PATH, ctx, requestContext: viewer})).status, 200);
  });

  it('needs PostgreSQL', async () => {
    const ctx = ctxWith({});
    ctx.sessions = null;
    const result = await invoke(routes, {method: 'GET', path: PATH, ctx, requestContext: context});
    assert.equal(result.status, 409);
  });
});
