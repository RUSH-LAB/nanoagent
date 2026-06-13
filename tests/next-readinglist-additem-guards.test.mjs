import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// bookmarks-reading-lists.js is CommonJS; load the REAL route module the way the
// sibling reorder test does, so these cases exercise the shipped POST add-item
// handler instead of a reimplementation.
const require = createRequire(import.meta.url);
const readingListRoutes = require('../server/routes/bookmarks-reading-lists.js');

// Drive the POST /api/reading-lists/:id/items add-item handler with a minimal
// mocked ctx. The handler derives listId from the pathname, reads the body, runs
// a short guard ladder, and persists through a single saveJSON, so an in-memory
// store plus a few recorders cover it with no real filesystem, network, or git.
//
// `makeStore` builds a fresh document on every call, so no case can pollute
// another through shared mutable state. updatedAt seeds to a fixed past sentinel
// so a real clock bump is observable as "value changed" without pinning the
// clock itself. sanitizeText is the identity function so the stored title stays
// observable.
const SENTINEL_TS = '2000-01-01T00:00:00.000Z';

function makeList(itemPaths, { id = 'list-1', updatedAt = SENTINEL_TS } = {}) {
  return {
    id,
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
  };
}

function makeStore(itemPaths, opts) {
  return { lists: [makeList(itemPaths, opts)] };
}

async function invoke({ listId = 'list-1', body = {}, data, rateLimitOk = true } = {}) {
  // A fresh empty store per call unless the case supplies its own document.
  const store = data === undefined ? makeStore([]) : data;
  const pathname = `/api/reading-lists/${listId}/items`;
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saved = null;
  let saveCount = 0;
  let readBodyCount = 0;
  let rateLimitKey = null;
  let rateLimitMax = null;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    loadJSON: () => store,
    saveJSON: (_file, d) => { saved = d; saveCount += 1; },
    rateLimit: (key, max) => { rateLimitKey = key; rateLimitMax = max; return rateLimitOk; },
    readBody: async () => { readBodyCount += 1; return body; },
    sanitizeText: (s) => s,
    path,
    PROJECT_ROOT: '/tmp/reading-list-additem-root',
    READING_LISTS_FILE: '/tmp/reading-list-additem-test.json',
  };
  await readingListRoutes(req, res, url, pathname, ctx);
  return { captured, saved, saveCount, readBodyCount, rateLimitKey, rateLimitMax, store };
}

const lastItem = (list) => list.items[list.items.length - 1];

describe('POST /api/reading-lists/:id/items add-item guards (current behavior)', () => {
  it('returns 429 before reading the body when the rate limit is exceeded, with no save', async () => {
    const { captured, saveCount, readBodyCount, rateLimitKey, rateLimitMax } = await invoke({
      body: { path: 'doc/intro' },
      rateLimitOk: false,
    });
    assert.equal(captured.status, 429);
    assert.equal(captured.payload.error, 'Too many requests. Try again in a minute.');
    assert.equal(saveCount, 0);
    // The 429 returns before the try block, so the body is never read.
    assert.equal(readBodyCount, 0);
    // The needle unique to this handler: an `rl-items:` key with a limit of 60.
    assert.equal(rateLimitKey, 'rl-items:127.0.0.1');
    assert.equal(rateLimitMax, 60);
  });

  // The path guard `!itemPath || typeof itemPath !== 'string'` covers three
  // distinct inputs; split into one case each so a regression names the input.
  it('returns 400 Missing path when path is omitted, with no save', async () => {
    const { captured, saveCount } = await invoke({ body: { title: 'x' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing path');
    assert.equal(saveCount, 0);
  });

  it('returns 400 Missing path when path is a non-string, with no save', async () => {
    const { captured, saveCount } = await invoke({ body: { path: 42 } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing path');
    assert.equal(saveCount, 0);
  });

  it('returns 400 Missing path when path is an empty string, with no save', async () => {
    const { captured, saveCount } = await invoke({ body: { path: '' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing path');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when the path exceeds 500 characters, with no save', async () => {
    const { captured, saveCount } = await invoke({ body: { path: 'a'.repeat(501) } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Path must be 500 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when a string title exceeds 500 characters, with no save', async () => {
    const { captured, saveCount } = await invoke({
      body: { path: 'doc/intro', title: 'x'.repeat(501) },
    });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Title must be 500 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('adds the item when title is a non-string, locking the typeof title gate', async () => {
    // A number title slips past the length guard, which only fires for strings,
    // and is stored as is because identity sanitizeText leaves it untouched.
    const { captured, saveCount } = await invoke({
      body: { path: 'doc/intro', title: 42 },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(saveCount, 1);
    assert.equal(lastItem(captured.payload.list).title, 42);
  });

  it('returns 404 when the target list does not exist, with no save', async () => {
    const { captured, saveCount } = await invoke({
      listId: 'no-such-list',
      body: { path: 'doc/intro' },
      // Another list exists and carries an items array; the target id matches none.
      data: makeStore(['other/item'], { id: 'other-list' }),
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Reading list not found');
    assert.equal(saveCount, 0);
  });

  it('dedups an existing path: 200 with the "Item already in list" message and no save', async () => {
    const data = makeStore(['doc/existing']);
    const { captured, saveCount, store } = await invoke({
      body: { path: 'doc/existing', title: 'Ignored' },
      data,
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(captured.payload.message, 'Item already in list');
    assert.equal(saveCount, 0);
    // The short-circuit leaves the list untouched: same count, same updatedAt.
    assert.equal(store.lists[0].items.length, 1);
    assert.equal(store.lists[0].updatedAt, SENTINEL_TS);
  });

  it('valid add: 200 with the documented item shape, updatedAt bumped, saved once', async () => {
    const data = makeStore([]);
    const { captured, saved, saveCount, readBodyCount } = await invoke({
      body: { path: 'doc/intro', title: 'Intro', type: 'doc' },
      data,
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(saveCount, 1);
    assert.equal(readBodyCount, 1);
    const item = lastItem(captured.payload.list);
    // Deterministic fields by value; addedAt by presence and type only.
    assert.deepEqual(Object.keys(item).sort(), ['addedAt', 'path', 'title', 'type']);
    assert.equal(item.path, 'doc/intro');
    assert.equal(item.title, 'Intro');
    assert.equal(item.type, 'doc');
    assert.equal(typeof item.addedAt, 'string');
    // updatedAt moved off the sentinel to a fresh clock string.
    assert.notEqual(captured.payload.list.updatedAt, SENTINEL_TS);
    assert.equal(typeof captured.payload.list.updatedAt, 'string');
    // The persisted document is the same in-memory store, now carrying the item,
    // and the returned list is that very persisted list object.
    assert.equal(saved, data);
    assert.equal(saved.lists[0].items.length, 1);
    assert.equal(captured.payload.list, saved.lists[0]);
  });

  it('normalizes type: omitted and unknown become "doc"; reference and doc are preserved', async () => {
    const cases = [
      { type: undefined, expected: 'doc' },
      { type: 'bogus', expected: 'doc' },
      { type: 'reference', expected: 'reference' },
      { type: 'doc', expected: 'doc' },
    ];
    let i = 0;
    for (const { type, expected } of cases) {
      const body = { path: `doc/item-${i}` };
      if (type !== undefined) body.type = type;
      const { captured, saveCount } = await invoke({ body });
      assert.equal(captured.status, 200);
      assert.equal(saveCount, 1);
      assert.equal(lastItem(captured.payload.list).type, expected);
      i += 1;
    }
  });

  it('falls back to the path as the title when title is omitted', async () => {
    const { captured, saveCount } = await invoke({ body: { path: 'doc/no-title' } });
    assert.equal(captured.status, 200);
    assert.equal(saveCount, 1);
    assert.equal(lastItem(captured.payload.list).title, 'doc/no-title');
  });
});
