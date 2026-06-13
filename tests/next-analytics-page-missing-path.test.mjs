import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// Drive GET /api/analytics/page in process with a minimal mocked ctx and capture
// the response handed to json(res, status, payload). loadJSON is a call-counter
// tripwire: it records how many times the handler read a store and returns a
// benign empty object, so the missing-path guard can be proven to return BEFORE
// the first store read (call count 0). The first statements after that route
// match are:
//   const pagePath = url.searchParams.get('path');
//   if (!pagePath) return json(res, 400, {error: 'Missing path'});
// which short-circuits ahead of any loadJSON.
//
// Every case is anchored on method GET plus pathname /api/analytics/page. The
// "Missing path" message is shared by other handlers (for example DELETE
// /api/pins), so it is not a valid sole anchor; routing the request through the
// real dispatcher with this method and pathname is what pins the assertion to
// the analytics handler.
async function invokeAnalyticsPage({ pagePath }) {
  const pathname = '/api/analytics/page';
  // Build the query so each branch hits the intended input: no `path` key when
  // pagePath is undefined (searchParams.get returns null), an explicit empty
  // `?path=` when it is the empty string (searchParams.get returns ''), and a
  // real value otherwise. Both null and '' are falsy, so both take the guard.
  let search = '';
  if (pagePath === '') search = '?path=';
  else if (pagePath !== undefined) search = `?path=${encodeURIComponent(pagePath)}`;
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadJSONCount = 0;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp',
    ANALYTICS_FILE: 'analytics',
    COMMENTS_FILE: 'comments',
    BOOKMARKS_FILE: 'bookmarks',
    READING_LISTS_FILE: 'readingLists',
    loadJSON() {
      loadJSONCount++;
      return {};
    },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, loadJSONCount };
}

describe('GET /api/analytics/page missing-path guard', () => {
  it('returns 400 {error: "Missing path"} with no path query, before any store read', async () => {
    const { captured, loadJSONCount } = await invokeAnalyticsPage({ pagePath: undefined });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing path' });
    // The guard returns ahead of the first loadJSON, so no store was read.
    assert.equal(loadJSONCount, 0);
  });

  it('returns 400 {error: "Missing path"} for an empty ?path=, before any store read', async () => {
    const { captured, loadJSONCount } = await invokeAnalyticsPage({ pagePath: '' });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing path' });
    assert.equal(loadJSONCount, 0);
  });

  it('passes the guard for a present path and reaches loadJSON (no over-reject)', async () => {
    const { captured, loadJSONCount } = await invokeAnalyticsPage({ pagePath: 'content/intro.md' });
    // A real path clears the guard, so the handler proceeds to the store reads
    // and answers 200 with the queried path echoed back.
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.path, 'content/intro.md');
    assert.ok(loadJSONCount >= 1, 'a present path must reach the store read');
  });
});
