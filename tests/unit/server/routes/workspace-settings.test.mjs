import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {invoke, makeCtx} from '../../_harness.mjs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const routes = require('../../../../src/server/routes/workspace-settings.js');
const context = role => ({userId: 'ada', workspaceId: 'lab', membershipId: 'member-1', role});

describe('workspace settings routes', () => {
  it('lets every member read shared settings', async () => {
    const ctx = makeCtx();
    const owner = context('owner');
    await invoke(routes, {method: 'PUT', path: '/api/workspaces/lab/settings', body: {settings: {brand: 'Mochi'}}, ctx, requestContext: owner});
    const read = await invoke(routes, {path: '/api/workspaces/lab/settings', ctx, requestContext: context('viewer')});
    assert.equal(read.payload.settings.brand, 'Mochi');
  });

  it('only lets owners change shared settings', async () => {
    const denied = await invoke(routes, {method: 'PUT', path: '/api/workspaces/lab/settings', body: {settings: {brand: 'Nope'}}, requestContext: context('editor')});
    assert.equal(denied.status, 403);
    assert.equal(denied.payload.code, 'workspace-permission-denied');
  });

  it('keeps member preferences separate inside a workspace', async () => {
    const ctx = makeCtx();
    await invoke(routes, {method: 'PUT', path: '/api/workspaces/lab/member-preferences', body: {settings: {sidebar: 'compact'}}, ctx, requestContext: context('viewer')});
    const other = {...context('viewer'), userId: 'grace', membershipId: 'member-2'};
    const read = await invoke(routes, {path: '/api/workspaces/lab/member-preferences', ctx, requestContext: other});
    assert.deepEqual(read.payload.settings, {});
  });

  it('derives a safe workspace site from document paths', async () => {
    const ctx = makeCtx();
    const owner = context('owner');
    await ctx.documents.create(owner, {path: 'books/math/0-intro.md', markdown: '# Math'});
    await ctx.documents.create(owner, {path: 'posts/research/paper.md', markdown: '# Paper'});
    const read = await invoke(routes, {path: '/api/workspaces/lab/site', ctx, requestContext: context('viewer')});
    assert.equal(read.status, 200);
    assert.deepEqual(read.payload.site.navigation, [
      {label: 'Research', path: 'posts/research/paper.md'},
      {label: 'Math', path: 'books/math/0-intro.md'},
    ]);
  });

  it('only lets owners save validated workspace site configuration', async () => {
    const ctx = makeCtx();
    const denied = await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/lab/site', ctx,
      requestContext: context('editor'), body: {site: {navigation: []}},
    });
    assert.equal(denied.status, 403);

    const saved = await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/lab/site', ctx,
      requestContext: context('owner'),
      body: {site: {site: {title: 'Ada Lab'}, navigation: [{label: 'Math', path: 'books/math/0-intro.md'}]}},
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.site.site.title, 'Ada Lab');
    assert.deepEqual(saved.payload.site.navigation, [{label: 'Math', path: 'books/math/0-intro.md'}]);
  });
});
