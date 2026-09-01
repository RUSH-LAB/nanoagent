import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke, TEST_ORG_ID, key} from '../../_harness.mjs';

const routes = loadRoute('content-stats');
const ownerContext = Object.freeze({
  userId: 'test-user', workspaceId: TEST_ORG_ID, membershipId: 'member-1', role: 'owner',
});

describe('GET /api/stats', () => {
  it('counts one scoped snapshot and scopes the cache by workspace and user', async () => {
    const ctx = makeCtx();
    const scope = {workspaceId: TEST_ORG_ID, userId: 'test-user'};
    ctx.documents.create(scope, {path: 'books/a.md', markdown: 'one two three'});
    ctx.documents.create(scope, {path: 'root.md', markdown: 'four'});
    ctx.collection('plugin:bibliography:papers').put(scope, 'ref-1', {title: 'Paper'});

    const response = await invoke(routes, {
      path: '/api/stats', ctx, requestContext: ownerContext,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.payload, {
      totalFiles: 2,
      totalWords: 4,
      references: 1,
      byDirectory: {books: {files: 1, words: 3}, '(root)': {files: 1, words: 1}},
    });
    assert.equal(response.replies[0].opts.cacheControl, 'private, max-age=30');
    assert.ok(ctx.calls.cached.includes(key('content-stats:test-user')));
  });

  it('does not handle retired file-shaped endpoints', async () => {
    for (const path of ['/api/file', '/api/files', '/api/files/search']) {
      const response = await invoke(routes, {path, ctx: makeCtx(), requestContext: ownerContext});
      assert.equal(response.status, undefined, path);
    }
  });
});
