import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';
import {migratedDatabase} from './_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresFs} = require('../../../../src/server/fs/store.js');
const {createFsDocuments} = require('../../../../src/server/fs/documents.js');
const {createFsAssetStore} = require('../../../../src/server/fs/assets.js');

const member = (userId, role) => Object.freeze({userId, workspaceId: 'lab', membershipId: `m-${userId}`, role});
const alice = member('alice', 'owner');
const bob = member('bob', 'editor');
const vic = member('vic', 'viewer');

describe('file system API', () => {
  let db;
  let fs;
  let ctx;
  const fsRoutes = loadRoute('fs');
  const call = (options) => invoke(fsRoutes, {ctx, ...options});

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    fs = createPostgresFs({pool: database.pool});
    ctx = makeCtx({workspaceFs: fs});
  });
  after(() => db?.close());

  it('writes, lists, and serves a file with its revision as the ETag', async () => {
    const written = await call({method: 'PUT', path: '/api/fs/file', query: {path: 'notes/a.md', baseRev: 0},
      body: '# A', requestContext: bob});
    assert.equal(written.status, 200);
    const tree = await call({path: '/api/fs/tree', requestContext: vic});
    assert.deepEqual(tree.payload.nodes.map(node => node.path), ['notes', 'notes/a.md']);
    const served = await call({path: '/api/fs/file', query: {path: 'notes/a.md'}, requestContext: vic});
    assert.equal(served.written.status, 200);
    assert.equal(served.written.body.toString(), '# A');
    assert.equal(served.written.headers.ETag, `"${written.payload.node.rev}"`);
  });

  it('answers a stale write with 409 and the current revision', async () => {
    const stale = await call({method: 'PUT', path: '/api/fs/file', query: {path: 'notes/a.md', baseRev: 1},
      body: 'old', requestContext: bob});
    assert.equal(stale.status, 409);
    assert.equal(stale.payload.code, 'stale-revision');
    assert.ok(stale.payload.currentRev > 1);
  });

  it('lists a file\'s revisions newest first and serves each one\'s text', async () => {
    await call({method: 'PUT', path: '/api/fs/file', query: {path: 'notes/h.txt', baseRev: 0}, body: 'one', requestContext: bob});
    const second = await call({method: 'PUT', path: '/api/fs/file', query: {path: 'notes/h.txt'}, body: 'two', requestContext: bob});
    const history = await call({path: '/api/fs/history', query: {path: 'notes/h.txt'}, requestContext: vic});
    assert.equal(history.status, 200);
    assert.equal(history.payload.revisions.length, 2);
    assert.equal(history.payload.revisions[0].seq, second.payload.node.rev);
    const first = await call({path: '/api/fs/revision', query: {path: 'notes/h.txt', seq: history.payload.revisions[1].seq}, requestContext: vic});
    assert.equal(first.written.body.toString(), 'one');
    const missing = await call({path: '/api/fs/revision', query: {path: 'notes/h.txt', seq: 0}, requestContext: vic});
    assert.equal(missing.status, 404);
  });

  it('refuses writes from a viewer and deletes from an editor', async () => {
    const write = await call({method: 'PUT', path: '/api/fs/file', query: {path: 'notes/v.md'}, body: 'v', requestContext: vic});
    assert.equal(write.status, 403);
    const remove = await call({method: 'DELETE', path: '/api/fs/node', query: {path: 'notes/a.md'}, requestContext: bob});
    assert.equal(remove.status, 403);
  });

  it('publishes a folder only for someone allowed to publish', async () => {
    const denied = await call({method: 'PUT', path: '/api/fs/access', body: {path: 'notes', access: 'public'}, requestContext: vic});
    assert.equal(denied.status, 403);
    const published = await call({method: 'PUT', path: '/api/fs/access', body: {path: 'notes', access: 'public'}, requestContext: bob});
    assert.equal(published.payload.node.access, 'public');
  });

  it('follows the change feed from a cursor', async () => {
    const all = await call({path: '/api/fs/changes', requestContext: alice});
    const later = await call({path: '/api/fs/changes', query: {since: all.payload.cursor}, requestContext: alice});
    assert.deepEqual(later.payload.changes, []);
  });

  it('says clearly when the server has no file system', async () => {
    const legacy = await invoke(fsRoutes, {ctx: makeCtx(), path: '/api/fs/tree', requestContext: alice});
    assert.equal(legacy.status, 409);
    assert.equal(legacy.payload.code, 'fs-disabled');
  });
});

describe('documents and assets served from the file system', () => {
  let db;
  let ctx;
  const content = loadRoute('content');
  const assets = loadRoute('assets');

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    const fs = createPostgresFs({pool: database.pool});
    ctx = makeCtx({documents: createFsDocuments({fs}), assetStore: createFsAssetStore({fs}), workspaceFs: fs});
  });
  after(() => db?.close());

  const at = (path, requestContext = alice) => invoke(content, {
    path: '/api/workspaces/lab/documents', query: {path}, ctx, requestContext,
  });

  it('creates, renders, saves, and refuses a stale save', async () => {
    const created = await invoke(content, {method: 'POST', path: '/api/workspaces/lab/documents',
      body: {path: 'books/intro.md', markdown: '---\ntitle: Intro\n---\nHello'}, ctx, requestContext: bob});
    assert.equal(created.status, 201);
    const read = await at('books/intro');
    assert.equal(read.status, 200);
    assert.equal(read.payload.document.title, 'Intro');
    assert.match(JSON.stringify(read.payload.tree), /Hello/);

    const saved = await invoke(content, {method: 'PUT', path: '/api/workspaces/lab/documents', ctx, requestContext: bob,
      body: {path: 'books/intro.md', markdown: 'Hello again', baseUpdatedAt: read.payload.document.updatedAt}});
    assert.equal(saved.status, 200);
    const stale = await invoke(content, {method: 'PUT', path: '/api/workspaces/lab/documents', ctx, requestContext: bob,
      body: {path: 'books/intro.md', markdown: 'lost', baseUpdatedAt: '2000-01-01T00:00:00.000Z'}});
    assert.equal(stale.status, 409);
    assert.equal(stale.payload.code, 'document-conflict');
  });

  it('lists the tree, keeps versions, moves, and deletes', async () => {
    const tree = await invoke(content, {path: '/api/workspaces/lab/documents/tree', ctx, requestContext: vic});
    assert.deepEqual(tree.payload.documents.map(document => document.path), ['books/intro.md']);
    const versions = await invoke(content, {path: '/api/workspaces/lab/documents/versions', query: {path: 'books/intro.md'},
      ctx, requestContext: alice});
    assert.equal(versions.payload.versions.length, 2);
    const oldest = await invoke(content, {path: '/api/workspaces/lab/documents/versions',
      query: {path: 'books/intro.md', seq: versions.payload.versions.at(-1).seq}, ctx, requestContext: alice});
    assert.match(oldest.payload.version.markdown, /title: Intro/);

    const moved = await invoke(content, {method: 'POST', path: '/api/workspaces/lab/documents/move',
      body: {from: 'books/intro.md', to: 'books/start.md'}, ctx, requestContext: bob});
    assert.equal(moved.status, 200);
    assert.ok(moved.payload.document.updatedAt);
    const gone = await invoke(content, {method: 'DELETE', path: '/api/workspaces/lab/documents',
      body: {path: 'books/start.md'}, ctx, requestContext: alice});
    assert.equal(gone.status, 200);
    assert.equal((await at('books/start')).status, 404);
  });

  it('keeps a private document from other members', async () => {
    await invoke(content, {method: 'POST', path: '/api/workspaces/lab/documents',
      body: {path: 'drafts/mine.md', markdown: 'mine', visibility: 'private'}, ctx, requestContext: bob});
    assert.equal((await at('drafts/mine', alice)).status, 404);
    assert.equal((await at('drafts/mine', bob)).status, 200);
  });

  it('uploads and serves assets as files', async () => {
    const uploaded = await invoke(assets, {method: 'PUT', path: '/api/workspaces/lab/assets',
      query: {path: 'books/assets/plot.png'}, body: 'png bytes', ctx, requestContext: bob});
    assert.equal(uploaded.status, 200);
    const listed = await invoke(assets, {path: '/api/workspaces/lab/assets', ctx, requestContext: vic});
    assert.deepEqual(listed.payload.assets.map(asset => asset.path), ['books/assets/plot.png']);
    const served = await invoke(assets, {path: '/api/workspaces/lab/assets', query: {path: 'books/assets/plot.png'},
      ctx, requestContext: vic});
    assert.equal(served.written.body.toString(), 'png bytes');
  });
});
