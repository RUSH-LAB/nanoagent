import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke, TEST_ORG_ID, key} from '../../../_harness.mjs';

const routes = loadRoute('misc-tools');
const requestContext = Object.freeze({
  userId: 'test-user', workspaceId: TEST_ORG_ID, membershipId: 'member-1', role: 'owner',
});
const scope = {workspaceId: TEST_ORG_ID, userId: 'test-user'};
const restore = (ctx, body, extra = {}) => invoke(routes, {
  method: 'POST', path: '/api/snapshots/restore', body, ctx, requestContext, ...extra,
});

describe('POST /api/snapshots/restore', () => {
  it('rate limits before reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; }});
    const response = await restore(ctx, undefined);
    assert.equal(response.status, 429);
    assert.equal(reads, 0);
  });

  it('validates the path and snapshot id', async () => {
    const ctx = makeCtx();
    assert.equal((await restore(ctx, {path: '../bad', snapshotId: 's1'})).status, 400);
    assert.deepEqual((await restore(ctx, {path: 'a.md'})).payload, {error: 'snapshotId is required'});
  });

  it('returns 404 before reading snapshots when the document is absent', async () => {
    const ctx = makeCtx();
    const response = await restore(ctx, {path: 'a.md', snapshotId: 's1'});
    assert.deepEqual([response.status, response.payload], [404, {error: 'File not found'}]);
  });

  it('returns 404 when the named snapshot is absent', async () => {
    const ctx = makeCtx();
    ctx.documents.create(scope, {path: 'a.md', markdown: 'current'});
    const response = await restore(ctx, {path: 'a.md', snapshotId: 'missing'});
    assert.deepEqual([response.status, response.payload], [404, {error: 'Snapshot not found'}]);
  });

  it('restores through the document service and preserves the replaced body as history', async () => {
    const ctx = makeCtx();
    ctx.documents.create(scope, {path: 'a.md', markdown: 'current'});
    ctx.collection('snapshots').put(scope, 'a.md', [
      {id: 's1', name: 'first', content: 'FIRST'},
      {id: 's2', name: 'second', content: 'SECOND'},
    ]);
    const response = await restore(ctx, {path: 'a.md', snapshotId: 's2'});
    assert.deepEqual([response.status, response.payload], [200, {success: true, restored: {id: 's2', name: 'second'}}]);
    assert.equal(ctx.documents.get(scope, 'a.md').markdown, 'SECOND');
    assert.equal(ctx.documents.version(scope, 'a.md', 1).markdown, 'current');
    assert.deepEqual(ctx.calls.invalidateCache, [key('')]);
  });

  it('allows readers to inspect snapshots but only editors to restore them', async () => {
    const ctx = makeCtx();
    ctx.documents.create(scope, {path: 'a.md', markdown: 'current'});
    ctx.collection('snapshots').put(scope, 'a.md', [{id: 's1', name: 'first', content: 'FIRST'}]);
    const viewer = {...requestContext, role: 'viewer'};
    const response = await restore(ctx, {path: 'a.md', snapshotId: 's1'}, {requestContext: viewer});
    assert.equal(response.status, 403);
    assert.equal(ctx.documents.get(scope, 'a.md').markdown, 'current');
  });

  it('returns 400 for malformed JSON', async () => {
    const ctx = makeCtx({readBody: async () => { throw new Error('bad json'); }});
    const response = await restore(ctx, undefined);
    assert.deepEqual([response.status, response.payload], [400, {error: 'Invalid request'}]);
  });
});
