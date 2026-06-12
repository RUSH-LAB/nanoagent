import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// ── GET /api/preferences ──
// Invoke the preferences GET handler with a minimal mocked ctx and capture the
// response handed to json(res, status, payload). loadJSON returns the supplied
// store verbatim: a plain object literal, so inherited keys like constructor and
// toString resolve to truthy Object.prototype functions exactly as on the real
// loadJSON result. The read path never writes, so saveJSON is unneeded.
async function invokePreferences({ userId, prefs }) {
  const query = userId === undefined ? '' : `?userId=${encodeURIComponent(userId)}`;
  const pathname = '/api/preferences';
  const url = new URL(`http://localhost${pathname}${query}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp',
    loadJSON: () => prefs,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return captured;
}

// A real user with a populated preferences object. The literal defines no own
// constructor / toString / valueOf key, so each resolves to its inherited
// Object.prototype function when read without the Object.hasOwn guard. The old
// `prefs[userId] || {}` form then returns that function, and JSON.stringify drops
// a function-valued key, so the body serializes to `{}` rather than the
// contracted `{"preferences":{}}`. `__proto__` is intentionally excluded here: it
// resolves to Object.prototype, which serializes to a correct `{}`, so it is not
// malformed for this object-returning handler. The analytics handler below does
// exercise `__proto__`, where it corrupts a numeric field instead.
const PREFS = {
  alice: { theme: 'dark', fontSize: 14, updatedAt: '2024-06-01T00:00:00Z' },
};

const PREFS_PROTO_KEYS = ['constructor', 'toString', 'valueOf'];

describe('GET /api/preferences own-property userId guard', () => {
  for (const userId of PREFS_PROTO_KEYS) {
    it(`returns a well-formed empty preferences body for the inherited key "${userId}"`, async () => {
      const r = await invokePreferences({ userId, prefs: PREFS });
      assert.equal(r.status, 200);
      // The body must carry an own `preferences` key equal to {}, not a function
      // that JSON.stringify silently drops. Round-trip through JSON to prove the
      // serialized body keeps the key (the pre-fix bug serializes to `{}`), then
      // check the structural value.
      assert.equal(JSON.stringify(r.payload), '{"preferences":{}}');
      assert.deepEqual(r.payload, { preferences: {} });
    });
  }

  it('returns the stored preferences for a real own-key user', async () => {
    const r = await invokePreferences({ userId: 'alice', prefs: PREFS });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { preferences: PREFS.alice });
  });

  it('returns an empty preferences object for an absent ordinary userId', async () => {
    const r = await invokePreferences({ userId: 'nobody', prefs: PREFS });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { preferences: {} });
    assert.equal(JSON.stringify(r.payload), '{"preferences":{}}');
  });
});

// ── GET /api/analytics/page ──
// loadJSON is called four times, once per store file; the mock switches on the
// file token wired into ctx so each store is returned independently. Only the
// analytics counts and the comments map participate in the prototype-key bug;
// the bookmarks and reading-list lookups already run Array methods on a `|| []`
// fallback, so they are unaffected.
async function invokeAnalytics({ pagePath, stores }) {
  const query = pagePath === undefined ? '' : `?path=${encodeURIComponent(pagePath)}`;
  const pathname = '/api/analytics/page';
  const url = new URL(`http://localhost${pathname}${query}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp',
    ANALYTICS_FILE: 'analytics',
    COMMENTS_FILE: 'comments',
    BOOKMARKS_FILE: 'bookmarks',
    READING_LISTS_FILE: 'readingLists',
    loadJSON: (file) => stores[file] || {},
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return captured;
}

// Stores that define one real page path and no own proto-named key. Reading a
// proto key without the Object.hasOwn guard yields an inherited Object.prototype
// member rather than an absent-page miss: for "constructor", `views` becomes a
// function (dropped by JSON.stringify) and `comments` becomes that function's
// arity (Object.length === 1). Every such key must instead collapse to 0.
const ANALYTICS_BUG_STORES = {
  analytics: { counts: { 'content/intro.md': 5 } },
  comments: { 'content/intro.md': [{ id: 'c1' }] },
  bookmarks: { bookmarks: [] },
  readingLists: { lists: [] },
};

// Stores where the queried page is a genuine own key across every lookup, so the
// fix must leave the payload byte-identical to the pre-fix output.
const ANALYTICS_OK_STORES = {
  analytics: { counts: { 'content/intro.md': 42 } },
  comments: { 'content/intro.md': [{ id: 'c1' }, { id: 'c2' }] },
  bookmarks: { bookmarks: [{ path: 'content/intro.md' }] },
  readingLists: { lists: [{ items: [{ path: 'content/intro.md' }] }] },
};

const ANALYTICS_PROTO_KEYS = ['constructor', 'toString', 'valueOf', '__proto__'];

describe('GET /api/analytics/page own-property path guard', () => {
  for (const pagePath of ANALYTICS_PROTO_KEYS) {
    it(`treats the inherited key "${pagePath}" as an absent page`, async () => {
      const r = await invokeAnalytics({ pagePath, stores: ANALYTICS_BUG_STORES });
      assert.equal(r.status, 200);
      // Pre-fix, `views` is an inherited Object.prototype member (a function for
      // constructor / toString / valueOf, which JSON.stringify drops so the key
      // goes missing) rather than a number. Both fields must collapse to the
      // absent-page value 0.
      assert.equal(r.payload.views, 0);
      assert.equal(r.payload.comments, 0);
      const body = JSON.parse(JSON.stringify(r.payload));
      assert.ok('views' in body, 'views must survive JSON serialization');
      assert.equal(body.views, 0);
      assert.equal(body.comments, 0);
    });
  }

  it('reports views 0 and comment count 0 (not 1) for path=constructor', async () => {
    const r = await invokeAnalytics({ pagePath: 'constructor', stores: ANALYTICS_BUG_STORES });
    assert.equal(r.status, 200);
    assert.equal(r.payload.views, 0);
    assert.equal(r.payload.comments, 0);
  });

  it('returns byte-identical analytics for a real own-key page path', async () => {
    const r = await invokeAnalytics({ pagePath: 'content/intro.md', stores: ANALYTICS_OK_STORES });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      path: 'content/intro.md',
      views: 42,
      comments: 2,
      isBookmarked: true,
      inReadingLists: 1,
    });
  });

  it('returns zeros for an absent ordinary page path', async () => {
    const r = await invokeAnalytics({ pagePath: 'content/missing.md', stores: ANALYTICS_OK_STORES });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      path: 'content/missing.md',
      views: 0,
      comments: 0,
      isBookmarked: false,
      inReadingLists: 0,
    });
  });
});
