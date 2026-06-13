import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// bookmarks-reading-lists.js is CommonJS; load the REAL route module the way the
// other server route tests do, so these cases exercise the shipped handler
// instead of a reimplementation.
const require = createRequire(import.meta.url);
const readingListRoutes = require('../server/routes/bookmarks-reading-lists.js');

// Drive the PATCH /api/reading-lists/:id/items reorder handler with a minimal
// mocked ctx. Every guard returns before the single saveJSON, and the handler's
// loadJSON/saveJSON are supplied by ctx, so an in-memory store plus a few
// recorders are enough and no real filesystem read or write happens. The reorder
// branch only touches json, readBody, loadJSON, saveJSON, and READING_LISTS_FILE;
// the rest of the ctx shape rounds out what server.js passes.
//
// `makeStore` builds a fresh document on every call, so no case can pollute
// another through shared mutable state. updatedAt seeds to a fixed past sentinel
// so a real clock bump is observable as "value changed" without pinning the
// clock itself.
const SENTINEL_TS = '2000-01-01T00:00:00.000Z';

function makeStore(itemPaths, { listId = 'list-1', updatedAt = SENTINEL_TS } = {}) {
  return {
    lists: [
      {
        id: listId,
        name: 'My List',
        description: '',
        items: itemPaths.map((p) => ({
          path: p,
          title: `Title ${p}`,
          type: 'doc',
          addedAt: SENTINEL_TS,
        })),
        createdAt: SENTINEL_TS,
        updatedAt,
      },
    ],
  };
}

async function invoke({ listId = 'list-1', body = {}, data = { lists: [] } } = {}) {
  const pathname = `/api/reading-lists/${listId}/items`;
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'PATCH', socket: { remoteAddress: '127.0.0.1' } };
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
    loadJSON: () => data,
    saveJSON: (_file, d) => { saved = d; saveCount += 1; },
    rateLimit: () => true,
    readBody: async () => { readBodyCount += 1; return body; },
    sanitizeText: (s) => s,
    path,
    PROJECT_ROOT: '/tmp/reading-list-reorder-root',
    READING_LISTS_FILE: '/tmp/reading-list-reorder-test.json',
  };
  await readingListRoutes(req, res, url, pathname, ctx);
  return { captured, saved, saveCount, readBodyCount };
}

const paths = (list) => list.items.map((item) => item.path);

describe('PATCH /api/reading-lists/:id/items reorder guards (current behavior)', () => {
  it('returns 400 when path is omitted, with no save', async () => {
    const { captured, saveCount } = await invoke({
      body: { direction: 'up' },
      data: makeStore(['a', 'b']),
    });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing path');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when path is an empty string, with no save', async () => {
    const { captured, saveCount } = await invoke({
      body: { path: '', direction: 'up' },
      data: makeStore(['a', 'b']),
    });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing path');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when path is a non-string, with no save', async () => {
    const { captured, saveCount } = await invoke({
      body: { path: 42, direction: 'up' },
      data: makeStore(['a', 'b']),
    });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing path');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when direction is omitted, with no save', async () => {
    // The path guard passes first, so a valid path reaches the direction check.
    const { captured, saveCount } = await invoke({
      body: { path: 'a' },
      data: makeStore(['a', 'b']),
    });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'direction must be "up" or "down"');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when direction is neither up nor down, with no save', async () => {
    const { captured, saveCount } = await invoke({
      body: { path: 'a', direction: 'sideways' },
      data: makeStore(['a', 'b']),
    });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'direction must be "up" or "down"');
    assert.equal(saveCount, 0);
  });

  it('returns 404 when the list id is unknown, with no save', async () => {
    const { captured, saveCount } = await invoke({
      listId: 'does-not-exist',
      body: { path: 'a', direction: 'up' },
      data: makeStore(['a', 'b']),
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Reading list not found');
    assert.equal(saveCount, 0);
  });

  it('returns 404 when the item path is absent from the list, with no save', async () => {
    const { captured, saveCount } = await invoke({
      body: { path: 'missing-item', direction: 'up' },
      data: makeStore(['a', 'b']),
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Item not found in list');
    assert.equal(saveCount, 0);
  });

  it('boundary no-op: moving the first item up returns 200 with the list unchanged and no save', async () => {
    const { captured, saveCount } = await invoke({
      body: { path: 'a', direction: 'up' },
      data: makeStore(['a', 'b', 'c']),
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.deepEqual(paths(captured.payload.list), ['a', 'b', 'c']);
    // Boundary returns before the save and before the updatedAt assignment.
    assert.equal(captured.payload.list.updatedAt, SENTINEL_TS);
    assert.equal(saveCount, 0);
  });

  it('boundary no-op: moving the last item down returns 200 with the list unchanged and no save', async () => {
    const { captured, saveCount } = await invoke({
      body: { path: 'c', direction: 'down' },
      data: makeStore(['a', 'b', 'c']),
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.deepEqual(paths(captured.payload.list), ['a', 'b', 'c']);
    assert.equal(captured.payload.list.updatedAt, SENTINEL_TS);
    assert.equal(saveCount, 0);
  });

  it('valid swap down reorders the pair, bumps updatedAt, and saves exactly once', async () => {
    const { captured, saved, saveCount, readBodyCount } = await invoke({
      body: { path: 'a', direction: 'down' },
      data: makeStore(['a', 'b', 'c']),
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.deepEqual(paths(captured.payload.list), ['b', 'a', 'c']);
    // updatedAt is bumped to a fresh clock value; pin that it changed and is a
    // string, never the value itself.
    assert.notEqual(captured.payload.list.updatedAt, SENTINEL_TS);
    assert.equal(typeof captured.payload.list.updatedAt, 'string');
    assert.equal(saveCount, 1);
    assert.equal(readBodyCount, 1);
    // The persisted document is the same in-memory store, now reordered.
    assert.deepEqual(paths(saved.lists[0]), ['b', 'a', 'c']);
  });

  it('valid swap up reorders the pair, bumps updatedAt, and saves exactly once', async () => {
    const { captured, saved, saveCount } = await invoke({
      body: { path: 'c', direction: 'up' },
      data: makeStore(['a', 'b', 'c']),
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.deepEqual(paths(captured.payload.list), ['a', 'c', 'b']);
    assert.notEqual(captured.payload.list.updatedAt, SENTINEL_TS);
    assert.equal(typeof captured.payload.list.updatedAt, 'string');
    assert.equal(saveCount, 1);
    assert.deepEqual(paths(saved.lists[0]), ['a', 'c', 'b']);
  });
});
