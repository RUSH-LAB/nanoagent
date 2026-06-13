import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'node:path';

// research-tools.js is CommonJS; load the REAL module by bare path the way the
// other server tests do, so we exercise the shipped handler rather than a copy.
const require = createRequire(import.meta.url);
const researchTools = require('../server/routes/research-tools.js');

// The first two statements of the BM25 full-text GET /api/search handler are the
// missing-query guard:
//
//   const query = (url.searchParams.get('q') || '').toLowerCase().trim();
//   if (!query) return json(res, 400, {error: 'Missing query'});
//
// which returns before the cached('search:index', ...) index build and any fs
// scan. The existing BM25 suites (next-bm25-hyphen-query, next-drop-search-index
// -lower-dup) only ever pass a non-empty q, so this 400 branch had no assertions.
//
// We drive the real handler with ctx.cached and ctx.fs as tripwires: each flips a
// flag and throws the instant it is touched, so a correct guard leaves both flags
// false. We anchor on method GET plus pathname /api/search (the "Missing query"
// message is shared by other search routes in other modules). `q` is sent only
// when withQuery is true, so the no-q case sends a bare /api/search whose
// searchParams.get('q') is null, exercising the `|| ''` fallback.
async function runSearch(rawQuery, { withQuery = true } = {}) {
  let cachedCalled = false;
  let fsTouched = false;

  const cached = () => {
    cachedCalled = true;
    throw new Error('cached() must not run for a missing query');
  };
  // A Proxy throws on ANY property read, so even reaching for fs.readdirSync
  // before calling it trips the wire: stronger proof than per-method stubs that
  // the guard returns before the handler ever touches the filesystem.
  const fs = new Proxy({}, {
    get(_target, prop) {
      fsTouched = true;
      throw new Error(`fs.${String(prop)} must not be touched for a missing query`);
    },
  });

  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT: '/tmp/never-read-for-a-missing-query',
    cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };

  const target = withQuery
    ? `http://localhost/api/search?q=${encodeURIComponent(rawQuery)}`
    : 'http://localhost/api/search';
  const url = new URL(target);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };

  await researchTools(req, res, url, '/api/search', ctx);
  return { captured, cachedCalled, fsTouched };
}

describe('GET /api/search missing-query guard returns 400 before the index build', () => {
  it('returns 400 {error: "Missing query"} when no q param is present (the null path)', async () => {
    const { captured, cachedCalled, fsTouched } = await runSearch(undefined, { withQuery: false });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing query' });
    assert.equal(cachedCalled, false, 'the cached tripwire stayed untouched');
    assert.equal(fsTouched, false, 'the fs tripwire stayed untouched');
  });

  it('returns the same 400 for an empty ?q= (the `|| ""` fallback path)', async () => {
    const { captured, cachedCalled, fsTouched } = await runSearch('');
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing query' });
    assert.equal(cachedCalled, false, 'the cached tripwire stayed untouched');
    assert.equal(fsTouched, false, 'the fs tripwire stayed untouched');
  });

  it('returns the same 400 for a whitespace-only ?q=%20%20 (.trim() collapses it to falsy)', async () => {
    const { captured, cachedCalled, fsTouched } = await runSearch('  ');
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing query' });
    assert.equal(cachedCalled, false, 'the cached tripwire stayed untouched');
    assert.equal(fsTouched, false, 'the fs tripwire stayed untouched');
  });

  it('lets a non-empty query past the guard, proving the tripwires are live', async () => {
    // q='hello' is truthy after toLowerCase().trim(), so the guard does not fire
    // and control reaches cached('search:index', ...). The cached tripwire then
    // throws, which the handler's own try/catch turns into a 500. This proves the
    // 400 above is specific to an empty query and that the tripwires really do
    // fire when reached, so the "untouched" assertions above are not vacuous.
    const { captured, cachedCalled } = await runSearch('hello');
    assert.equal(cachedCalled, true, 'a non-empty query reaches the cached tripwire');
    assert.notDeepEqual(captured.payload, { error: 'Missing query' });
    assert.deepEqual(captured, { status: 500, payload: { error: 'Search failed' } });
  });
});
