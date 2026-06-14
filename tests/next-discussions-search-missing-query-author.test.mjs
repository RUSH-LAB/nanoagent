import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// discussions.js is CommonJS; load the REAL route module the way the sibling
// discussions tests do, so these cases exercise the shipped GET
// messages/search handler (server/routes/discussions.js) instead of a
// reimplementation. The existing tests/discussions-search.test.mjs defines a
// local searchMessages copy and never requires the real route, so the
// missing-query 400, the author-field match, the malformed-field fallbacks, and
// the empty-result payload are otherwise unpinned on the shipped handler.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');

// Drive the GET /api/discussions/:channelId/messages/search handler with a
// minimal mocked ctx (json capture plus a loadJSON mock), copied from
// tests/next-discussions-list-channels-projection.test.mjs, and build the `?q=`
// search URL the way tests/next-discussions-channel-hasown-guard.test.mjs does.
//
// The handler reads the store once via loadJSON(DISCUSSIONS_FILE), but only
// AFTER the missing-query guard. So loadJSON doubles as a tripwire: when no
// `store` is supplied the mock throws the instant it runs, which proves the 400
// returns before any store read (loadCount also stays 0). When a `store` is
// supplied the mock returns it and counts the single read.
const DISCUSSIONS_FILE = '/tmp/discussions-search-missing-query-author-test.json';

async function invokeSearch({ channelId = 'general', search = '', store } = {}) {
  const pathname = `/api/discussions/${channelId}/messages/search`;
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadArg;
  let loadCount = 0;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    loadJSON(file) {
      loadCount += 1;
      loadArg = file;
      if (store === undefined) {
        throw new Error('loadJSON must not run for a missing query');
      }
      return store;
    },
    DISCUSSIONS_FILE,
  };
  await discussionsRoutes(req, res, url, pathname, ctx);
  return { captured, loadArg, loadCount };
}

// A store with one real channel. The author "Bjornsson" appears on two messages
// and in no message text, so a `?q=bjornsson` search matches purely on the
// author field. The query is lower-cased by the handler, so the capitalized
// author also exercises the case-insensitive `(m.author||'').toLowerCase()` arm.
const store = {
  channels: { general: { name: 'General', topic: 'Chat' } },
  messages: {
    general: [
      { id: 'm0', author: 'Alice', text: 'hello world' },
      { id: 'm1', author: 'Bjornsson', text: 'second message' },
      { id: 'm2', author: 'Bjornsson', text: 'third note' },
    ],
  },
};

// A store whose messages are missing text, author, or both. The handler reads
// each field through a `(m.text||'')` / `(m.author||'')` fallback, so a missing
// field must neither throw nor match, while the present field still matches.
const malformedStore = {
  channels: { general: { name: 'General', topic: 'Chat' } },
  messages: {
    general: [
      { id: 'm0', author: 'Alice', text: 'findme here' },
      { id: 'm1', author: 'Bob' },          // no text field
      { id: 'm2', text: 'orphan text' },     // no author field
      { id: 'm3' },                          // neither field
    ],
  },
};

describe('discussions GET messages/search missing-query and author match', () => {
  // ── Case 1: the missing-query 400 returns before any store read ──
  for (const [label, search] of [
    ['no q param (the null path)', ''],
    ['an empty ?q= (the `|| ""` fallback)', '?q='],
    ['a whitespace-only ?q=%20%20 (.trim() collapses it to falsy)', '?q=%20%20'],
  ]) {
    it(`returns 400 {error: "Missing query"} for ${label}, without reading the store`, async () => {
      const { captured, loadCount } = await invokeSearch({ search });
      assert.equal(captured.status, 400);
      assert.deepStrictEqual(captured.payload, { error: 'Missing query' });
      assert.equal(loadCount, 0, 'loadJSON must not run before the missing-query guard');
    });
  }

  it('a non-empty query reaches loadJSON, proving the tripwire is live (not vacuous)', async () => {
    // With no store supplied, a query that clears the guard must hit the
    // loadJSON tripwire and throw. This guarantees the loadCount===0 assertions
    // above hold because the guard returns early, not because loadJSON is inert.
    await assert.rejects(
      invokeSearch({ search: '?q=hello' }),
      /loadJSON must not run for a missing query/,
    );
  });

  // ── Case 2: a query that matches only an author field ──
  it('returns 200 with the messages whose author matches, even with no text match', async () => {
    const { captured, loadArg, loadCount } = await invokeSearch({ search: '?q=bjornsson', store });
    assert.equal(captured.status, 200);
    assert.equal(loadCount, 1);
    assert.equal(loadArg, DISCUSSIONS_FILE);
    assert.deepStrictEqual(captured.payload, {
      results: [
        { id: 'm1', author: 'Bjornsson', text: 'second message' },
        { id: 'm2', author: 'Bjornsson', text: 'third note' },
      ],
      total: 2,
    });
  });

  // ── Case 3: malformed-field messages do not throw and skip when unmatched ──
  it('does not throw when messages are missing text and/or author; unmatched ones are skipped', async () => {
    const { captured, loadCount } = await invokeSearch({ search: '?q=findme', store: malformedStore });
    assert.equal(captured.status, 200);
    assert.equal(loadCount, 1);
    // Only the well-formed message matches; the field-less messages fall through
    // the `(m.text||'')` / `(m.author||'')` guards without throwing or matching.
    assert.deepStrictEqual(captured.payload, {
      results: [{ id: 'm0', author: 'Alice', text: 'findme here' }],
      total: 1,
    });
  });

  it('matches via author when the text field is absent (text fallback to "")', async () => {
    const { captured } = await invokeSearch({ search: '?q=bob', store: malformedStore });
    assert.equal(captured.status, 200);
    assert.deepStrictEqual(captured.payload, {
      results: [{ id: 'm1', author: 'Bob' }],
      total: 1,
    });
  });

  it('matches via text when the author field is absent (author fallback to "")', async () => {
    const { captured } = await invokeSearch({ search: '?q=orphan', store: malformedStore });
    assert.equal(captured.status, 200);
    assert.deepStrictEqual(captured.payload, {
      results: [{ id: 'm2', text: 'orphan text' }],
      total: 1,
    });
  });

  // ── Case 4: a query that matches nothing in an existing channel ──
  it('returns 200 {results: [], total: 0} when nothing matches in an existing channel', async () => {
    const { captured, loadCount } = await invokeSearch({ search: '?q=zzzznomatch', store });
    assert.equal(captured.status, 200);
    assert.equal(loadCount, 1);
    assert.deepStrictEqual(captured.payload, { results: [], total: 0 });
  });
});
