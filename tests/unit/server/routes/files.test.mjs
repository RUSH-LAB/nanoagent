/**
 * The legacy file-shaped API is now a compatibility view over document rows.
 * It must preserve old response shapes without touching the content tree.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke, TEST_ORG_ID} from '../../_harness.mjs';

const routes = loadRoute('files');
const ownerContext = Object.freeze({
  userId: 'test-user', workspaceId: TEST_ORG_ID, membershipId: 'member-1', role: 'owner',
});
const viewerContext = Object.freeze({...ownerContext, role: 'viewer'});

const request = options => invoke(routes, {...options, requestContext: options?.requestContext ?? ownerContext});
const seed = (ctx, docs) => {
  const scope = {workspaceId: TEST_ORG_ID, userId: 'test-user'};
  for (const document of docs) ctx.documents.create(scope, document);
};

describe('file compatibility boundary', () => {
  it('refuses an unscoped URL instead of using the session active workspace', async () => {
    const response = await invoke(routes, {path: '/api/file', query: {path: 'a.md'}, ctx: makeCtx()});
    assert.deepEqual([response.status, response.payload], [404, {error: 'Workspace not found'}]);
  });

  it('returns 404 for a document in a different workspace', async () => {
    const ctx = makeCtx();
    ctx.documents.create({workspaceId: 'another-workspace', userId: 'test-user'}, {path: 'secret.md', markdown: 'hidden'});
    const response = await request({path: '/api/file', query: {path: 'secret.md'}, ctx});
    assert.deepEqual([response.status, response.payload], [404, {error: 'File not found'}]);
  });
});

describe('GET /api/file', () => {
  it('validates paths before reading', async () => {
    const response = await request({path: '/api/file', query: {path: '../bad'}, ctx: makeCtx()});
    assert.deepEqual([response.status, response.payload], [400, {error: 'Invalid path'}]);
  });

  it('reads document markdown from the database', async () => {
    const ctx = makeCtx();
    seed(ctx, [{path: 'books/a.md', markdown: '# A'}]);
    const response = await request({path: '/api/file', query: {path: 'books/a.md'}, ctx});
    assert.deepEqual([response.status, response.payload], [200, {content: '# A'}]);
  });
});

describe('retired /api/file mutations', () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    it(`${method} is not handled by the read-only compatibility route`, async () => {
      const ctx = makeCtx();
      seed(ctx, [{path: 'a.md', markdown: 'one'}]);
      const response = await request({method, path: '/api/file', body: {path: 'a.md', content: 'two'}, ctx});
      assert.equal(response.status, undefined);
      assert.equal(ctx.documents.get({workspaceId: TEST_ORG_ID, userId: 'test-user'}, 'a.md').markdown, 'one');
    });
  }
});

describe('GET /api/files', () => {
  it('builds the old nested tree shape from document rows', async () => {
    const ctx = makeCtx();
    seed(ctx, [
      {path: 'root.md', markdown: 'root'},
      {path: 'books/math/a.md', markdown: 'a'},
      {path: 'books/math/b.mdx', markdown: 'b'},
    ]);
    const response = await request({path: '/api/files', ctx});
    assert.equal(response.status, 200);
    assert.equal(response.payload.files[0].path, 'books');
    assert.equal(response.payload.files[0].children[0].children.length, 2);
    assert.equal(response.payload.files[1].path, 'root.md');
  });

  it('lists a subtree and returns 404 for a missing directory', async () => {
    const ctx = makeCtx();
    seed(ctx, [{path: 'books/a.md', markdown: 'a'}]);
    const found = await request({path: '/api/files', query: {dir: 'books'}, ctx});
    assert.deepEqual(found.payload.files.map(file => file.path), ['books/a.md']);
    const missing = await request({path: '/api/files', query: {dir: 'missing'}, ctx});
    assert.equal(missing.status, 404);
  });
});

describe('GET /api/files/search', () => {
  it('searches path and derived title without reading the filesystem', async () => {
    const ctx = makeCtx();
    seed(ctx, [
      {path: 'notes/alpha.md', markdown: '---\ntitle: Special Result\n---\nbody'},
      {path: 'notes/beta.md', markdown: 'body'},
    ]);
    const byTitle = await request({path: '/api/files/search', query: {q: 'special'}, ctx});
    assert.deepEqual(byTitle.payload.files.map(file => file.path), ['notes/alpha.md']);
    const all = await request({path: '/api/files/search', query: {q: ''}, ctx});
    assert.equal(all.payload.files.length, 2);
  });
});

describe('GET /api/stats', () => {
  it('counts document rows, words, directories, and scoped references', async () => {
    const ctx = makeCtx();
    seed(ctx, [
      {path: 'books/a.md', markdown: 'one two three'},
      {path: 'root.md', markdown: 'four'},
    ]);
    ctx.collection('plugin:bibliography:papers').put({workspaceId: TEST_ORG_ID, userId: 'test-user'}, 'ref-1', {title: 'Paper'});
    const response = await request({path: '/api/stats', ctx});
    assert.equal(response.status, 200);
    assert.deepEqual(response.payload, {
      totalFiles: 2,
      totalWords: 4,
      references: 1,
      byDirectory: {books: {files: 1, words: 3}, '(root)': {files: 1, words: 1}},
    });
    assert.equal(response.replies[0].opts.cacheControl, 'private, max-age=30');
  });
});

describe('tree helpers', () => {
  it('export deterministic pure helpers for nested compatibility responses', () => {
    const tree = routes.documentTree([
      {path: 'a/b.md', updatedAt: '2026-08-31T00:00:00.000Z'},
      {path: 'c.md', updatedAt: 'invalid'},
    ]);
    assert.deepEqual(routes.directoryContents(tree, 'a').map(item => item.path), ['a/b.md']);
    assert.equal(tree[1].mtime, 0);
  });
});
