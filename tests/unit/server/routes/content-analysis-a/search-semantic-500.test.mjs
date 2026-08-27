import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the real module the way the sibling
// route suites do (see tests/next-search-semantic-missing-query.test.mjs).
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');

// Note: '/api/search/semantic' is documented substring search, NOT banned
// retrieval. The handler comment (content-analysis-a.js:737-741) states it is
// plain case-insensitive substring matching with hand-weighted relevance
// scoring, with no embeddings, vectors, or semantic retrieval (see
// .claude/CONSTRAINTS.md); the '/semantic' path is kept only for caller
// compatibility. This suite characterizes that existing endpoint's 500 error
// path and adds no retrieval logic. The word "semantic" is unavoidable here
// because it appears in both the pathname and the error string.
const ROUTE = '/api/search/semantic';

// A mock fs whose directory read throws. The handler's content walk evaluates
// fs.readdirSync(contentDir) at the top of scan(); that top-level call is NOT
// wrapped by the inner per-file try/catch (which guards only fs.readFileSync),
// so a throwing readdirSync propagates out of scan() to the handler's outer
// catch, which answers 500 {error: 'Semantic search failed'}. Both read entry
// points count their calls so the test can prove which read produced the 500: a
// real hit shows readdirSync ran once (the content dir) and readFileSync never
// ran, i.e. the inner catch did not swallow the throw.
function makeThrowingFs() {
  const counts = { readdir: 0, readFile: 0 };
  const fs = {
    readdirSync() {
      counts.readdir += 1;
      throw new Error('readdirSync failed: content dir is unreadable');
    },
    readFileSync() {
      counts.readFile += 1;
      throw new Error('readFileSync should not run: the top-level scan threw first');
    },
  };
  return { fs, counts };
}

// Drive GET /api/search/semantic entirely in process: no network, no server.
// The handler answers through json(res, status, body), which we capture. The
// ctx shape mirrors tests/next-search-semantic-missing-query.test.mjs: fs, path,
// and PROJECT_ROOT are read only inside the post-guard try, so a real query
// (?q=...) clears the 'Missing query' guard and reaches the throwing scan.
// ALLOWED_EXTS (also destructured by the handler) is intentionally omitted:
// readdirSync throws at the top of scan() before the per-file extension check
// at line 753 ever reads it.
async function getSemantic(search) {
  const { fs, counts } = makeThrowingFs();
  const url = new URL(`http://localhost${ROUTE}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = {
    writableEnded: false,
    writeHead() { return this; },
    end() { this.writableEnded = true; return this; },
  };
  let captured = null;
  const ctx = {
    json(_res, status, body) { captured = { status, body }; res.writableEnded = true; return captured; },
    fs,
    path,
    PROJECT_ROOT: '/fake/root',
    CORS_ORIGIN: '*',
  };
  await routes(req, res, url, ROUTE, ctx);
  return { captured, counts };
}

describe('GET /api/search/semantic: 500 when the content scan throws', () => {
  it('returns 500 {error: "Semantic search failed"} when fs.readdirSync throws on the content dir', async () => {
    const { captured, counts } = await getSemantic('?q=foo');
    // The golden: a query clears the guard, the top-level scan throws, and the
    // outer catch maps it to 500 'Semantic search failed'.
    assert.deepStrictEqual(captured, { status: 500, body: { error: 'Semantic search failed' } });
    // Provenance of the 500: readdirSync ran once (on the content dir) and threw
    // before any file read, confirming the throw came from the un-inner-guarded
    // top-level scan(contentDir), not from a swallowed per-file readFileSync.
    assert.equal(counts.readdir, 1, 'the top-level content scan invoked readdirSync once');
    assert.equal(counts.readFile, 0, 'readFileSync never ran: readdirSync threw first');
  });

  it('maps the same scan throw to 500 for any non-empty query (query-agnostic, post-guard)', async () => {
    const { captured, counts } = await getSemantic('?q=test%20phrase');
    // 'test phrase' is a distinct, multi-word query that also clears the guard;
    // the 500 path is reached identically, showing the error is produced by the
    // scan throw rather than anything specific to the 'foo' query above.
    assert.deepStrictEqual(captured, { status: 500, body: { error: 'Semantic search failed' } });
    assert.equal(counts.readdir, 1, 'the top-level content scan invoked readdirSync once');
    assert.equal(counts.readFile, 0, 'readFileSync never ran: readdirSync threw first');
  });
});
