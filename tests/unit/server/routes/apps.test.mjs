import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';

const {agentWorkspaceId} = createRequire(import.meta.url)('../../../../src/server/agent-workspace.js');

const routes = loadRoute('apps');
const context = {workspaceId: 'test-org', userId: 'test-user', membershipId: 'member-1', role: 'owner'};
const APP = {id: 'echo', name: 'Echo', version: '1.0.0', tasks: [], tools: [], readme: '# Echo\n'};

function ctxWith(ai) {
  const ctx = makeCtx();
  ctx.ai = {...ctx.ai, ...ai};
  return ctx;
}

describe('NanoAgent apps', () => {
  it('lists the apps NanoAgent publishes', async () => {
    const ctx = ctxWith({plugins: async () => ({value: {plugins: [APP]}})});
    const listed = await invoke(routes, {method: 'GET', path: '/api/apps', ctx, requestContext: context});
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.payload, {apps: [APP]});
  });

  it('relays an unreachable NanoAgent instead of an empty catalog', async () => {
    const ctx = ctxWith({plugins: async () => ({error: 'Could not reach NanoAgent.', status: 502})});
    const listed = await invoke(routes, {method: 'GET', path: '/api/apps', ctx, requestContext: context});
    assert.equal(listed.status, 502);
    assert.equal(listed.payload.error, 'Could not reach NanoAgent.');
  });

  it('derives one stable, opaque workspace per member of a workspace', () => {
    const alice = agentWorkspaceId({workspaceId: 'ws-1', userId: 'alice'});
    assert.match(alice, /^[0-9a-f]{32}$/);
    assert.equal(agentWorkspaceId({workspaceId: 'ws-1', userId: 'alice'}), alice);
    assert.notEqual(agentWorkspaceId({workspaceId: 'ws-1', userId: 'bob'}), alice);
    assert.notEqual(agentWorkspaceId({workspaceId: 'ws-2', userId: 'alice'}), alice);
  });

  it('lists only the caller\'s own agent workspace', async () => {
    const asked = [];
    const ctx = ctxWith({
      workspaceFiles: async workspace => {
        asked.push(workspace);
        return {value: {files: [{path: 'attention/ms.tex', size: 10, modified: 1}], truncated: false}};
      },
    });
    const listed = await invoke(routes, {method: 'GET', path: '/api/agent-files', ctx, requestContext: context});
    assert.equal(listed.status, 200);
    assert.deepEqual(asked, [agentWorkspaceId(context)]);
    assert.equal(listed.payload.files[0].path, 'attention/ms.tex');
  });

  it('serves text as plain text and never as HTML', async () => {
    const ctx = ctxWith({
      workspaceFile: async (_workspace, path) => ({value: Buffer.from(path.endsWith('.html') ? '<script>x</script>' : '\\section{Intro}')}),
    });
    for (const path of ['attention/ms.tex', 'page.html']) {
      const served = await invoke(routes, {method: 'GET', path: '/api/agent-files/content', query: `?path=${path}`, ctx, requestContext: context});
      assert.equal(served.res.written.status, 200);
      assert.equal(served.res.written.headers['Content-Type'], 'text/plain; charset=utf-8');
      assert.equal(served.res.written.headers['X-Content-Type-Options'], 'nosniff');
    }
  });

  it('sends a viewable file as an attachment when asked to download it', async () => {
    const ctx = ctxWith({workspaceFile: async () => ({value: Buffer.from('text')})});
    const served = await invoke(routes, {
      method: 'GET', path: '/api/agent-files/content', query: '?path=notes/a.txt&download=1', ctx, requestContext: context,
    });
    assert.equal(served.res.written.headers['Content-Disposition'], 'attachment; filename="a.txt"');
  });

  it('does not let a viewer delete workspace files', async () => {
    const ctx = ctxWith({deleteWorkspaceFile: async () => assert.fail('must not delete')});
    await assert.rejects(
      invoke(routes, {
        method: 'DELETE', path: '/api/agent-files/content', query: '?path=a.txt', ctx,
        requestContext: {...context, role: 'viewer'},
      }),
      error => error?.status === 403,
    );
  });

  it('saves a file to the caller\'s workspace, refusing to replace one when creating', async () => {
    const saved = [];
    const ctx = ctxWith({
      saveWorkspaceFile: async (...args) => {
        saved.push(args);
        return {value: {path: 'notes/a.md', size: 5, modified: 1}};
      },
    });
    ctx.readRawBody = async () => Buffer.from('hello');
    const result = await invoke(routes, {
      method: 'PUT', path: '/api/agent-files/content', query: '?path=notes/a.md&create=1', ctx, requestContext: context,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(saved.map(([workspace, path, body, options]) => [workspace, path, body.toString(), options]), [
      [agentWorkspaceId(context), 'notes/a.md', 'hello', {create: true}],
    ]);
  });

  it('makes and deletes folders, and moves entries', async () => {
    const calls = [];
    const record = name => async (...args) => { calls.push([name, ...args.slice(1)]); return {value: {ok: true}}; };
    const ctx = ctxWith({
      makeWorkspaceFolder: record('make'),
      deleteWorkspaceFolder: record('delete'),
      moveWorkspaceEntry: record('move'),
    });
    await invoke(routes, {method: 'POST', path: '/api/agent-files/folder', query: '?path=papers', ctx, requestContext: context});
    await invoke(routes, {method: 'DELETE', path: '/api/agent-files/folder', query: '?path=papers', ctx, requestContext: context});
    await invoke(routes, {method: 'POST', path: '/api/agent-files/move', body: {from: 'a.md', to: 'b/a.md'}, ctx, requestContext: context});
    assert.deepEqual(calls, [['make', 'papers'], ['delete', 'papers'], ['move', 'a.md', 'b/a.md']]);
    const bad = await invoke(routes, {method: 'POST', path: '/api/agent-files/move', body: {from: 'a.md'}, ctx, requestContext: context});
    assert.equal(bad.status, 400);
  });

  it('relays a name already taken as a conflict', async () => {
    const ctx = ctxWith({makeWorkspaceFolder: async () => ({error: 'papers already exists', status: 409})});
    const result = await invoke(routes, {method: 'POST', path: '/api/agent-files/folder', query: '?path=papers', ctx, requestContext: context});
    assert.equal(result.status, 409);
    assert.equal(result.payload.error, 'papers already exists');
  });

  it('does not let a viewer change the workspace', async () => {
    const ctx = ctxWith({saveWorkspaceFile: async () => assert.fail('must not save')});
    for (const request of [
      {method: 'PUT', path: '/api/agent-files/content', query: '?path=a.txt'},
      {method: 'POST', path: '/api/agent-files/folder', query: '?path=a'},
      {method: 'POST', path: '/api/agent-files/move', body: {from: 'a', to: 'b'}},
    ]) {
      await assert.rejects(
        invoke(routes, {...request, ctx, requestContext: {...context, role: 'viewer'}}),
        error => error?.status === 403,
      );
    }
  });
});

describe('an app\'s own page', () => {
  const require = createRequire(import.meta.url);
  const {isPublicPath} = require('../../../../src/server/auth.js');
  const {isGlobalApiPath} = require('../../../../src/server/workspace-context.js');
  const CSP = "default-src 'self'; connect-src 'none'";
  const page = (body, headers = {'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP}) =>
    ({value: Buffer.from(body), headers: new Headers(headers)});

  it('serves a ui/ file to anyone, with NanoAgent\'s content type and Content-Security-Policy', async () => {
    const asked = [];
    const ctx = ctxWith({pluginUiFile: async (...args) => { asked.push(args); return page('<!doctype html>'); }});
    const served = await invoke(routes, {method: 'GET', path: '/api/apps/chess-move/ui/js/app%20main.js', ctx, auth: null});
    assert.deepEqual(asked, [['chess-move', 'js/app main.js']]);
    assert.equal(served.written.status, 200);
    assert.equal(served.written.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(served.written.headers['Content-Security-Policy'], CSP);
    assert.equal(served.written.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(served.written.body.toString(), '<!doctype html>');
    assert.equal(isPublicPath('/api/apps/chess-move/ui/index.html'), true);
    assert.equal(isGlobalApiPath('/api/apps/chess-move/ui/index.html'), true);
    assert.equal(isPublicPath('/api/apps/chess-move/tasks/move/runs'), false);
    assert.equal(isGlobalApiPath('/api/apps/chess-move/tasks/move/runs'), false);
  });

  it('refuses any path that could leave ui/', async () => {
    const ctx = ctxWith({pluginUiFile: async () => assert.fail('must not ask NanoAgent')});
    for (const path of [
      '/api/apps/chess-move/ui/../nanoagent.yaml',
      '/api/apps/chess-move/ui/%2e%2e/nanoagent.yaml',
      '/api/apps/chess-move/ui/a/%2E%2E/%2E%2E/x',
      '/api/apps/chess-move/ui/..%2Fnanoagent.yaml',
      '/api/apps/chess-move/ui/a%5C..%5Cx',
      '/api/apps/chess-move/ui/a//b',
      '/api/apps/chess-move/ui/./index.html',
      '/api/apps/chess-move/ui/%zz',
      '/api/apps/Chess/ui/index.html',
    ]) {
      const result = await invoke(routes, {method: 'GET', path, ctx, auth: null});
      assert.equal(result.status, 404, path);
    }
  });

  it('relays a missing file and refuses one sent without its policy', async () => {
    const missing = await invoke(routes, {
      method: 'GET', path: '/api/apps/chess-move/ui/nope.js', auth: null,
      ctx: ctxWith({pluginUiFile: async () => ({error: 'not found', status: 404})}),
    });
    assert.equal(missing.status, 404);
    const unguarded = await invoke(routes, {
      method: 'GET', path: '/api/apps/chess-move/ui/index.html', auth: null,
      ctx: ctxWith({pluginUiFile: async () => page('<script>', {'content-type': 'text/html'})}),
    });
    assert.equal(unguarded.status, 502);
    assert.equal(unguarded.written, null);
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

  it('runs in the caller\'s own workspace and passes the event stream through', async () => {
    const asked = [];
    const events = ['event: task.started\ndata: {"type":"task.started","runId":"r","task":"daily-digest"}\n\n', ': heartbeat\n\n', 'event: task.done\ndata: {"type":"task.done","runId":"r"}\n\n'];
    const ctx = ctxWith({taskRun: async request => { asked.push(request); return {value: stream(events)}; }});
    const result = await invoke(routes, {
      method: 'POST', path: PATH, body: {arguments: {people: ['Ada']}}, ctx, requestContext: context,
    });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].workspace, agentWorkspaceId(context));
    assert.equal(asked[0].app, 'arxiv-source');
    assert.equal(asked[0].task, 'daily-digest');
    assert.deepEqual(asked[0].args, {people: ['Ada']});
    assert.equal(result.written.status, 200);
    assert.equal(result.written.headers['Content-Type'], 'text/event-stream');
    assert.equal(result.res.writes.join(''), events.join(''));
    assert.equal(result.res.writableEnded, true);
  });

  it('is for owners and editors only, and needs arguments as an object', async () => {
    const ctx = ctxWith({taskRun: async () => assert.fail('must not run')});
    await assert.rejects(
      invoke(routes, {method: 'POST', path: PATH, body: {arguments: {}}, ctx, requestContext: {...context, role: 'viewer'}}),
      error => error?.status === 403,
    );
    for (const body of [{}, {arguments: []}, {arguments: 'x'}, 'not json']) {
      const result = await invoke(routes, {method: 'POST', path: PATH, body, ctx, requestContext: context});
      assert.equal(result.status, 400);
    }
  });

  it('relays a refusal from NanoAgent before any stream starts', async () => {
    const ctx = ctxWith({taskRun: async () => ({error: 'arguments.people: required', status: 400})});
    const result = await invoke(routes, {method: 'POST', path: PATH, body: {arguments: {}}, ctx, requestContext: context});
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
      method: 'POST', path: PATH, body: {arguments: {}}, ctx, requestContext: context,
      onRequest: (_req, res) => setTimeout(() => res.emit('close'), 10),
    });
    const result = await running;
    assert.equal(signal.aborted, true);
    assert.equal(result.res.writableEnded, true);
  });
});
