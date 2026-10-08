import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke, TEST_ORG_ID, key} from '../../../_harness.mjs';

const routes = loadRoute('misc-tools');
const requestContext = Object.freeze({
  userId: 'test-user', workspaceId: TEST_ORG_ID, membershipId: 'member-1', role: 'owner',
});
const scope = {workspaceId: TEST_ORG_ID, userId: 'test-user'};

function quickNote(title, body) {
  return [
    '---', `slug: ${title}`, `title: "${title}"`, 'authors: [zeyu]',
    'tags: [quick-note]', 'draft: true', '---', '', body, '',
  ].join('\n');
}

function makeCountingCache() {
  const store = {};
  const runs = {};
  const ttls = {};
  const cached = (cacheKey, ttl, compute) => {
    ttls[cacheKey] = ttl;
    if (store[cacheKey]) return store[cacheKey];
    runs[cacheKey] = (runs[cacheKey] ?? 0) + 1;
    return (store[cacheKey] = compute());
  };
  return Object.assign(cached, {runs, ttls});
}

function configureQuickNotes(ctx, path = 'posts/blog') {
  ctx.workspaceSettings.update(requestContext, {
    collections: [{key: 'notes', type: 'blog', pathPrefix: path, title: 'Notes'}],
  });
  return ctx;
}

const get = (ctx) => invoke(routes, {path: '/api/quicknote', ctx, requestContext});

describe('GET /api/quicknote cached database scan', () => {
  it('filters quick notes, sorts newest first, and caps the result at ten', async () => {
    const ctx = configureQuickNotes(makeCtx());
    for (let day = 1; day <= 12; day++) {
      const value = String(day).padStart(2, '0');
      ctx.documents.create(scope, {
        path: `posts/blog/2026-01-${value}-note.md`,
        markdown: quickNote(`Note 2026-01-${value}`, `Body ${value}`),
      });
    }
    ctx.documents.create(scope, {path: 'posts/blog/2026-01-20-essay.md', markdown: '---\ntags: [essay]\n---\nbody'});
    const response = await get(ctx);
    assert.equal(response.status, 200);
    assert.equal(response.payload.notes.length, 10);
    assert.equal(response.payload.notes[0].filename, '2026-01-12-note.md');
    assert.equal(response.payload.notes[9].filename, '2026-01-03-note.md');
    assert.equal(response.payload.notes.some(note => note.filename.includes('essay')), false);
  });

  it('memoizes the database-derived payload for sixty seconds', async () => {
    const cached = makeCountingCache();
    const ctx = configureQuickNotes(makeCtx({cached}));
    ctx.documents.create(scope, {path: 'posts/blog/2026-01-01-note.md', markdown: quickNote('One', 'Body')});
    const first = await get(ctx);
    ctx.documents.create(scope, {path: 'posts/blog/2026-01-02-note.md', markdown: quickNote('Two', 'Body')});
    const second = await get(ctx);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(cached.runs[key('quicknote-list')], 1);
    assert.equal(cached.ttls[key('quicknote-list')], 60000);
  });

  it('returns an empty result for a workspace with no quick-note documents', async () => {
    const response = await get(configureQuickNotes(makeCtx()));
    assert.deepEqual([response.status, response.payload], [200, {notes: [], total: 0}]);
  });

  it('does not cache a failed database scan', async () => {
    let runs = 0;
    const cached = (_key, _ttl, compute) => { runs++; return compute(); };
    const ctx = configureQuickNotes(makeCtx({cached, documents: {list() { throw new Error('database unavailable'); }}}));
    assert.deepEqual((await get(ctx)).payload, {notes: [], total: 0});
    assert.deepEqual((await get(ctx)).payload, {notes: [], total: 0});
    assert.equal(runs, 2);
  });

  it('uses an arbitrary workspace-configured blog path', async () => {
    const ctx = configureQuickNotes(makeCtx(), 'journal');
    ctx.documents.create(scope, {path: 'journal/2026-01-02-note.md', markdown: quickNote('Journal', 'Body')});
    ctx.documents.create(scope, {path: 'posts/blog/2026-01-03-note.md', markdown: quickNote('Other', 'Body')});
    const response = await get(ctx);
    assert.deepEqual(response.payload.notes.map(note => note.path), ['journal/2026-01-02-note.md']);
  });
});
