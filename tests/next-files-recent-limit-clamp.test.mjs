import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// analysis-admin.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// Build a mock fs whose content directory holds exactly `n` flat markdown files.
// The /api/files/recent handler walks the tree, stats each file, sorts by mtime,
// then slices. Each file gets a distinct mtime so the sort is deterministic; only
// the resulting page length matters to these assertions.
function makeRecentFs(n) {
  const entries = Array.from({ length: n }, (_, i) => ({
    name: `file${i}.md`,
    isDirectory: () => false,
  }));
  return {
    readdirSync: () => entries,
    statSync: (p) => {
      const m = /file(\d+)\.md$/.exec(p);
      return { mtimeMs: m ? Number(m[1]) : 0 };
    },
    readFileSync: () => '',
  };
}

// Invoke the /api/files/recent handler with a minimal mocked ctx and capture the
// response handed to `json(res, status, payload)`. A pass-through cached() makes
// each call walk the freshly built fs (no cross-call caching).
async function invoke({ search = '', n }) {
  const url = new URL(`http://localhost/api/files/recent${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs: makeRecentFs(n),
    path,
    PROJECT_ROOT: '/tmp/next-files-recent-limit-clamp-test',
    ALLOWED_EXTS: ['.md', '.mdx'],
    cached: (_k, _t, fn) => fn(),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/files/recent', ctx);
  return captured;
}

describe('GET /api/files/recent negative-limit clamp', () => {
  // 60 content files: above the handler's slice bound (50), so the upper cap is
  // observable, and far above the 5 a `?limit=-5` would drop off the end, so the
  // pre-fix oversized page would have been clearly non-empty.
  const N = 60;

  it('clamps ?limit=-5 to an empty page, not all-but-the-last-5', async () => {
    const r = await invoke({ search: '?limit=-5', n: N });
    assert.equal(r.status, 200);
    // Post-fix: Math.max(-5, 0) === 0, so slice(0, Math.min(0, 50)) === slice(0, 0) === [].
    assert.equal(r.payload.files.length, 0, 'a negative limit yields an empty page');
    // Anti-tautology: against the OLD un-clamped `const limit = Number.isNaN(n) ? 10 : n`,
    // Math.min(-5, 50) === -5 and slice(0, -5) would have returned the first 55 files
    // (all but the last 5), an oversized, wrong page. Assert we are NOT that.
    assert.notEqual(r.payload.files.length, N - 5, 'must not return the pre-fix oversized slice(0, -5) page');
  });

  it('returns 3 items for a valid ?limit=3 (behavior unchanged)', async () => {
    const r = await invoke({ search: '?limit=3', n: N });
    assert.equal(r.status, 200);
    assert.equal(r.payload.files.length, 3);
  });

  it('returns up to 10 for the default (absent) limit', async () => {
    const r = await invoke({ search: '', n: N });
    assert.equal(r.status, 200);
    assert.equal(r.payload.files.length, 10);
  });

  it('caps ?limit=999 at the slice bound of 50', async () => {
    const r = await invoke({ search: '?limit=999', n: N });
    assert.equal(r.status, 200);
    assert.equal(r.payload.files.length, 50, 'upper cap of Math.min(limit, 50) is preserved');
  });
});
