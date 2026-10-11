/**
 * server/routes/bookmarks-reading-lists.js: comment reactions, bookmarks, the
 * content topic index, and reading lists with their markdown and BibTeX
 * exports.
 *
 * Consolidated from the twenty-seven per-branch suites that used to cover this
 * module.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {loadRoute, makeCtx, invoke, mockFs, FILES, CONTENT_DIR, TEST_ORG_ID, key, TEST_IDENTITY} from '../../_harness.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const routes = loadRoute('bookmarks-reading-lists');
const {COMMENTS_FILE} = FILES;
// Fixtures live in the workspace's own tree, and the paths a request carries
// are relative to it: `a.md`, never `content/mochi/a.md`.
const at = rel => path.join(CONTENT_DIR, rel);

function documentCtx(files, over = {}) {
  const ctx = makeCtx(over);
  const scope = {workspaceId: TEST_ORG_ID, userId: TEST_IDENTITY.userId};
  for (const [fullPath, markdown] of Object.entries(files)) {
    const relative = path.relative(CONTENT_DIR, fullPath).replace(/\\/g, '/');
    if (!relative.startsWith('..') && /\.mdx?$/.test(relative)) {
      ctx.documents.create(scope, {path: relative, markdown});
    }
  }
  return ctx;
}
/** Truthy inherited members that an own-key check must still reject. */
const INHERITED_KEYS = ['__proto__', 'constructor', 'toString'];

// ── Bookmarks ─────────────────────────────────────────────────────────────

/**
 * Seed the bookmark collection of one scope directly, the way another member's
 * requests would have. `ctx.scoped` is the store behind ctx, so what is written
 * here is what the handler reads.
 */
const seedBookmarks = (ctx, scope, entries) => {
  for (const entry of entries) ctx.scoped.collection('bookmarks').put(scope, entry.path, entry);
};

/** The scope a request with `auth` resolves to, as the handler will resolve it. */
const scopeOf = (ctx, auth) => ctx.scopeFor({auth});

/**
 * A ctx holding these reading lists, one row each, keyed by list id.
 * `over` is passed through to makeCtx, for the cases that also need a fixture
 * filesystem or the bibliography loader.
 */
const withLists = (lists, over = {}, auth = TEST_IDENTITY) => {
  const ctx = makeCtx(over);
  const scope = scopeOf(ctx, auth);
  for (const list of lists) ctx.scoped.collection('reading-lists').put(scope, list.id, list);
  return ctx;
};

/** One account's reading lists, as the store holds them. */
const storedLists = (ctx, auth = TEST_IDENTITY) =>
  ctx.scoped.collection('reading-lists').values(scopeOf(ctx, auth));

describe('GET /api/bookmarks', () => {
  for (const [label, stored, expected] of [
    ['a populated store', [{path: '/a', title: 'A'}], [{path: '/a', title: 'A'}]],
    ['an empty store', [], []],
  ]) {
    it(`returns the list for ${label}`, async () => {
      const ctx = makeCtx();
      seedBookmarks(ctx, scopeOf(ctx, TEST_IDENTITY), stored);
      const r = await invoke(routes, {path: '/api/bookmarks', ctx});
      assert.deepEqual([r.status, r.payload], [200, {bookmarks: expected}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  // The reason bookmarks moved off a shared JSON file. Before this, one list
  // was every list, and this case could not have been written.
  it('shows one member nothing of another member\'s', async () => {
    const ctx = makeCtx();
    const ada = {...TEST_IDENTITY, userId: 'ada'};
    const bob = {...TEST_IDENTITY, userId: 'bob'};
    seedBookmarks(ctx, scopeOf(ctx, ada), [{path: '/shared-url', title: "Ada's"}]);

    const mine = await invoke(routes, {path: '/api/bookmarks', ctx, auth: ada});
    const theirs = await invoke(routes, {path: '/api/bookmarks', ctx, auth: bob});

    assert.deepEqual(mine.payload.bookmarks, [{path: '/shared-url', title: "Ada's"}]);
    assert.deepEqual(theirs.payload.bookmarks, []);
  });

  it('shows one workspace nothing of another workspace\'s', async () => {
    const ctx = makeCtx();
    const here = {...TEST_IDENTITY, userId: 'ada', orgId: 'lab'};
    const there = {...TEST_IDENTITY, userId: 'ada', orgId: 'course'};
    seedBookmarks(ctx, scopeOf(ctx, here), [{path: '/shared-url', title: 'Lab'}]);

    const r = await invoke(routes, {path: '/api/bookmarks', ctx, auth: there});
    assert.deepEqual(r.payload.bookmarks, [], 'the same account, the other workspace');
  });
});

describe('POST /api/bookmarks', () => {
  it('returns 429 before reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'bookmarks:test-user', maxPerMinute: 30}]);
    assert.equal(reads, 0);
  });

  const GUARDS = [
    {name: 'an omitted path', body: {}, error: 'Missing path'},
    {name: 'a non-string path', body: {path: 7}, error: 'Missing path'},
    {name: 'an empty-string path', body: {path: ''}, error: 'Missing path'},
    {name: 'a path over 500 characters', body: {path: 'p'.repeat(501)}, error: 'Path must be 500 characters or fewer'},
    {name: 'a string title over 500 characters', body: {path: '/a', title: 't'.repeat(501)}, error: 'Title must be 500 characters or fewer'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  // The title length guard is gated on typeof title === 'string', so a
  // non-string falls straight through to the add path.
  it('accepts a non-string title', async () => {
    const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks', body: {path: '/a', title: 12345}});
    assert.equal(r.status, 200);
    assert.equal(r.payload.bookmark.title, '/a', 'sanitizeText blanks it, so the path is the fallback');
  });

  it('adds a bookmark, and it is there afterwards', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks', body: {path: '/a', title: 'A Page'}, ctx});
    assert.equal(r.status, 200);
    const {addedAt, ...stable} = r.payload.bookmark;
    assert.deepEqual(stable, {path: '/a', title: 'A Page'});
    assert.equal(typeof addedAt, 'string');
    // Read it back through the handler rather than counting writes: what
    // matters is that the caller's next GET sees it, in their scope.
    const list = await invoke(routes, {path: '/api/bookmarks', ctx});
    assert.deepEqual(list.payload.bookmarks.map(b => b.path), ['/a']);
    assert.deepEqual(ctx.calls.saveJSON, [], 'no JSON file is touched any more');
  });

  for (const [label, title] of [['omitted', undefined], ['empty', '']]) {
    it(`falls back to the path for the title when it is ${label}`, async () => {
      const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks', body: {path: '/a', title}});
      assert.equal(r.payload.bookmark.title, '/a');
    });
  }

  // A duplicate echoes the whole list rather than the single new object, and
  // leaves the title the first add gave it.
  it('is idempotent for a path already bookmarked', async () => {
    const bookmarks = [{path: '/a', title: 'A'}];
    const ctx = makeCtx();
    seedBookmarks(ctx, scopeOf(ctx, TEST_IDENTITY), bookmarks);
    const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks', body: {path: '/a'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, bookmarks}]);
  });

  // Same path, two members: the unique index is per owner, so neither add is
  // the other's duplicate.
  it('does not treat another member\'s bookmark of the same path as a duplicate', async () => {
    const ctx = makeCtx();
    const ada = {...TEST_IDENTITY, userId: 'ada'};
    const bob = {...TEST_IDENTITY, userId: 'bob'};
    seedBookmarks(ctx, scopeOf(ctx, ada), [{path: '/a', title: "Ada's"}]);

    const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks', body: {path: '/a', title: "Bob's"}, ctx, auth: bob});
    assert.equal(r.payload.bookmark?.title, "Bob's", 'a fresh add, not an echo of the list');

    const hers = await invoke(routes, {path: '/api/bookmarks', ctx, auth: ada});
    assert.deepEqual(hers.payload.bookmarks, [{path: '/a', title: "Ada's"}], 'untouched');
  });
});

describe('DELETE /api/bookmarks', () => {
  for (const [label, body] of [['an omitted path', {}], ['a non-string path', {path: 7}]]) {
    it(`rejects ${label} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'DELETE', path: '/api/bookmarks', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Missing path'}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  for (const [label, stored] of [
    ['a populated store', [{path: '/other'}]],
    ['an empty store', []],
  ]) {
    it(`returns 404 for an absent path with ${label}`, async () => {
      const ctx = makeCtx();
      seedBookmarks(ctx, scopeOf(ctx, TEST_IDENTITY), stored);
      const r = await invoke(routes, {method: 'DELETE', path: '/api/bookmarks', body: {path: '/gone'}, ctx});
      assert.deepEqual([r.status, r.payload], [404, {error: 'Bookmark not found'}]);
    });
  }

  it('removes the matching bookmark, keeping its siblings', async () => {
    const ctx = makeCtx();
    seedBookmarks(ctx, scopeOf(ctx, TEST_IDENTITY), [{path: '/a'}, {path: '/b'}]);
    const r = await invoke(routes, {method: 'DELETE', path: '/api/bookmarks', body: {path: '/a'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    const left = await invoke(routes, {path: '/api/bookmarks', ctx});
    assert.deepEqual(left.payload.bookmarks.map(b => b.path), ['/b']);
  });

  // The delete is scoped too, not just the read: a 404 rather than reaching
  // across and removing the other member's row.
  it('cannot delete another member\'s bookmark of the same path', async () => {
    const ctx = makeCtx();
    const ada = {...TEST_IDENTITY, userId: 'ada'};
    const bob = {...TEST_IDENTITY, userId: 'bob'};
    seedBookmarks(ctx, scopeOf(ctx, ada), [{path: '/a', title: "Ada's"}]);

    const r = await invoke(routes, {method: 'DELETE', path: '/api/bookmarks', body: {path: '/a'}, ctx, auth: bob});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Bookmark not found'}]);

    const hers = await invoke(routes, {path: '/api/bookmarks', ctx, auth: ada});
    assert.deepEqual(hers.payload.bookmarks, [{path: '/a', title: "Ada's"}], 'still there');
  });
});

describe('GET /api/analytics/topics', () => {
  it('ranks content words by frequency, stripping markdown and stop words', async () => {
    const doc = [
      '---',
      'title: Ignored',
      '---',
      '# Heading',
      'The quantum quantum quantum computer is the future of the field.',
      '`inline`',
      '```',
      'fenced quantum noise',
      '```',
      '[label](http://example.com)',
      '<span>html</span>',
    ].join('\n');
    const ctx = documentCtx({[at('a.md')]: doc});
    const r = await invoke(routes, {path: '/api/analytics/topics', ctx});
    assert.equal(r.status, 200);
    const counts = Object.fromEntries(r.payload.topics.map(t => [t.word, t.count]));
    assert.equal(counts.quantum, 3, 'the fenced occurrence is stripped first');
    // Stop words and words of two characters or fewer never appear.
    for (const dropped of ['the', 'is', 'of']) assert.equal(counts[dropped], undefined);
    assert.equal(r.payload.topics[0].word, 'quantum', 'sorted by count descending');
  });

  it('still filters stop words when they outnumber every content word', async () => {
    const ctx = documentCtx({[at('a.md')]: `${'the and but or '.repeat(20)} quantum`});
    const r = await invoke(routes, {path: '/api/analytics/topics', ctx});
    assert.deepEqual(r.payload.topics, [{word: 'quantum', count: 1}]);
  });

  it('returns an empty list when the content directory is missing', async () => {
    const r = await invoke(routes, {path: '/api/analytics/topics', ctx: documentCtx({})});
    assert.deepEqual([r.status, r.payload], [200, {topics: []}]);
  });

  it('caps the list at fifty entries', async () => {
    const words = Array.from({length: 60}, (_, i) => 'w' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)));
    const body = words.map((w, i) => Array(i + 1).fill(w).join(' ')).join(' ');
    const ctx = documentCtx({[at('a.md')]: body});
    const r = await invoke(routes, {path: '/api/analytics/topics', ctx});
    assert.equal(r.payload.topics.length, 50);
  });

  it('memoizes under "analytics:topics" with a 60000 ms TTL and reuses the result', async () => {
    let seen;
    let walks = 0;
    const base = mockFs({[at('a.md')]: 'quantum quantum'});
    const fs = {...base, readdirSync: (p, o) => { walks++; return base.readdirSync(p, o); }};
    const ctx = documentCtx({[at('a.md')]: 'quantum quantum'}, {cached: (key, ttl, fn) => { seen = [key, ttl]; return ctx.cache[key] ?? (ctx.cache[key] = fn()); }});
    await invoke(routes, {path: '/api/analytics/topics', ctx});
    assert.deepEqual(seen, [key('analytics:topics:test-user'), 60000]);
    const after = walks;
    await invoke(routes, {path: '/api/analytics/topics', ctx});
    assert.equal(walks, after, 'the factory runs once');
  });
});

// ── Reading lists ─────────────────────────────────────────────────────────

describe('GET /api/reading-lists', () => {
  for (const [label, stored, expected] of [
    ['the stored lists verbatim', [{id: 'l1', name: 'A'}], [{id: 'l1', name: 'A'}]],
    ['an empty array for a caller with none', [], []],
  ]) {
    it(`returns ${label}`, async () => {
      const r = await invoke(routes, {path: '/api/reading-lists', ctx: withLists(stored)});
      assert.deepEqual([r.status, r.payload], [200, {lists: expected}]);
    });
  }
});

describe('POST /api/reading-lists (create)', () => {
  it('returns 429 before any IO', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'POST', path: '/api/reading-lists', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'reading-lists:test-user', maxPerMinute: 30}]);
    assert.deepEqual(ctx.calls.loadJSON, []);
  });

  const GUARDS = [
    {name: 'an omitted name', body: {}, error: 'Missing name'},
    // trim() is never called on a non-string: the typeof guard runs first.
    {name: 'a non-string name', body: {name: 7}, error: 'Missing name'},
    {name: 'a whitespace-only name', body: {name: '   '}, error: 'Missing name'},
    {name: 'a name over 200 characters', body: {name: 'n'.repeat(201)}, error: 'Name must be 200 characters or fewer'},
    {name: 'a description over 5000 characters', body: {name: 'ok', description: 'd'.repeat(5001)}, error: 'Description must be 5000 characters or fewer'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/reading-lists', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  for (const [label, body] of [
    ['a name of exactly 200 characters', {name: 'n'.repeat(200)}],
    ['a description of exactly 5000 characters', {name: 'ok', description: 'd'.repeat(5000)}],
  ]) {
    it(`accepts ${label}`, async () => {
      const r = await invoke(routes, {method: 'POST', path: '/api/reading-lists', body});
      assert.equal(r.status, 200);
    });
  }

  it('creates a list with the name and description trimmed', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'POST', path: '/api/reading-lists', body: {name: '  My List  ', description: '  About it  '}, ctx});
    assert.equal(r.status, 200);
    const {id, createdAt, updatedAt, ...stable} = r.payload.list;
    assert.deepEqual(stable, {name: 'My List', description: 'About it', items: []});
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(storedLists(ctx).map(l => l.id), [id], 'and it is the caller\'s');
  });

  it('defaults an omitted description to an empty string', async () => {
    const r = await invoke(routes, {method: 'POST', path: '/api/reading-lists', body: {name: 'plain'}});
    assert.equal(r.payload.list.description, '');
  });
});

describe('DELETE /api/reading-lists/:id', () => {
  const withList = (items = []) => withLists([{id: 'l1', name: 'A', items}]);

  it('returns 404 for an unknown id without saving', async () => {
    const ctx = withList();
    const r = await invoke(routes, {method: 'DELETE', path: '/api/reading-lists/nope', ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reading list not found'}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  it('removes the list and keeps it', async () => {
    const ctx = withList();
    const r = await invoke(routes, {method: 'DELETE', path: '/api/reading-lists/l1', ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(storedLists(ctx), []);
  });

  it('maps a store failure to the outer catch', async () => {
    // The failure has to come from inside the handler's try, which is where the
    // store call is; the collections themselves are looked up above it.
    const ctx = makeCtx();
    const real = ctx.collection;
    ctx.collection = name => name === 'reading-lists'
      ? {...real(name), remove() { throw new Error('unreadable'); }}
      : real(name);
    const r = await invoke(routes, {method: 'DELETE', path: '/api/reading-lists/l1', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid request'}]);
  });
});

describe('POST /api/reading-lists/:id/items (add)', () => {
  const ITEMS_PATH = '/api/reading-lists/l1/items';
  const withList = (items = []) => withLists([{id: 'l1', name: 'A', items}]);

  it('returns 429 before reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: ITEMS_PATH, ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'rl-items:test-user', maxPerMinute: 60}]);
    assert.equal(reads, 0);
  });

  const GUARDS = [
    {name: 'an omitted path', body: {}, error: 'Missing path'},
    {name: 'a non-string path', body: {path: 7}, error: 'Missing path'},
    {name: 'an empty-string path', body: {path: ''}, error: 'Missing path'},
    {name: 'a path over 500 characters', body: {path: 'p'.repeat(501)}, error: 'Path must be 500 characters or fewer'},
    {name: 'a string title over 500 characters', body: {path: '/a', title: 't'.repeat(501)}, error: 'Title must be 500 characters or fewer'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = withList();
      const r = await invoke(routes, {method: 'POST', path: ITEMS_PATH, body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('accepts a non-string title, since the length guard is string-only', async () => {
    const ctx = withList();
    const r = await invoke(routes, {method: 'POST', path: ITEMS_PATH, body: {path: '/a', title: 12345}, ctx});
    assert.equal(r.status, 200);
    assert.equal(storedLists(ctx)[0].items[0].title, '/a');
  });

  it('returns 404 for an unknown list', async () => {
    const ctx = withList();
    const r = await invoke(routes, {method: 'POST', path: '/api/reading-lists/nope/items', body: {path: '/a'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reading list not found'}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  it('dedups an item already in the list', async () => {
    const ctx = withList([{path: '/a'}]);
    const r = await invoke(routes, {method: 'POST', path: ITEMS_PATH, body: {path: '/a'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, message: 'Item already in list'}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  it('adds the item, bumps updatedAt and keeps it', async () => {
    const ctx = withLists([{id: 'l1', name: 'A', items: [], updatedAt: 'old'}]);
    const r = await invoke(routes, {method: 'POST', path: ITEMS_PATH, body: {path: '/a', title: 'A Doc', type: 'reference'}, ctx});
    assert.equal(r.status, 200);
    const [item] = storedLists(ctx)[0].items;
    const {addedAt, ...stable} = item;
    assert.deepEqual(stable, {path: '/a', title: 'A Doc', type: 'reference'});
    assert.notEqual(storedLists(ctx)[0].updatedAt, 'old');
  });

  const TYPES = [
    {given: undefined, want: 'doc'},
    {given: 'unknown', want: 'doc'},
    {given: 'doc', want: 'doc'},
    {given: 'reference', want: 'reference'},
  ];
  for (const {given, want} of TYPES) {
    it(`normalises the type ${JSON.stringify(given)} to ${want}`, async () => {
      const ctx = withList();
      await invoke(routes, {method: 'POST', path: ITEMS_PATH, body: {path: '/a', type: given}, ctx});
      assert.equal(storedLists(ctx)[0].items[0].type, want);
    });
  }

  it('falls back to the path for the title', async () => {
    const ctx = withList();
    await invoke(routes, {method: 'POST', path: ITEMS_PATH, body: {path: '/a'}, ctx});
    assert.equal(storedLists(ctx)[0].items[0].title, '/a');
  });
});

describe('DELETE /api/reading-lists/:id/items (remove)', () => {
  const ITEMS_PATH = '/api/reading-lists/l1/items';
  const withList = (items = []) => withLists([{id: 'l1', name: 'A', items}]);

  const GUARDS = [
    {name: 'an omitted path', body: {}, status: 400, error: 'Missing path'},
    {name: 'a non-string path', body: {path: 7}, status: 400, error: 'Missing path'},
    {name: 'an item absent from the list', body: {path: '/gone'}, status: 404, error: 'Item not found in list'},
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = withList([{path: '/a'}]);
      const r = await invoke(routes, {method: 'DELETE', path: ITEMS_PATH, body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('returns 404 for an unknown list', async () => {
    const r = await invoke(routes, {method: 'DELETE', path: '/api/reading-lists/nope/items', body: {path: '/a'}, ctx: withList([{path: '/a'}])});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reading list not found'}]);
  });

  it('removes the item, bumps updatedAt and keeps it', async () => {
    const ctx = withLists([{id: 'l1', items: [{path: '/a'}, {path: '/b'}], updatedAt: 'old'}]);
    const r = await invoke(routes, {method: 'DELETE', path: ITEMS_PATH, body: {path: '/a'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(storedLists(ctx)[0].items.map(i => i.path), ['/b']);
    assert.notEqual(storedLists(ctx)[0].updatedAt, 'old');
  });
});

describe('PATCH /api/reading-lists/:id/items (reorder)', () => {
  const ITEMS_PATH = '/api/reading-lists/l1/items';
  const three = () => withLists([{id: 'l1', items: [{path: '/a'}, {path: '/b'}, {path: '/c'}], updatedAt: 'old'}]);

  const GUARDS = [
    {name: 'an omitted path', body: {direction: 'up'}, status: 400, error: 'Missing path'},
    {name: 'an empty-string path', body: {path: '', direction: 'up'}, status: 400, error: 'Missing path'},
    {name: 'a non-string path', body: {path: 7, direction: 'up'}, status: 400, error: 'Missing path'},
    {name: 'an omitted direction', body: {path: '/a'}, status: 400, error: 'direction must be "up" or "down"'},
    {name: 'a direction that is neither up nor down', body: {path: '/a', direction: 'left'}, status: 400, error: 'direction must be "up" or "down"'},
    {name: 'an item absent from the list', body: {path: '/gone', direction: 'up'}, status: 404, error: 'Item not found in list'},
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = three();
      const r = await invoke(routes, {method: 'PATCH', path: ITEMS_PATH, body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('returns 404 for an unknown list', async () => {
    const r = await invoke(routes, {method: 'PATCH', path: '/api/reading-lists/nope/items', body: {path: '/a', direction: 'up'}, ctx: three()});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reading list not found'}]);
  });

  const BOUNDARIES = [
    {name: 'the first item up', body: {path: '/a', direction: 'up'}},
    {name: 'the last item down', body: {path: '/c', direction: 'down'}},
  ];
  for (const {name, body} of BOUNDARIES) {
    it(`is a no-op when moving ${name}`, async () => {
      const ctx = three();
      const r = await invoke(routes, {method: 'PATCH', path: ITEMS_PATH, body, ctx});
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload.list.items.map(i => i.path), ['/a', '/b', '/c']);
      assert.deepEqual(ctx.calls.saveJSON, []);
      assert.equal(r.payload.list.updatedAt, 'old', 'the boundary no-op does not bump updatedAt');
    });
  }

  const SWAPS = [
    {name: 'down', body: {path: '/a', direction: 'down'}, order: ['/b', '/a', '/c']},
    {name: 'up', body: {path: '/c', direction: 'up'}, order: ['/a', '/c', '/b']},
  ];
  for (const {name, body, order} of SWAPS) {
    it(`swaps ${name}, bumps updatedAt and saves once`, async () => {
      const ctx = three();
      const r = await invoke(routes, {method: 'PATCH', path: ITEMS_PATH, body, ctx});
      assert.deepEqual(r.payload.list.items.map(i => i.path), order);
      assert.notEqual(r.payload.list.updatedAt, 'old');
      assert.deepEqual(storedLists(ctx)[0].items.map(i => i.path), order, 'and the swap is kept');
    });
  }
});

// ── Export ────────────────────────────────────────────────────────────────

describe('GET /api/reading-lists/:id/export', () => {
  const EXPORT = '/api/reading-lists/l1/export';
  const list = (over, ctxOver) => withLists([{id: 'l1', name: 'My List', items: [], ...over}], ctxOver);

  it('returns 404 for an unknown list', async () => {
    const r = await invoke(routes, {path: '/api/reading-lists/nope/export', ctx: list()});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reading list not found'}]);
  });

  it('renders numbered markdown, tagging references and falling back to the path', async () => {
    const items = [
      {path: '/a', title: 'A Doc', type: 'doc'},
      {path: '/b', title: 'A Paper', type: 'reference'},
      {path: '/c'},
    ];
    const r = await invoke(routes, {path: EXPORT, ctx: list({items})});
    assert.equal(r.written.body, '# My List\n\n1. [Doc] A Doc\n2. [Paper] A Paper\n3. [Doc] /c\n');
    assert.deepEqual(r.written.headers, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="My_List.md"',
      'Access-Control-Allow-Origin': '*',
    });
  });

  it('prepends the description when the list has one', async () => {
    const r = await invoke(routes, {path: EXPORT, ctx: list({description: 'About it', items: [{path: '/a'}]})});
    assert.equal(r.written.body, '# My List\n\nAbout it\n\n1. [Doc] /a\n');
  });

  for (const [label, over] of [['an empty items array', {items: []}], ['no items key at all', {items: undefined}]]) {
    it(`renders the empty placeholder for ${label}`, async () => {
      const r = await invoke(routes, {path: EXPORT, ctx: list(over)});
      assert.equal(r.written.body, '# My List\n\n_No items in this list._\n');
    });
  }

  it('treats any non-bibtex format as the markdown default', async () => {
    const r = await invoke(routes, {path: EXPORT, query: {format: 'json'}, ctx: list({items: [{path: '/a'}]})});
    assert.equal(r.written.headers['Content-Type'], 'text/markdown; charset=utf-8');
  });

  it('returns 500 when the list id cannot be decoded', async () => {
    const ctx = list();
    const r = await invoke(routes, {path: '/api/reading-lists/%/export', ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Export failed'}]);
    // The decode throws before anything is loaded or streamed.
    assert.deepEqual(ctx.calls.loadJSON, []);
    assert.equal(r.written, null);
  });

  describe('bibtex format', () => {
    const REFS = [
      'inproc2020:',
      '  title: Proceedings Paper',
      '  type: inproceedings',
      '  venue: NeurIPS',
      '  author:',
      '    - Ada Lovelace',
      '    - Grace Hopper',
      '  year: 2020',
      'article2021:',
      '  title: Journal Paper',
      '  type: article',
      '  venue: Nature',
      '  doi: 10.1/xyz',
      'book2022:',
      '  title: A Book',
      '  type: book',
      '  venue: Some Press',
      'typeless2023:',
      '  title: No Type',
      '  venue: Somewhere',
      '  url: http://example.com',
      'specials2024:',
      '  title: Cost & Benefit 50% of it_all',
    ].join('\n');

    const bibCtx = (items, refs = REFS) => {
      const ctx = list({items});
      let parsed = {};
      try { parsed = refs === null ? {} : (yaml.load(refs) || {}); } catch { /* empty database fixture */ }
      const papers = ctx.scoped.collection('plugin:bibliography:papers');
      for (const [citationKey, entry] of Object.entries(parsed)) {
        papers.put(scopeOf(ctx, TEST_IDENTITY), citationKey, entry);
      }
      return {ctx};
    };

    it('maps the venue field by entry type and joins authors with "and"', async () => {
      const items = [
        {path: 'inproc2020', type: 'reference'},
        {path: 'article2021', type: 'reference'},
        {path: 'book2022', type: 'reference'},
        {path: 'typeless2023', type: 'reference'},
      ];
      const {ctx} = bibCtx(items);
      const r = await invoke(routes, {path: EXPORT, query: {format: 'bibtex'}, ctx});
      const body = r.written.body;
      assert.ok(body.includes('@inproceedings{inproc2020,'));
      assert.ok(body.includes('  booktitle = {NeurIPS}'));
      assert.ok(body.includes('  author = {Ada Lovelace and Grace Hopper}'));
      assert.ok(body.includes('  year = {2020}'));
      assert.ok(body.includes('  journal = {Nature}'), 'an article keeps journal');
      assert.ok(body.includes('  doi = {10.1/xyz}'));
      assert.ok(body.includes('  howpublished = {Some Press}'), 'a book uses howpublished');
      // A typeless entry defaults to @misc and also uses howpublished.
      assert.ok(body.includes('@misc{typeless2023,'));
      assert.ok(body.includes('  url = {http://example.com}'));
    });

    it('escapes LaTeX specials so the output compiles', async () => {
      const {ctx} = bibCtx([{path: 'specials2024', type: 'reference'}]);
      const r = await invoke(routes, {path: EXPORT, query: {format: 'bibtex'}, ctx});
      assert.equal(r.written.body, '@misc{specials2024,\n  title = {Cost \\& Benefit 50\\% of it\\_all}\n}\n');
      assert.equal(/(^|[^\\])&/.test(r.written.body), false, 'no bare ampersand survives');
    });

    it('sends the BibTeX content type and attachment headers', async () => {
      const {ctx} = bibCtx([{path: 'article2021', type: 'reference'}]);
      const r = await invoke(routes, {path: EXPORT, query: {format: 'bibtex'}, ctx});
      assert.deepEqual(r.written.headers, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="My_List.bib"',
        'Access-Control-Allow-Origin': '*',
      });
    });

    it('preserves item order while skipping docs and unknown keys', async () => {
      const items = [
        {path: 'article2021', type: 'reference'},
        // A doc is skipped on its type alone, even though this key does resolve
        // in the bibliography.
        {path: 'inproc2020', type: 'doc'},
        {path: 'not-in-bibliography', type: 'reference'},
        {path: 'book2022', type: 'reference'},
      ];
      const {ctx} = bibCtx(items);
      const r = await invoke(routes, {path: EXPORT, query: {format: 'bibtex'}, ctx});
      assert.deepEqual([...r.written.body.matchAll(/@\w+\{([^,]+),/g)].map(m => m[1]), ['article2021', 'book2022']);
    });

    for (const [label, items, refs] of [
      ['no reference resolves', [{path: '/a-doc', type: 'doc'}], REFS],
      ['the reference database is empty', [{path: 'article2021', type: 'reference'}], null],
      ['the fixture contains no valid records', [{path: 'article2021', type: 'reference'}], '\tbroken: ['],
    ]) {
      it(`emits a lone newline when ${label}`, async () => {
        const {ctx} = bibCtx(items, refs);
        const r = await invoke(routes, {path: EXPORT, query: {format: 'bibtex'}, ctx});
        assert.equal(r.written.body, '\n');
      });
    }

    it('reads the same scoped database records on repeated exports', async () => {
      const {ctx} = bibCtx([{path: 'article2021', type: 'reference'}]);
      const first = await invoke(routes, {path: EXPORT, query: {format: 'bibtex'}, ctx});
      const second = await invoke(routes, {path: EXPORT, query: {format: 'bibtex'}, ctx});
      assert.equal(second.written.body, first.written.body);
    });
  });
});

// ── Route matching ────────────────────────────────────────────────────────

// Every body-reading handler wraps the read and the destructure of its result
// in one try whose catch returns a fixed 400 ahead of the first inner guard.
describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'POST', path: '/api/bookmarks'},
    {method: 'DELETE', path: '/api/bookmarks'},
    {method: 'POST', path: '/api/reading-lists'},
    {method: 'POST', path: '/api/reading-lists/l1/items'},
    {method: 'DELETE', path: '/api/reading-lists/l1/items'},
    {method: 'PATCH', path: '/api/reading-lists/l1/items'},
  ];
  for (const {method, path: p} of CASES) {
    for (const [label, readBody] of [
      ['readBody rejects', async () => { throw new Error('bad json'); }],
      ['readBody resolves null', async () => null],
    ]) {
      it(`${method} ${p} returns 400 Invalid request when ${label}, without saving`, async () => {
        const ctx = makeCtx({readBody});
        const r = await invoke(routes, {method, path: p, ctx});
        assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid request'}]);
        assert.deepEqual(ctx.calls.saveJSON, []);
      });
    }
  }

  // An empty object still carries every destructured key as undefined, so it
  // stops at the first inner guard rather than reaching the outer catch.
});
