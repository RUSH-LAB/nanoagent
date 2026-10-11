/** Database content isolation through the canonical document API. */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';
import {isValidFilePath, resolveContentPath} from '../../../../src/server/server-utils.js';

const content = loadRoute('content');
const context = (workspaceId, userId = 'user-1', role = 'owner') =>
  Object.freeze({workspaceId, userId, membershipId: `${workspaceId}:${userId}`, role});
const callContent = (ctx, workspaceId, options) => invoke(content, {
  ...options,
  ctx,
  auth: {userId: 'user-1', orgId: 'stale-session-workspace'},
  requestContext: context(workspaceId),
});
const scope = workspaceId => ({workspaceId, userId: 'user-1'});

describe('two workspaces with the same document path', () => {
  it('read their own rows even when the session active workspace is stale', async () => {
    const ctx = makeCtx();
    ctx.documents.create(scope('mochi'), {path: 'books/math/0-intro.md', markdown: '# Mochi Lab maths'});
    ctx.documents.create(scope('hello'), {path: 'books/math/0-intro.md', markdown: '# Hello World maths'});

    const query = {path: 'books/math/0-intro.md'};
    const mochi = await callContent(ctx, 'mochi', {path: '/api/content/source', query});
    const hello = await callContent(ctx, 'hello', {path: '/api/content/source', query});

    assert.equal(mochi.payload.markdown, '# Mochi Lab maths');
    assert.equal(hello.payload.markdown, '# Hello World maths');
  });

  it('a write and delete in one workspace cannot affect the other', async () => {
    const ctx = makeCtx();
    const path = 'books/math/0-intro.md';
    ctx.documents.create(scope('mochi'), {path, markdown: 'mochi'});
    ctx.documents.create(scope('hello'), {path, markdown: 'hello'});

    const wrote = await callContent(ctx, 'hello', {method: 'PUT', path: '/api/content', body: {path, markdown: 'updated'}});
    assert.equal(wrote.status, 200);
    assert.equal(ctx.documents.get(scope('hello'), path).markdown, 'updated');
    assert.equal(ctx.documents.get(scope('mochi'), path).markdown, 'mochi');

    const deleted = await callContent(ctx, 'hello', {method: 'DELETE', path: '/api/content', body: {path}});
    assert.equal(deleted.status, 200);
    assert.equal(ctx.documents.get(scope('hello'), path), undefined);
    assert.equal(ctx.documents.get(scope('mochi'), path).markdown, 'mochi');
  });

  it('an empty workspace lists nothing while another lists relative paths', async () => {
    const ctx = makeCtx({cacheKey: (workspaceId, name) => `workspace:${workspaceId}:${name}`});
    ctx.documents.create(scope('mochi'), {path: 'books/math/0-intro.md', markdown: 'mochi'});
    ctx.documents.create(scope('mochi'), {path: 'posts/blog/hello.md', markdown: 'blog'});

    const mochi = await callContent(ctx, 'mochi', {path: '/api/content/tree'});
    const hello = await callContent(ctx, 'hello', {path: '/api/content/tree'});
    const paths = mochi.payload.documents.map(item => item.path);
    assert.deepEqual(paths, ['books/math/0-intro.md', 'posts/blog/hello.md']);
    assert.deepEqual(hello.payload.documents, []);
    assert.ok(paths.includes('books/math/0-intro.md'));
    assert.equal(paths.some(value => value.startsWith('content/')), false);
  });
});

describe('naming another workspace', () => {
  for (const attempt of [
    '../hello/books/math/0-intro.md',
    '../../content/hello/books/math/0-intro.md',
    'books/../../hello/books/math/0-intro.md',
    '/fake/root/content/hello/books/math/0-intro.md',
    './../hello/books/math/0-intro.md',
  ]) {
    it(`refuses ${attempt} before a document lookup`, async () => {
      const ctx = makeCtx();
      const response = await callContent(ctx, 'mochi', {path: '/api/content/source', query: {path: attempt}});
      assert.deepEqual([response.status, response.payload], [400, {error: 'Invalid path'}]);
    });
  }

  it('refuses an escaping write and leaves the other workspace untouched', async () => {
    const ctx = makeCtx();
    ctx.documents.create(scope('hello'), {path: 'books/math/0-intro.md', markdown: 'safe'});
    const response = await callContent(ctx, 'mochi', {
      method: 'PUT', path: '/api/content',
      body: {path: '../hello/books/math/0-intro.md', markdown: 'stolen'},
    });
    assert.equal(response.status, 400);
    assert.equal(ctx.documents.get(scope('hello'), 'books/math/0-intro.md').markdown, 'safe');
  });
});

describe('document path guards', () => {
  const root = '/fake/root/content/mochi';
  for (const escape of ['../hello/x.md', 'a/../../b.md', '/etc/passwd']) {
    it(`rejects ${escape} before a repository lookup`, () => {
      assert.equal(isValidFilePath(escape), false);
      assert.equal(resolveContentPath(root, escape), null);
    });
  }

  it('accepts an ordinary relative path', () => {
    assert.equal(isValidFilePath('books/math/0-intro.md'), true);
    assert.equal(resolveContentPath(root, 'books/math/0-intro.md'), path.join(root, 'books/math/0-intro.md'));
  });
});
