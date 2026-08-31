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
});
