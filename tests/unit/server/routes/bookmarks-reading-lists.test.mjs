/**
 * server/routes/bookmarks-reading-lists.js: comment reactions, bookmarks, the
 * content topic index, and reading lists with their markdown and BibTeX
 * exports.
 *
 * Consolidated from the twenty-seven per-branch suites that used to cover this
 * module.
 */
import {beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {loadRoute, makeCtx, invoke, mockFs, FILES, PROJECT_ROOT} from '../../_harness.mjs';

const require = createRequire(import.meta.url);
const bibliographyProvides = require('../../../../plugins/bibliography/server.js').provides;
const {_resetReferencesCache} = require('../../../../plugins/bibliography/lib/references.js');

const routes = loadRoute('bookmarks-reading-lists');
const {COMMENTS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE} = FILES;
const at = rel => path.join(PROJECT_ROOT, rel);
const BIB = at('content/bibliography/references.yaml');

/**
 * The bibliography plugin publishes a loader that asks for a reader, because
 * the plugin is not allowed to touch the filesystem itself. The server adapts
 * that reader into the (fs, path, root) call the core handlers make: see
 * referencesForCore in src/server/index.js. This mirrors that adaptation, so
 * the BibTeX export runs against the real loader over this suite's fixture fs
 * rather than against a stub of it.
 */
function referencesForCore(provided) {
  const readerFor = (fs, path, root) => {
    const at = relative => path.join(root, 'content', relative);
    return {
      read(relative) {
        try {
          return fs.readFileSync(at(relative), 'utf-8');
        } catch {
          return null;
        }
      },
      stat(relative) {
        try {
          const {mtimeMs, size} = fs.statSync(at(relative));
          return {mtimeMs, size};
        } catch {
          return null;
        }
      },
    };
  };
  return {...provided, load: (fs, path, root) => provided.load(readerFor(fs, path, root))};
}

/** Truthy inherited members that an own-key check must still reject. */
const INHERITED_KEYS = ['__proto__', 'constructor', 'toString'];

// ── Bookmarks ─────────────────────────────────────────────────────────────

describe('GET /api/bookmarks', () => {
  for (const [label, stored, expected] of [
    ['a populated store', {bookmarks: [{path: '/a', title: 'A'}]}, [{path: '/a', title: 'A'}]],
    ['a store with no bookmarks key', {}, []],
  ]) {
    it(`returns the list for ${label}`, async () => {
      const ctx = makeCtx({store: {[BOOKMARKS_FILE]: stored}});
      const r = await invoke(routes, {path: '/api/bookmarks', ctx});
      assert.deepEqual([r.status, r.payload], [200, {bookmarks: expected}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }
});

describe('POST /api/bookmarks', () => {
  it('returns 429 before reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'bookmarks:127.0.0.1', maxPerMinute: 30}]);
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

  it('adds a bookmark and saves once', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks', body: {path: '/a', title: 'A Page'}, ctx});
    assert.equal(r.status, 200);
    const {addedAt, ...stable} = r.payload.bookmark;
    assert.deepEqual(stable, {path: '/a', title: 'A Page'});
    assert.equal(typeof addedAt, 'string');
    assert.equal(ctx.calls.saveJSON.length, 1);
  });

  for (const [label, title] of [['omitted', undefined], ['empty', '']]) {
    it(`falls back to the path for the title when it is ${label}`, async () => {
      const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks', body: {path: '/a', title}});
      assert.equal(r.payload.bookmark.title, '/a');
    });
  }

  // A duplicate echoes the whole array rather than the single new object.
  it('is idempotent for a path already bookmarked', async () => {
    const bookmarks = [{path: '/a', title: 'A'}];
    const ctx = makeCtx({store: {[BOOKMARKS_FILE]: {bookmarks}}});
    const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks', body: {path: '/a'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, bookmarks}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
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
    ['a populated store', {bookmarks: [{path: '/other'}]}],
    ['a store with no bookmarks array', {}],
  ]) {
    it(`returns 404 for an absent path with ${label}`, async () => {
      const ctx = makeCtx({store: {[BOOKMARKS_FILE]: stored}});
      const r = await invoke(routes, {method: 'DELETE', path: '/api/bookmarks', body: {path: '/gone'}, ctx});
      assert.deepEqual([r.status, r.payload], [404, {error: 'Bookmark not found'}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('removes the matching bookmark, keeping its siblings', async () => {
    const ctx = makeCtx({store: {[BOOKMARKS_FILE]: {bookmarks: [{path: '/a'}, {path: '/b'}]}}});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/bookmarks', body: {path: '/a'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(ctx.store[BOOKMARKS_FILE].bookmarks.map(b => b.path), ['/b']);
    assert.equal(ctx.calls.saveJSON.length, 1);
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
    const ctx = makeCtx({fs: mockFs({[at('content/a.md')]: doc})});
    const r = await invoke(routes, {path: '/api/analytics/topics', ctx});
    assert.equal(r.status, 200);
    const counts = Object.fromEntries(r.payload.topics.map(t => [t.word, t.count]));
    assert.equal(counts.quantum, 3, 'the fenced occurrence is stripped first');
    // Stop words and words of two characters or fewer never appear.
    for (const dropped of ['the', 'is', 'of']) assert.equal(counts[dropped], undefined);
    assert.equal(r.payload.topics[0].word, 'quantum', 'sorted by count descending');
  });

  it('still filters stop words when they outnumber every content word', async () => {
    const ctx = makeCtx({fs: mockFs({[at('content/a.md')]: `${'the and but or '.repeat(20)} quantum`})});
    const r = await invoke(routes, {path: '/api/analytics/topics', ctx});
    assert.deepEqual(r.payload.topics, [{word: 'quantum', count: 1}]);
  });

  it('returns an empty list when the content directory is missing', async () => {
    const r = await invoke(routes, {path: '/api/analytics/topics', ctx: makeCtx({fs: mockFs({})})});
    assert.deepEqual([r.status, r.payload], [200, {topics: []}]);
  });

  it('caps the list at fifty entries', async () => {
    const words = Array.from({length: 60}, (_, i) => 'w' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)));
    const body = words.map((w, i) => Array(i + 1).fill(w).join(' ')).join(' ');
    const ctx = makeCtx({fs: mockFs({[at('content/a.md')]: body})});
    const r = await invoke(routes, {path: '/api/analytics/topics', ctx});
    assert.equal(r.payload.topics.length, 50);
  });

  it('memoizes under "analytics:topics" with a 60000 ms TTL and reuses the result', async () => {
    let seen;
    let walks = 0;
    const base = mockFs({[at('content/a.md')]: 'quantum quantum'});
    const fs = {...base, readdirSync: (p, o) => { walks++; return base.readdirSync(p, o); }};
    const ctx = makeCtx({fs, cached: (key, ttl, fn) => { seen = [key, ttl]; return ctx.cache[key] ?? (ctx.cache[key] = fn()); }});
    await invoke(routes, {path: '/api/analytics/topics', ctx});
    assert.deepEqual(seen, ['analytics:topics', 60000]);
    const after = walks;
    await invoke(routes, {path: '/api/analytics/topics', ctx});
    assert.equal(walks, after, 'the factory runs once');
  });
});

// ── Reading lists ─────────────────────────────────────────────────────────

describe('GET /api/reading-lists', () => {
  for (const [label, stored, expected] of [
    ['the stored lists verbatim', {lists: [{id: 'l1', name: 'A'}]}, [{id: 'l1', name: 'A'}]],
    ['an empty array when the store lacks a lists key', {}, []],
  ]) {
    it(`returns ${label}`, async () => {
      const r = await invoke(routes, {path: '/api/reading-lists', ctx: makeCtx({store: {[READING_LISTS_FILE]: stored}})});
      assert.deepEqual([r.status, r.payload], [200, {lists: expected}]);
    });
  }
});

describe('POST /api/reading-lists (create)', () => {
  it('returns 429 before any IO', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'POST', path: '/api/reading-lists', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'reading-lists:127.0.0.1', maxPerMinute: 30}]);
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
    assert.equal(ctx.calls.saveJSON.length, 1);
  });

  it('defaults an omitted description to an empty string', async () => {
    const r = await invoke(routes, {method: 'POST', path: '/api/reading-lists', body: {name: 'plain'}});
    assert.equal(r.payload.list.description, '');
  });
});

describe('DELETE /api/reading-lists/:id', () => {
  const withList = (items = []) => ({[READING_LISTS_FILE]: {lists: [{id: 'l1', name: 'A', items}]}});

  it('returns 404 for an unknown id without saving', async () => {
    const ctx = makeCtx({store: withList()});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/reading-lists/nope', ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reading list not found'}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  it('removes the list and saves once', async () => {
    const ctx = makeCtx({store: withList()});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/reading-lists/l1', ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(ctx.store[READING_LISTS_FILE].lists, []);
    assert.equal(ctx.calls.saveJSON.length, 1);
  });

  it('maps a store failure to the outer catch', async () => {
    const ctx = makeCtx({loadJSON() { throw new Error('unreadable'); }});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/reading-lists/l1', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid request'}]);
  });
});

describe('POST /api/reading-lists/:id/items (add)', () => {
  const ITEMS_PATH = '/api/reading-lists/l1/items';
  const withList = (items = []) => ({[READING_LISTS_FILE]: {lists: [{id: 'l1', name: 'A', items}]}});

  it('returns 429 before reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: ITEMS_PATH, ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'rl-items:127.0.0.1', maxPerMinute: 60}]);
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
      const ctx = makeCtx({store: withList()});
      const r = await invoke(routes, {method: 'POST', path: ITEMS_PATH, body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('accepts a non-string title, since the length guard is string-only', async () => {
    const ctx = makeCtx({store: withList()});
    const r = await invoke(routes, {method: 'POST', path: ITEMS_PATH, body: {path: '/a', title: 12345}, ctx});
    assert.equal(r.status, 200);
    assert.equal(ctx.store[READING_LISTS_FILE].lists[0].items[0].title, '/a');
  });

  it('returns 404 for an unknown list', async () => {
    const ctx = makeCtx({store: withList()});
    const r = await invoke(routes, {method: 'POST', path: '/api/reading-lists/nope/items', body: {path: '/a'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reading list not found'}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  it('dedups an item already in the list', async () => {
    const ctx = makeCtx({store: withList([{path: '/a'}])});
    const r = await invoke(routes, {method: 'POST', path: ITEMS_PATH, body: {path: '/a'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, message: 'Item already in list'}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  it('adds the item, bumps updatedAt and saves once', async () => {
    const ctx = makeCtx({store: {[READING_LISTS_FILE]: {lists: [{id: 'l1', name: 'A', items: [], updatedAt: 'old'}]}}});
    const r = await invoke(routes, {method: 'POST', path: ITEMS_PATH, body: {path: '/a', title: 'A Doc', type: 'reference'}, ctx});
    assert.equal(r.status, 200);
    const [item] = ctx.store[READING_LISTS_FILE].lists[0].items;
    const {addedAt, ...stable} = item;
    assert.deepEqual(stable, {path: '/a', title: 'A Doc', type: 'reference'});
    assert.notEqual(ctx.store[READING_LISTS_FILE].lists[0].updatedAt, 'old');
    assert.equal(ctx.calls.saveJSON.length, 1);
  });

  const TYPES = [
    {given: undefined, want: 'doc'},
    {given: 'unknown', want: 'doc'},
    {given: 'doc', want: 'doc'},
    {given: 'reference', want: 'reference'},
  ];
  for (const {given, want} of TYPES) {
    it(`normalises the type ${JSON.stringify(given)} to ${want}`, async () => {
      const ctx = makeCtx({store: withList()});
      await invoke(routes, {method: 'POST', path: ITEMS_PATH, body: {path: '/a', type: given}, ctx});
      assert.equal(ctx.store[READING_LISTS_FILE].lists[0].items[0].type, want);
    });
  }

  it('falls back to the path for the title', async () => {
    const ctx = makeCtx({store: withList()});
    await invoke(routes, {method: 'POST', path: ITEMS_PATH, body: {path: '/a'}, ctx});
    assert.equal(ctx.store[READING_LISTS_FILE].lists[0].items[0].title, '/a');
  });
});

describe('DELETE /api/reading-lists/:id/items (remove)', () => {
  const ITEMS_PATH = '/api/reading-lists/l1/items';
  const withList = (items = []) => ({[READING_LISTS_FILE]: {lists: [{id: 'l1', name: 'A', items}]}});

  const GUARDS = [
    {name: 'an omitted path', body: {}, status: 400, error: 'Missing path'},
    {name: 'a non-string path', body: {path: 7}, status: 400, error: 'Missing path'},
    {name: 'an item absent from the list', body: {path: '/gone'}, status: 404, error: 'Item not found in list'},
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx({store: withList([{path: '/a'}])});
      const r = await invoke(routes, {method: 'DELETE', path: ITEMS_PATH, body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('returns 404 for an unknown list', async () => {
    const r = await invoke(routes, {method: 'DELETE', path: '/api/reading-lists/nope/items', body: {path: '/a'}, ctx: makeCtx({store: withList([{path: '/a'}])})});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reading list not found'}]);
  });

  it('removes the item, bumps updatedAt and saves once', async () => {
    const ctx = makeCtx({store: {[READING_LISTS_FILE]: {lists: [{id: 'l1', items: [{path: '/a'}, {path: '/b'}], updatedAt: 'old'}]}}});
    const r = await invoke(routes, {method: 'DELETE', path: ITEMS_PATH, body: {path: '/a'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(ctx.store[READING_LISTS_FILE].lists[0].items.map(i => i.path), ['/b']);
    assert.notEqual(ctx.store[READING_LISTS_FILE].lists[0].updatedAt, 'old');
    assert.equal(ctx.calls.saveJSON.length, 1);
  });
});

describe('PATCH /api/reading-lists/:id/items (reorder)', () => {
  const ITEMS_PATH = '/api/reading-lists/l1/items';
  const three = () => ({[READING_LISTS_FILE]: {lists: [{id: 'l1', items: [{path: '/a'}, {path: '/b'}, {path: '/c'}], updatedAt: 'old'}]}});

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
      const ctx = makeCtx({store: three()});
      const r = await invoke(routes, {method: 'PATCH', path: ITEMS_PATH, body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('returns 404 for an unknown list', async () => {
    const r = await invoke(routes, {method: 'PATCH', path: '/api/reading-lists/nope/items', body: {path: '/a', direction: 'up'}, ctx: makeCtx({store: three()})});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reading list not found'}]);
  });

  const BOUNDARIES = [
    {name: 'the first item up', body: {path: '/a', direction: 'up'}},
    {name: 'the last item down', body: {path: '/c', direction: 'down'}},
  ];
  for (const {name, body} of BOUNDARIES) {
    it(`is a no-op when moving ${name}`, async () => {
      const ctx = makeCtx({store: three()});
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
      const ctx = makeCtx({store: three()});
      const r = await invoke(routes, {method: 'PATCH', path: ITEMS_PATH, body, ctx});
      assert.deepEqual(r.payload.list.items.map(i => i.path), order);
      assert.notEqual(r.payload.list.updatedAt, 'old');
      assert.equal(ctx.calls.saveJSON.length, 1);
    });
  }
});

// ── Export ────────────────────────────────────────────────────────────────

describe('GET /api/reading-lists/:id/export', () => {
  const EXPORT = '/api/reading-lists/l1/export';
  const list = over => ({[READING_LISTS_FILE]: {lists: [{id: 'l1', name: 'My List', items: [], ...over}]}});

  it('returns 404 for an unknown list', async () => {
    const r = await invoke(routes, {path: '/api/reading-lists/nope/export', ctx: makeCtx({store: list()})});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reading list not found'}]);
  });

  it('renders numbered markdown, tagging references and falling back to the path', async () => {
    const items = [
      {path: '/a', title: 'A Doc', type: 'doc'},
      {path: '/b', title: 'A Paper', type: 'reference'},
      {path: '/c'},
    ];
    const r = await invoke(routes, {path: EXPORT, ctx: makeCtx({store: list({items})})});
    assert.equal(r.written.body, '# My List\n\n1. [Doc] A Doc\n2. [Paper] A Paper\n3. [Doc] /c\n');
    assert.deepEqual(r.written.headers, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="My_List.md"',
      'Access-Control-Allow-Origin': '*',
    });
  });

  it('prepends the description when the list has one', async () => {
    const r = await invoke(routes, {path: EXPORT, ctx: makeCtx({store: list({description: 'About it', items: [{path: '/a'}]})})});
    assert.equal(r.written.body, '# My List\n\nAbout it\n\n1. [Doc] /a\n');
  });

  for (const [label, over] of [['an empty items array', {items: []}], ['no items key at all', {items: undefined}]]) {
    it(`renders the empty placeholder for ${label}`, async () => {
      const r = await invoke(routes, {path: EXPORT, ctx: makeCtx({store: list(over)})});
      assert.equal(r.written.body, '# My List\n\n_No items in this list._\n');
    });
  }

  it('treats any non-bibtex format as the markdown default', async () => {
    const r = await invoke(routes, {path: EXPORT, query: {format: 'json'}, ctx: makeCtx({store: list({items: [{path: '/a'}]})})});
    assert.equal(r.written.headers['Content-Type'], 'text/markdown; charset=utf-8');
  });

  it('returns 500 when the list id cannot be decoded', async () => {
    const ctx = makeCtx({store: list()});
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
      let reads = 0;
      const base = mockFs(refs === null ? {} : {[BIB]: refs});
      const fs = {...base, readFileSync: p => { reads++; return base.readFileSync(p); }};
      const references = referencesForCore(bibliographyProvides.references);
      return {ctx: makeCtx({fs, references, store: list({items})}), reads: () => reads};
    };

    // The loader memoizes on mtime and size, and every fixture here starts the
    // mock clock at the same instant, so a warm memo would let one test serve
    // the next one's export. Start each test cold, which also makes the memo
    // test below prove the memo rather than observe an already-cached parse.
    beforeEach(() => _resetReferencesCache());

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
      ['references.yaml is missing', [{path: 'article2021', type: 'reference'}], null],
      ['references.yaml is malformed', [{path: 'article2021', type: 'reference'}], '\tbroken: ['],
    ]) {
      it(`emits a lone newline when ${label}`, async () => {
        const {ctx} = bibCtx(items, refs);
        const r = await invoke(routes, {path: EXPORT, query: {format: 'bibtex'}, ctx});
        assert.equal(r.written.body, '\n');
      });
    }

    it('memoizes the bibliography parse across two exports', async () => {
      const {ctx, reads} = bibCtx([{path: 'article2021', type: 'reference'}]);
      await invoke(routes, {path: EXPORT, query: {format: 'bibtex'}, ctx});
      const after = reads();
      await invoke(routes, {path: EXPORT, query: {format: 'bibtex'}, ctx});
      assert.equal(reads(), after, 'the second export reuses the shared memo');
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
