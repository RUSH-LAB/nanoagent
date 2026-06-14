import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

// Invoke GET /api/sessions with a mocked ctx and capture the json() response.
// The ctx / loadJSON mock / json-capture harness is copied from
// tests/next-sessions-single-pass-summary.test.mjs; the only behavioral change is
// that every caller here OMITS the userId param, so the handler's
//   const userId = url.searchParams.get('userId') || 'default';
// falls back to the literal 'default' key. Every other GET /api/sessions test
// passes an explicit ?userId=, leaving that fallback at zero coverage.
async function getSessions({ store, search = '' }) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/next-sessions-default-userid-projection-test',
    loadJSON: () => store,
    json: (_res, status, body) => { captured = { status, body }; return captured; },
  };
  const url = new URL(`http://localhost/api/sessions${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await feedsRoutes(req, res, url, '/api/sessions', ctx);
  return captured;
}

describe('feeds GET /api/sessions default userId projection', () => {
  it('projects the literal "default" key newest-first with summed totals (|| 0 fallbacks)', async () => {
    // No ?userId -> userId = 'default'; the store HAS a 'default' key.
    const r = await getSessions({
      store: {
        default: [
          { id: 's1', duration: 30, wordsWritten: 100 },
          { id: 's2', wordsWritten: 250 }, // missing duration -> contributes 0 minutes
          { id: 's3', duration: 15 },      // missing wordsWritten -> contributes 0 words
        ],
      },
    });
    assert.equal(r.status, 200);
    // Real-captured golden: slice(-20).reverse() yields newest-first, and the
    // single-pass fold applies the `|| 0` fallbacks (15+0+30 minutes, 0+250+100 words).
    assert.deepStrictEqual(r.body, {
      sessions: [
        { id: 's3', duration: 15 },
        { id: 's2', wordsWritten: 250 },
        { id: 's1', duration: 30, wordsWritten: 100 },
      ],
      summary: { totalSessions: 3, totalMinutes: 45, totalWords: 350 },
    });
  });

  it('returns the empty default when no "default" key exists (Object.hasOwn guard)', async () => {
    // No ?userId and no 'default' key -> the hasOwn guard yields the empty default.
    const r = await getSessions({ store: {} });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body, {
      sessions: [],
      summary: { totalSessions: 0, totalMinutes: 0, totalWords: 0 },
    });
  });

  it('treats the "default" key by hasOwn exactly like a named key (other-key data does not leak)', async () => {
    // No ?userId; data lives only under a different own key, so 'default' is still absent.
    const r = await getSessions({ store: { alice: [{ duration: 99, wordsWritten: 999 }] } });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body, {
      sessions: [],
      summary: { totalSessions: 0, totalMinutes: 0, totalWords: 0 },
    });
  });
});
