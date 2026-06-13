import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// bookmarks-reading-lists.js is CommonJS; load the REAL route module the way the
// sibling reading-list tests do, so these cases exercise the shipped handlers
// instead of a reimplementation.
const require = createRequire(import.meta.url);
const readingListRoutes = require('../server/routes/bookmarks-reading-lists.js');

// This file pins three reading-list handlers that were previously untested:
//   GET    /api/reading-lists/stats   (aggregate counts plus top paths)
//   DELETE /api/reading-lists/:id      (standalone list delete, NOT the /items sub-route)
//   GET    /api/reading-lists          (list all)
//
// Each one only reads the store or splices a list in memory: it touches json,
// loadJSON, and saveJSON through ctx and never reaches a real filesystem,
// network, or git. A mocked ctx with an in-memory document plus a save recorder
// pins their current behavior end to end. None of the three reads a clock,
// random, or network, so every asserted value is deterministic.
//
// Timestamps seed to a fixed past sentinel; these handlers never bump them, so
// the value simply rounds out a realistic stored shape.
const SENTINEL_TS = '2000-01-01T00:00:00.000Z';

function mkItem(itemPath, type = 'doc') {
  return { path: itemPath, title: `Title ${itemPath}`, type, addedAt: SENTINEL_TS };
}

function mkList(id, items = []) {
  return {
    id,
    name: `Name ${id}`,
    description: '',
    items,
    createdAt: SENTINEL_TS,
    updatedAt: SENTINEL_TS,
  };
}

// Build a mocked ctx, dispatch the real route module by method plus pathname,
// and report what the handler captured. `loadThrows` forces loadJSON to throw so
// the delete handler's catch branch is observable.
async function invoke({ method = 'GET', pathname, body = {}, data = {}, loadThrows = false } = {}) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saved = null;
  let saveCount = 0;
  let readBodyCount = 0;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    loadJSON: () => {
      if (loadThrows) throw new Error('load failed');
      return data;
    },
    saveJSON: (_file, d) => { saved = d; saveCount += 1; },
    rateLimit: () => true,
    readBody: async () => { readBodyCount += 1; return body; },
    sanitizeText: (s) => s,
    path,
    PROJECT_ROOT: '/tmp/reading-list-stats-delete-root',
    READING_LISTS_FILE: '/tmp/reading-list-stats-delete-test.json',
  };
  await readingListRoutes(req, res, url, pathname, ctx);
  return { captured, saved, saveCount, readBodyCount, data };
}

describe('GET /api/reading-lists/stats (current behavior)', () => {
  it('aggregates totals, splits reference vs doc, and ranks popularItems by count', async () => {
    const data = {
      lists: [
        mkList('list-a', [mkItem('doc/intro'), mkItem('doc/intro'), mkItem('ref/paper1', 'reference')]),
        mkList('list-b', [mkItem('doc/intro'), mkItem('ref/paper1', 'reference'), mkItem('doc/advanced', 'guide')]),
      ],
    };
    const { captured, saveCount } = await invoke({ method: 'GET', pathname: '/api/reading-lists/stats', data });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.totalLists, 2);
    assert.equal(captured.payload.totalItems, 6);
    // Only type === 'reference' counts as a reference; every other type (doc,
    // guide, and so on) falls into docItems.
    assert.equal(captured.payload.referenceItems, 2);
    assert.equal(captured.payload.docItems, 4);
    // doc/intro appears 3 times, ref/paper1 twice, doc/advanced once, sorted by
    // descending count.
    assert.deepEqual(captured.payload.popularItems, [
      { path: 'doc/intro', count: 3 },
      { path: 'ref/paper1', count: 2 },
      { path: 'doc/advanced', count: 1 },
    ]);
    // A read only handler never saves.
    assert.equal(saveCount, 0);
  });

  it('empty store (no lists key) yields zeroed counts and empty popularItems', async () => {
    const { captured, saveCount } = await invoke({ method: 'GET', pathname: '/api/reading-lists/stats', data: {} });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, {
      totalLists: 0,
      totalItems: 0,
      docItems: 0,
      referenceItems: 0,
      popularItems: [],
    });
    assert.equal(saveCount, 0);
  });

  it('a list with no items array contributes nothing (the items || [] fallback)', async () => {
    const data = { lists: [{ id: 'list-a', name: 'A' }] };
    const { captured } = await invoke({ method: 'GET', pathname: '/api/reading-lists/stats', data });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.totalLists, 1);
    assert.equal(captured.payload.totalItems, 0);
    assert.equal(captured.payload.docItems, 0);
    assert.equal(captured.payload.referenceItems, 0);
    assert.deepEqual(captured.payload.popularItems, []);
  });

  it('popularItems keeps only the top 10 paths by count', async () => {
    // Path p01 appears 12 times, p02 11 times, down to p12 once. The top 10 by
    // count are p01 through p10 (counts 12 down to 3); p11 and p12 are dropped by
    // slice(0, 10).
    const items = [];
    for (let i = 1; i <= 12; i++) {
      const count = 13 - i;
      const p = `p${String(i).padStart(2, '0')}`;
      for (let k = 0; k < count; k++) items.push(mkItem(p));
    }
    const data = { lists: [mkList('big', items)] };
    const { captured } = await invoke({ method: 'GET', pathname: '/api/reading-lists/stats', data });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.popularItems.length, 10);
    const expected = [];
    for (let i = 1; i <= 10; i++) {
      expected.push({ path: `p${String(i).padStart(2, '0')}`, count: 13 - i });
    }
    assert.deepEqual(captured.payload.popularItems, expected);
    // totalItems is the sum 1 through 12 = 78; every item is a doc.
    assert.equal(captured.payload.totalItems, 78);
    assert.equal(captured.payload.docItems, 78);
    assert.equal(captured.payload.referenceItems, 0);
  });
});

describe('DELETE /api/reading-lists/:id standalone (current behavior)', () => {
  it('unknown id yields 404 Reading list not found with no save', async () => {
    const data = { lists: [mkList('keep-me')] };
    const { captured, saveCount } = await invoke({
      method: 'DELETE',
      pathname: '/api/reading-lists/missing',
      data,
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Reading list not found');
    assert.equal(saveCount, 0);
    // The store is untouched.
    assert.equal(data.lists.length, 1);
  });

  it('existing id splices the list, saves once, and returns success', async () => {
    const data = { lists: [mkList('list-1'), mkList('list-2')] };
    const { captured, saved, saveCount } = await invoke({
      method: 'DELETE',
      pathname: '/api/reading-lists/list-1',
      data,
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(saveCount, 1);
    // list-1 is gone, list-2 remains, and the persisted document is the store.
    assert.equal(saved, data);
    assert.deepEqual(data.lists.map((l) => l.id), ['list-2']);
  });

  it('a /items path is not handled by the standalone delete (dispatch guard)', async () => {
    // READING_LIST_RE does not match a trailing /items segment, so a DELETE to
    // .../items falls through to the remove-item handler, which reports its own
    // 404. Had the standalone delete fired, it would have returned
    // { success: true } and spliced the whole list.
    const data = { lists: [mkList('list-1', [mkItem('doc/keep')])] };
    const { captured, saveCount } = await invoke({
      method: 'DELETE',
      pathname: '/api/reading-lists/list-1/items',
      body: { path: 'doc/not-present' },
      data,
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Item not found in list');
    assert.equal(saveCount, 0);
    // The list itself was never removed.
    assert.deepEqual(data.lists.map((l) => l.id), ['list-1']);
  });

  it('a loadJSON failure is caught and returns 400 Invalid request', async () => {
    const { captured, saveCount } = await invoke({
      method: 'DELETE',
      pathname: '/api/reading-lists/list-1',
      loadThrows: true,
    });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Invalid request');
    assert.equal(saveCount, 0);
  });
});

describe('GET /api/reading-lists list all (current behavior)', () => {
  it('returns the stored lists verbatim', async () => {
    const data = { lists: [mkList('list-1'), mkList('list-2')] };
    const { captured, saveCount } = await invoke({ method: 'GET', pathname: '/api/reading-lists', data });
    assert.equal(captured.status, 200);
    // The handler returns the stored array by reference under the lists key.
    assert.equal(captured.payload.lists, data.lists);
    assert.deepEqual(captured.payload.lists.map((l) => l.id), ['list-1', 'list-2']);
    assert.equal(saveCount, 0);
  });

  it('falls back to an empty array when the store lacks a lists key', async () => {
    const { captured, saveCount } = await invoke({ method: 'GET', pathname: '/api/reading-lists', data: {} });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload.lists, []);
    assert.equal(saveCount, 0);
  });
});
