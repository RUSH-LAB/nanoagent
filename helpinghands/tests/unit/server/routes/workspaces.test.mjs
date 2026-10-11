import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';

const routes = loadRoute('workspaces');

describe('GET /api/workspaces', () => {
  it('lists memberships using the canonical role names', async () => {
    const ctx = makeCtx({
      org: {
        listMemberships: () => [
          {id: 'a', slug: 'alpha', role: 'admin'},
          {id: 'b', slug: 'beta', role: 'member'},
        ],
      },
    });
    const r = await invoke(routes, {
      path: '/api/workspaces', ctx, auth: {userId: 'ada', orgId: 'b'},
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.userId, 'ada');
    assert.deepEqual(r.payload.workspaces.map(w => w.role), ['editor', 'viewer']);
    assert.equal(r.payload.defaultWorkspaceId, 'b');
  });
});

describe('GET /api/workspaces/:id', () => {
  it('returns the workspace already authorized by RequestContext', async () => {
    const context = {userId: 'ada', workspaceId: 'a', membershipId: 'm-a', role: 'owner'};
    const ctx = makeCtx({
      org: {
        listMemberships: () => [],
        getOrganization: context => ({id: context.workspaceId, userId: context.userId, slug: 'alpha'}),
      },
    });
    const r = await invoke(routes, {
      path: '/api/workspaces/a', ctx, auth: {userId: 'ada'}, requestContext: context,
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.workspace.id, 'a');
    assert.equal(r.payload.you.membershipId, 'm-a');
  });
});

describe('DELETE /api/workspaces/:id', () => {
  it('archives by default after owner confirmation', async () => {
    const calls = [];
    const context = {userId: 'ada', workspaceId: 'a', membershipId: 'm-a', role: 'owner'};
    const ctx = makeCtx({org: {
      getOrganization: () => ({id: 'a', slug: 'alpha'}),
      archiveWorkspace: value => calls.push(['archive', value]),
      deleteWorkspace: value => calls.push(['delete', value]),
    }});
    const r = await invoke(routes, {
      method: 'DELETE', path: '/api/workspaces/a', body: {confirmSlug: 'alpha'},
      ctx, auth: {userId: 'ada'}, requestContext: context,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, [['archive', context]]);
  });

  it('hides lifecycle operations from non-owners', async () => {
    const context = {userId: 'ada', workspaceId: 'a', membershipId: 'm-a', role: 'editor'};
    const r = await invoke(routes, {
      method: 'DELETE', path: '/api/workspaces/a', body: {confirmSlug: 'alpha'},
      ctx: makeCtx(), auth: {userId: 'ada'}, requestContext: context,
    });
    assert.equal(r.status, 403);
  });

  it('drains queued objects after a hard delete', async () => {
    const calls = [];
    const context = {userId: 'ada', workspaceId: 'a', membershipId: 'm-a', role: 'owner'};
    const ctx = makeCtx({
      org: {
        getOrganization: () => ({id: 'a', slug: 'alpha'}),
        deleteWorkspace: value => calls.push(['delete', value]),
      },
      cleanPendingObjects: async () => {
        calls.push(['cleanup']);
        return {processed: 1, removed: 1, failed: 0};
      },
    });
    const r = await invoke(routes, {
      method: 'DELETE', path: '/api/workspaces/a', body: {confirmSlug: 'alpha', mode: 'delete'},
      ctx, auth: {userId: 'ada'}, requestContext: context,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, [['delete', context], ['cleanup']]);
  });
});

describe('GET /api/workspace-site', () => {
  const membership = {id: 'a', slug: 'alpha', name: 'Alpha', role: 'admin'};
  const site = {navigation: [], collections: [{key: 'notes', type: 'docs'}]};
  const ctxWith = ({contexts = {}} = {}) => {
    const ctx = makeCtx({org: {listMemberships: () => [membership]}});
    ctx.workspaceContexts = {byId: async (userId, id) => contexts[id] ?? null};
    ctx.workspaceSettings = {get: async () => ({site})};
    return ctx;
  };

  it('answers the membership and its site in one read', async () => {
    const ctx = ctxWith({contexts: {a: {userId: 'ada', workspaceId: 'a', membershipId: 'm', role: 'editor'}}});
    const r = await invoke(routes, {path: '/api/workspace-site', query: '?slug=alpha', ctx, auth: {userId: 'ada'}});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.workspace, {...membership, role: 'editor'});
    assert.ok(Array.isArray(r.payload.site.collections));
  });

  it('does not reveal a workspace the caller is not a member of', async () => {
    const ctx = ctxWith();
    for (const query of ['?slug=beta', '?slug=alpha', '']) {
      const r = await invoke(routes, {path: '/api/workspace-site', query, ctx, auth: {userId: 'ada'}});
      assert.equal(r.status, 404);
    }
  });
});
