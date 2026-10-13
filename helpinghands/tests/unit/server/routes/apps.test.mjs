import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadRoute, makeCtx, invoke, fakeSessions, SESSION} from '../../_harness.mjs';

const routes = loadRoute('apps');
const context = {workspaceId: 'test-org', userId: 'test-user', membershipId: 'member-1', role: 'owner'};
const SHA = 'a'.repeat(64);
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
    open: async (context, id) => {
      calls.push(['open', id]);
      return {value: {...APP, id, uiVersion: '0123456789abcdef'}};
    },
    ...overrides,
  };
}

function ctxWith(ai, fs = fakeFs()) {
  const ctx = makeCtx();
  ctx.ai = {...ctx.ai, ...ai};
  ctx.workspaceFs = fs;
  ctx.agentSync = {run: (_scope, operation) => operation('run-folder')};
  ctx.sessions = fakeSessions();
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

  it('opens an added app installed, for any member', async () => {
    const ctx = ctxWith({});
    const opened = await invoke(routes, {method: 'GET', path: '/api/apps/echo', ctx, requestContext: {...context, role: 'viewer'}});
    assert.equal(opened.status, 200);
    assert.equal(opened.payload.app.sha256, SHA);
    assert.deepEqual(ctx.workspaceApps.calls, [['open', 'echo']]);
    ctx.workspaceApps.open = async () => ({error: 'This workspace has no plugin named nope', status: 404});
    assert.equal((await invoke(routes, {method: 'GET', path: '/api/apps/nope', ctx, requestContext: context})).status, 404);
    assert.equal((await invoke(routes, {method: 'GET', path: '/api/apps/Not%20an%20id', ctx, requestContext: context})).status, 404);
  });

  it('lets only an owner add and remove a plugin', async () => {
    const ctx = ctxWith({});
    const added = await invoke(routes, {method: 'PUT', path: '/api/apps/echo', ctx, requestContext: context});
    assert.equal(added.status, 200);
    assert.deepEqual(added.payload, {app: APP});
    const removed = await invoke(routes, {method: 'DELETE', path: '/api/apps/echo', ctx, requestContext: context});
    assert.deepEqual(removed.payload, {removed: 'echo'});
    assert.equal((await invoke(routes, {method: 'DELETE', path: '/api/apps/other', ctx, requestContext: context})).status, 404);
    for (const role of ['editor', 'viewer']) {
      for (const method of ['PUT', 'DELETE']) {
        await assert.rejects(
          invoke(routes, {method, path: '/api/apps/echo', ctx, requestContext: {...context, role}}),
          error => error?.status === 403,
        );
      }
    }
    assert.deepEqual(ctx.workspaceApps.calls, [['add', 'echo'], ['remove', 'echo'], ['remove', 'other']]);
  });

  it('lets only an owner tag a plugin, with a short list of short names', async () => {
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
    await assert.rejects(tag({tags: ['x']}, 'editor'), error => error?.status === 403);
    assert.deepEqual(ctx.workspaceApps.calls, [['tag', 'echo', ['Writing', 'Daily']], ['tag', 'echo', []], ['tag', 'other', ['x']]]);
  });

  it('relays a plugin the marketplace does not have', async () => {
    const ctx = ctxWith({});
    ctx.workspaceApps.add = async () => ({error: 'No plugin named nope in the marketplace', status: 404});
    const added = await invoke(routes, {method: 'PUT', path: '/api/apps/nope', ctx, requestContext: context});
    assert.equal(added.status, 404);
  });

  it('lists only the caller\'s own agent folder', async () => {
    const fs = fakeFs({'home/test-user/agent/attention/ms.tex': '\\section{}', 'home/other/agent/x.md': 'not yours'});
    const listed = await invoke(routes, {method: 'GET', path: '/api/agent-files', ctx: ctxWith({}, fs), requestContext: context});
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.payload, {files: [{path: 'attention/ms.tex', size: 10}]});
  });

  it('serves text as plain text and never as HTML', async () => {
    const fs = fakeFs({'home/test-user/agent/attention/ms.tex': '\\section{Intro}', 'home/test-user/agent/page.html': '<script>x</script>'});
    for (const path of ['attention/ms.tex', 'page.html']) {
      const served = await invoke(routes, {method: 'GET', path: '/api/agent-files/content', query: `?path=${path}`, ctx: ctxWith({}, fs), requestContext: context});
      assert.equal(served.res.written.status, 200);
      assert.equal(served.res.written.headers['Content-Type'], 'text/plain; charset=utf-8');
      assert.equal(served.res.written.headers['X-Content-Type-Options'], 'nosniff');
    }
  });

  it('sends a viewable file as an attachment when asked to download it', async () => {
    const fs = fakeFs({'home/test-user/agent/notes/a.txt': 'text'});
    const served = await invoke(routes, {
      method: 'GET', path: '/api/agent-files/content', query: '?path=notes/a.txt&download=1', ctx: ctxWith({}, fs), requestContext: context,
    });
    assert.equal(served.res.written.headers['Content-Disposition'], 'attachment; filename="a.txt"');
  });

  it('reports a missing file', async () => {
    const result = await invoke(routes, {method: 'GET', path: '/api/agent-files/content', query: '?path=nope.md', ctx: ctxWith({}), requestContext: context});
    assert.equal(result.status, 404);
  });

  it('saves a file to the caller\'s agent folder, refusing to replace one when creating', async () => {
    const fs = fakeFs();
    const ctx = ctxWith({}, fs);
    ctx.readRawBody = async () => Buffer.from('hello');
    const created = await invoke(routes, {
      method: 'PUT', path: '/api/agent-files/content', query: '?path=notes/a.md&create=1', ctx, requestContext: context,
    });
    assert.equal(created.status, 200);
    assert.deepEqual(created.payload, {path: 'notes/a.md', size: 5});
    await invoke(routes, {method: 'PUT', path: '/api/agent-files/content', query: '?path=notes/a.md', ctx, requestContext: context});
    assert.deepEqual(fs.writes, [
      ['home/test-user/agent/notes/a.md', 'hello', {baseRev: 0}],
      ['home/test-user/agent/notes/a.md', 'hello', {}],
    ]);
  });

  it('does not let a viewer change the agent folder', async () => {
    const fs = fakeFs();
    fs.write = async () => assert.fail('must not save');
    await assert.rejects(
      invoke(routes, {method: 'PUT', path: '/api/agent-files/content', query: '?path=a.txt', ctx: ctxWith({}, fs), requestContext: {...context, role: 'viewer'}}),
      error => error?.status === 403,
    );
  });

  it('refuses agent files without the workspace file system', async () => {
    const ctx = ctxWith({}, null);
    const result = await invoke(routes, {method: 'GET', path: '/api/agent-files', ctx, requestContext: context});
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
    const served = await invoke(routes, {method: 'GET', path: `/api/apps/${SHA}/ui/0123456789abcdef/js/app%20main.js`, ctx, auth: null});
    assert.deepEqual(asked, [[SHA, '0123456789abcdef', 'js/app main.js']]);
    assert.equal(served.written.status, 200);
    assert.equal(served.written.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(served.written.headers['Content-Security-Policy'], CSP);
    assert.equal(served.written.headers['Cache-Control'], CACHE);
    assert.equal(served.written.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(served.written.body.toString(), '<!doctype html>');
    assert.equal(isPublicPath(`/api/apps/${SHA}/ui/0123456789abcdef/index.html`), true);
    assert.equal(isGlobalApiPath(`/api/apps/${SHA}/ui/0123456789abcdef/index.html`), true);
    assert.equal(isPublicPath('/api/apps/chess-move/tasks/move/runs'), false);
    assert.equal(isGlobalApiPath('/api/apps/chess-move/tasks/move/runs'), false);
  });

  it('refuses any path that could leave ui/', async () => {
    const ctx = ctxWith({installUiFile: async () => assert.fail('must not ask NanoAgent')});
    for (const path of [
      `/api/apps/${SHA}/ui/0123456789abcdef/../nanoagent.yaml`,
      `/api/apps/${SHA}/ui/0123456789abcdef/%2e%2e/nanoagent.yaml`,
      `/api/apps/${SHA}/ui/0123456789abcdef/a/%2E%2E/%2E%2E/x`,
      `/api/apps/${SHA}/ui/0123456789abcdef/..%2Fnanoagent.yaml`,
      `/api/apps/${SHA}/ui/0123456789abcdef/a%5C..%5Cx`,
      `/api/apps/${SHA}/ui/0123456789abcdef/a//b`,
      `/api/apps/${SHA}/ui/0123456789abcdef/./index.html`,
      `/api/apps/${SHA}/ui/0123456789abcdef/%zz`,
      '/api/apps/chess-move/ui/0123456789abcdef/index.html',
      `/api/apps/${'A'.repeat(64)}/ui/0123456789abcdef/index.html`,
      `/api/apps/${SHA}/ui/latest/index.html`,
    ]) {
      const result = await invoke(routes, {method: 'GET', path, ctx, auth: null});
      assert.equal(result.status, 404, path);
    }
  });

  it('relays a missing file and refuses one sent without its policy or caching', async () => {
    const missing = await invoke(routes, {
      method: 'GET', path: `/api/apps/${SHA}/ui/0123456789abcdef/nope.js`, auth: null,
      ctx: ctxWith({installUiFile: async () => ({error: 'not found', status: 404})}),
    });
    assert.equal(missing.status, 404);
    const unguarded = await invoke(routes, {
      method: 'GET', path: `/api/apps/${SHA}/ui/0123456789abcdef/index.html`, auth: null,
      ctx: ctxWith({installUiFile: async () => page('<script>', {'content-type': 'text/html'})}),
    });
    assert.equal(unguarded.status, 502);
    assert.equal(unguarded.written, null);
    const uncached = await invoke(routes, {
      method: 'GET', path: `/api/apps/${SHA}/ui/0123456789abcdef/index.html`, auth: null,
      ctx: ctxWith({installUiFile: async () => page('<script>', {'content-type': 'text/html', 'content-security-policy': CSP})}),
    });
    assert.equal(uncached.status, 502);
  });
});

describe('an app\'s task runs', () => {
  const stream = chunks => new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const PATH = '/api/apps/arxiv-source/tasks/daily-digest/runs';

  it('runs on a copy of the caller\'s agent folder and passes the event stream through', async () => {
    const asked = [];
    const metrics = {model: 'm', cost: 0.012, usage: {prompt_tokens: 10, completion_tokens: 5}, ttft_s: 1.5, generation_s: 3, duration_s: 9};
    const events = [
      'event: task.started\ndata: {"type":"task.started","runId":"r","task":"daily-digest"}\n\n', ': heartbeat\n\n',
      `data: ${JSON.stringify({type: 'task.done', runId: 'r', metrics}).slice(0, 20)}`,
      `${JSON.stringify({type: 'task.done', runId: 'r', metrics}).slice(20)}\n\n`,
    ];
    const ctx = ctxWith({taskRun: async request => { asked.push(request); return {value: stream(events)}; }});
    const result = await invoke(routes, {
      method: 'POST', path: PATH, body: {arguments: {people: ['Ada']}, sessionId: SESSION}, ctx, requestContext: context,
    });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].workspace, 'run-folder');
    assert.equal(asked[0].install, SHA);
    assert.deepEqual(ctx.workspaceApps.calls, [['open', 'arxiv-source']]);
    assert.equal(asked[0].task, 'daily-digest');
    assert.deepEqual(asked[0].args, {people: ['Ada']});
    assert.equal(result.written.status, 200);
    assert.equal(result.written.headers['Content-Type'], 'text/event-stream');
    assert.equal(result.res.writes.join(''), events.join(''));
    assert.equal(result.res.writableEnded, true);
    // Charged what task.done says it cost, against the session.
    assert.deepEqual(ctx.calls.aiUsage.map(({context: _, ...call}) => call), [{
      kind: 'task', result: {cost: 0.012, model: 'm', usage: metrics.usage, metrics},
      ran: true, pluginId: 'arxiv-source', sessionId: SESSION, task: 'daily-digest',
    }]);
  });

  it('charges a run that ends without metrics at the cap', async () => {
    const ctx = ctxWith({taskRun: async () => ({value: stream(['data: {"type":"task.error","message":"cancelled"}\n\n', 'data: {"type":"task.done"}\n\n'])})});
    await invoke(routes, {method: 'POST', path: PATH, body: {arguments: {}, sessionId: SESSION}, ctx, requestContext: context});
    assert.equal(ctx.calls.aiUsage.length, 1);
    assert.equal(ctx.calls.aiUsage[0].result, null);
    assert.equal(ctx.calls.aiUsage[0].ran, true);
  });

  it('runs only in one of the caller\'s sessions with the app', async () => {
    const ctx = ctxWith({taskRun: async () => assert.fail('must not run')});
    const result = await invoke(routes, {
      method: 'POST', path: '/api/apps/chess-move/tasks/play-move/runs', body: {arguments: {}, sessionId: SESSION}, ctx, requestContext: context,
    });
    assert.equal(result.status, 404);
    const unnamed = await invoke(routes, {method: 'POST', path: PATH, body: {arguments: {}}, ctx, requestContext: context});
    assert.equal(unnamed.status, 400);
  });

  it('is for owners and editors only, and needs arguments as an object', async () => {
    const ctx = ctxWith({taskRun: async () => assert.fail('must not run')});
    await assert.rejects(
      invoke(routes, {method: 'POST', path: PATH, body: {arguments: {}, sessionId: SESSION}, ctx, requestContext: {...context, role: 'viewer'}}),
      error => error?.status === 403,
    );
    for (const body of [{}, {arguments: [], sessionId: SESSION}, {arguments: 'x', sessionId: SESSION}, 'not json']) {
      const result = await invoke(routes, {method: 'POST', path: PATH, body, ctx, requestContext: context});
      assert.equal(result.status, 400);
    }
  });

  it('refuses to run without the workspace file system', async () => {
    const ctx = ctxWith({taskRun: async () => assert.fail('must not run')});
    ctx.agentSync = null;
    const result = await invoke(routes, {method: 'POST', path: PATH, body: {arguments: {}, sessionId: SESSION}, ctx, requestContext: context});
    assert.equal(result.status, 409);
    assert.equal(result.payload.code, 'fs-disabled');
  });

  it('relays a refusal from NanoAgent before any stream starts', async () => {
    const ctx = ctxWith({taskRun: async () => ({error: 'arguments.people: required', status: 400})});
    const result = await invoke(routes, {method: 'POST', path: PATH, body: {arguments: {}, sessionId: SESSION}, ctx, requestContext: context});
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'arguments.people: required');
  });

  it('cancels the run when the caller hangs up', async () => {
    let signal;
    const ctx = ctxWith({
      taskRun: async request => {
        signal = request.signal;
        return {value: new ReadableStream({
          start(controller) {
            request.signal.addEventListener('abort', () => controller.error(new Error('aborted')), {once: true});
          },
        })};
      },
    });
    const running = invoke(routes, {
      method: 'POST', path: PATH, body: {arguments: {}, sessionId: SESSION}, ctx, requestContext: context,
      onRequest: (_req, res) => setTimeout(() => res.emit('close'), 10),
    });
    const result = await running;
    assert.equal(signal.aborted, true);
    assert.equal(result.res.writableEnded, true);
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

  it('saves what the page keeps, and only in an existing session', async () => {
    const ctx = ctxWith({});
    const saved = await invoke(routes, {method: 'PUT', path: `${PATH}/${SESSION}`, body: {state: {fen: 'x'}, title: 'Game'}, ctx, requestContext: context});
    assert.equal(saved.status, 200);
    assert.deepEqual(ctx.sessions.saved, [{pluginId: 'echo', id: SESSION, state: {fen: 'x'}, title: 'Game'}]);
    const missing = await invoke(routes, {
      method: 'PUT', path: '/api/apps/echo/sessions/00000000-0000-4000-8000-000000000002', body: {state: null}, ctx, requestContext: context,
    });
    assert.equal(missing.status, 404);
    const shapeless = await invoke(routes, {method: 'PUT', path: `${PATH}/${SESSION}`, body: {title: 'x'}, ctx, requestContext: context});
    assert.equal(shapeless.status, 400);
    assert.equal((await invoke(routes, {method: 'GET', path: `${PATH}/not-an-id`, ctx, requestContext: context})).status, 404);
  });

  it('lets a viewer read sessions but not start or save one', async () => {
    const ctx = ctxWith({});
    const viewer = {...context, role: 'viewer'};
    assert.equal((await invoke(routes, {method: 'GET', path: PATH, ctx, requestContext: viewer})).status, 200);
    await assert.rejects(invoke(routes, {method: 'POST', path: PATH, ctx, requestContext: viewer}), error => error?.status === 403);
  });

  it('needs PostgreSQL', async () => {
    const ctx = ctxWith({});
    ctx.sessions = null;
    const result = await invoke(routes, {method: 'GET', path: PATH, ctx, requestContext: context});
    assert.equal(result.status, 409);
  });
});
