import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import nodePath from 'node:path';

// research-tools.js is CommonJS; load the REAL module via createRequire the way the
// sibling search/replace suites (next-searchreplace-fold-total, next-searchreplace-
// split-once) and the guard suite next-importbibtex-guards do. The default export is
// the async dispatcher research_tools_routes(req, res, url, pathname, ctx).
const require = createRequire(import.meta.url);
const researchToolsRoutes = require('../server/routes/research-tools.js');

const ROOT = '/virtual';
const PATHNAME = '/api/search/replace';

// A recording filesystem whose three methods push an ordered event the moment they
// are called. Every input-validation guard in POST /api/search/replace returns
// BEFORE the content walk, so a faithful guard test asserts this list stays empty:
// proof the rejected request performed zero filesystem traversal (no readdirSync,
// no readFileSync, no writeFileSync). callReplace shares this same events list for
// invalidateCache too, so an empty list additionally proves the handler never
// reached invalidateCache('search'). It mirrors the ordered I/O recorder in the
// sibling next-importbibtex-guards suite.
function makeRecordingFs() {
  const events = [];
  const fs = {
    readdirSync() { events.push('readdir'); return []; },
    readFileSync() { events.push('read'); return ''; },
    writeFileSync() { events.push('write'); },
  };
  return { fs, events };
}

// Invoke the real handler with a mocked ctx, mirroring the makeFs/callReplace
// injection point in next-searchreplace-fold-total.test.mjs, extended with the
// knobs the guard ladder needs: `rateLimited` flips the limiter to drive the 429,
// `maxTextLength` shrinks MAX_TEXT_LENGTH so a short string can trip the too-long
// guards, and `readBodyThrows` makes readBody reject to reach the outer catch.
// `rateLimitCalls` records every (key, limit) pair the handler passes to rateLimit
// so the 429 case can pin this handler's distinct `search-replace:<addr>` needle.
async function callReplace({ body, rateLimited = false, maxTextLength = 1_000_000, readBodyThrows = false } = {}) {
  const { fs, events } = makeRecordingFs();
  const rateLimitCalls = [];
  let captured = null;
  const ctx = {
    fs,
    path: nodePath,
    PROJECT_ROOT: ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    MAX_TEXT_LENGTH: maxTextLength,
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return !rateLimited; },
    invalidateCache: () => { events.push('invalidate'); },
    readBody: async () => {
      if (readBodyThrows) throw new Error('body stream failed');
      return body;
    },
    json(res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return res;
    },
  };
  const url = new URL(`http://localhost${PATHNAME}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await researchToolsRoutes(req, res, url, PATHNAME, ctx);
  return { ...captured, events, rateLimitCalls };
}

describe('POST /api/search/replace guard ladder characterization', () => {
  it('returns 429 with the rate-limit error and touches no filesystem when throttled', async () => {
    const { status, payload, events, rateLimitCalls } = await callReplace({
      body: { search: 'foo', replace: 'bar' },
      rateLimited: true,
    });

    assert.equal(status, 429);
    assert.deepEqual(payload, { error: 'Too many requests. Try again in a minute.' });
    // The 429 string is shared across handlers, so pin the distinct needle: this
    // handler keys the limiter on `search-replace:<remoteAddress>` with a limit of 5.
    assert.deepEqual(rateLimitCalls, [{ key: 'search-replace:127.0.0.1', limit: 5 }]);
    // The limiter check sits before the try, so a throttled request reads nothing.
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing search string when the body has no search field', async () => {
    const { status, payload, events } = await callReplace({ body: {} });

    assert.equal(status, 400);
    assert.deepEqual(payload, { error: 'Missing search string' });
    // The guard rejects before the content walk: no filesystem traversal occurs.
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing search string when search is an empty string', async () => {
    // An empty string is falsy, so `!search` trips the same guard as an omitted one.
    const { status, payload, events } = await callReplace({ body: { search: '', replace: 'x' } });

    assert.equal(status, 400);
    assert.deepEqual(payload, { error: 'Missing search string' });
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing search string when search is a number, not a string', async () => {
    // A non-string search is caught by the `typeof search !== 'string'` half of the guard.
    const { status, payload, events } = await callReplace({ body: { search: 123, replace: 'x' } });

    assert.equal(status, 400);
    assert.deepEqual(payload, { error: 'Missing search string' });
    assert.deepEqual(events, []);
  });

  it('returns 400 Search string too long when search exceeds MAX_TEXT_LENGTH', async () => {
    // Shrink the cap to 10 and pass an 11-character search with a valid replace so the
    // length guard, not the missing-string or replace guards, is the one that fires.
    const { status, payload, events } = await callReplace({
      body: { search: 'x'.repeat(11), replace: 'ok' },
      maxTextLength: 10,
    });

    assert.equal(status, 400);
    assert.deepEqual(payload, { error: 'Search string too long' });
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing replace string when replace is omitted', async () => {
    // A valid search with no replace leaves replace undefined, a non-string, so the
    // `typeof replace !== 'string'` guard fires.
    const { status, payload, events } = await callReplace({ body: { search: 'hello' } });

    assert.equal(status, 400);
    assert.deepEqual(payload, { error: 'Missing replace string' });
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing replace string when replace is a number, not a string', async () => {
    const { status, payload, events } = await callReplace({ body: { search: 'hello', replace: 5 } });

    assert.equal(status, 400);
    assert.deepEqual(payload, { error: 'Missing replace string' });
    assert.deepEqual(events, []);
  });

  it('returns 400 Replace string too long when replace exceeds MAX_TEXT_LENGTH', async () => {
    // A short valid search clears the search guards; an 11-character replace then trips
    // the replace length guard under the shrunken cap of 10.
    const { status, payload, events } = await callReplace({
      body: { search: 'x', replace: 'y'.repeat(11) },
      maxTextLength: 10,
    });

    assert.equal(status, 400);
    assert.deepEqual(payload, { error: 'Replace string too long' });
    assert.deepEqual(events, []);
  });

  it('returns 400 dryRun must be a boolean when dryRun is a non-boolean', async () => {
    // Valid search and replace, but a string dryRun trips the final type guard. An
    // omitted dryRun is allowed and would pass this guard.
    const { status, payload, events } = await callReplace({
      body: { search: 'find', replace: 'repl', dryRun: 'yes' },
    });

    assert.equal(status, 400);
    assert.deepEqual(payload, { error: 'dryRun must be a boolean' });
    assert.deepEqual(events, []);
  });

  it('returns 400 Invalid request when readBody throws, without any filesystem I/O', async () => {
    // The limiter passes, then readBody rejects inside the try, so the outer catch
    // answers 400. The `Invalid request` string is shared, so the gap is pinned by
    // driving THIS handler's /api/search/replace pathname directly, not by the string.
    const { status, payload, events } = await callReplace({ readBodyThrows: true });

    assert.equal(status, 400);
    assert.deepEqual(payload, { error: 'Invalid request' });
    assert.deepEqual(events, []);
  });
});
