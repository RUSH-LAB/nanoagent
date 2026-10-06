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
});
