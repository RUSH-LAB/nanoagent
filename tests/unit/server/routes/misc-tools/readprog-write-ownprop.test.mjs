import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../../../../../server/routes/misc-tools.js');

// Mirrors server-utils.js sanitizeText: non-strings become '', strings are sliced
// to a max length. Critically it does NOT strip prototype-member names, so a userId
// of "toString" survives sanitizing unchanged, exactly as in production.
const MAX_TEXT_LENGTH = 10000;
const sanitizeText = (str) => (typeof str === 'string' ? str.slice(0, MAX_TEXT_LENGTH) : '');

// Invoke the POST /api/reading-progress handler with a mocked ctx. `store` is the
// reading-progress file (keyed by userId) that loadJSON returns verbatim; it must be
// a plain object literal so inherited names (toString, valueOf, hasOwnProperty)
// resolve to truthy inherited functions exactly as on a real loadJSON result. A
// capturing saveJSON records the object the handler tried to persist (the handler
// passes its live `data` object, so this is the persisted state). `Object` is never
// injected into ctx, so the own-property guard exercises the real global Object.hasOwn.
async function postReadingProgress({ body, store }) {
  let captured = null;
  let saved = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/next-readprog-write-ownprop-test',
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => store,
    sanitizeText,
    saveJSON: (_file, data) => { saved = data; },
    json: (_res, status, payload) => { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  const url = new URL('http://localhost/api/reading-progress');
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await miscToolsRoutes(req, res, url, '/api/reading-progress', ctx);
  return { captured, saved };
}

// Object.prototype member names that are NOT in the handler's PROTO_KEYS denylist
// (__proto__, constructor, prototype). On a plain object literal each resolves to a
// truthy inherited function.
const INHERITED = ['toString', 'valueOf', 'hasOwnProperty'];

describe('POST /api/reading-progress own-property userId guard', () => {
  // Anti-tautology: against the reverted `if (!data[safeUserId]) data[safeUserId] = {}`
  // form each inherited userId reads a truthy inherited function (e.g.
  // Object.prototype.toString), so the init is skipped and the write lands ON that
  // inherited function as `fn[safePagePath] = {...}`. Because the name is not an own
  // key of `data`, the subsequent saveJSON -> JSON.stringify(data) drops it entirely:
  // a false 200 with nothing persisted, plus mutation of a shared prototype function.
  // The own-property guard (Object.hasOwn) instead creates a real own key on `data`,
  // so the entry persists and Object.prototype is never touched.
  for (const userId of INHERITED) {
    it(`creates an own key and persists for the inherited userId "${userId}"`, async () => {
      const pagePath = `content/${userId}.md`;
      const store = {};
      // Snapshot the inherited function so we can prove it is never mutated.
      const protoMember = Object.prototype[userId];
      const { captured, saved } = await postReadingProgress({
        body: { userId, pagePath, progress: 50 },
        store,
      });

      // The handler reports success.
      assert.deepEqual(captured, { status: 200, payload: { success: true } });

      // An OWN key was created on data whose value is a plain object (not the
      // inherited function it would have shadowed under the buggy form).
      assert.equal(Object.hasOwn(store, userId), true);
      assert.equal(typeof store[userId], 'object');
      assert.notEqual(store[userId], protoMember);
      assert.equal(store[userId][pagePath].progress, 50);
      assert.equal(typeof store[userId][pagePath].lastRead, 'string');

      // It persisted: saveJSON received the same object, and the own-key entry is
      // present in the saved state (this is exactly what JSON.stringify would keep).
      assert.equal(saved, store);
      assert.equal(Object.hasOwn(saved, userId), true);
      assert.equal(saved[userId][pagePath].progress, 50);

      // Object.prototype was NOT polluted: the inherited member is the unchanged
      // original and carries no page entry.
      assert.equal(Object.prototype[userId], protoMember);
      assert.equal(Object.hasOwn(protoMember, pagePath), false);
    });
  }

  it('records progress for a normal userId (200, persisted as an own key)', async () => {
    const store = {};
    const { captured, saved } = await postReadingProgress({
      body: { userId: 'reader', pagePath: 'content/intro.md', progress: 42 },
      store,
    });
    assert.deepEqual(captured, { status: 200, payload: { success: true } });
    assert.equal(Object.hasOwn(saved, 'reader'), true);
    assert.equal(saved.reader['content/intro.md'].progress, 42);
    assert.equal(typeof saved.reader['content/intro.md'].lastRead, 'string');
  });

  it('preserves existing pages for an existing own-key user (init is skipped)', async () => {
    // The user already has an own key with one page. The guard must not re-init and
    // wipe it; the new page is merged alongside the existing one.
    const store = { reader: { 'content/old.md': { progress: 100, lastRead: '2026-01-01T00:00:00.000Z' } } };
    const { captured, saved } = await postReadingProgress({
      body: { userId: 'reader', pagePath: 'content/new.md', progress: 30 },
      store,
    });
    assert.deepEqual(captured, { status: 200, payload: { success: true } });
    assert.equal(saved.reader['content/old.md'].progress, 100);
    assert.equal(saved.reader['content/old.md'].lastRead, '2026-01-01T00:00:00.000Z');
    assert.equal(saved.reader['content/new.md'].progress, 30);
  });

  it('clamps progress into the 0..100 range', async () => {
    const over = await postReadingProgress({
      body: { userId: 'reader', pagePath: 'content/a.md', progress: 150 },
      store: {},
    });
    assert.equal(over.saved.reader['content/a.md'].progress, 100);
    const under = await postReadingProgress({
      body: { userId: 'reader', pagePath: 'content/b.md', progress: -5 },
      store: {},
    });
    assert.equal(under.saved.reader['content/b.md'].progress, 0);
  });
});
