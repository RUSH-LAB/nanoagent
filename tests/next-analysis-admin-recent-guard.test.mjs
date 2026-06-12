import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// analysis-admin.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// Build a mock fs whose content directory holds exactly `n` markdown files (flat,
// no subdirectories). The /api/files/recent handler walks the tree, stats each
// file, sorts by mtime, then slices. Each file gets a distinct mtime so the sort
// is deterministic; only the resulting length matters to these assertions.
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
// response handed to `json(res, status, payload)`.
async function invoke({ search = '', n }) {
  const url = new URL(`http://localhost/api/files/recent${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs: makeRecentFs(n),
    path,
    PROJECT_ROOT: '/tmp/next-analysis-admin-recent-guard-test',
    ALLOWED_EXTS: ['.md', '.mdx'],
    // The handler now wraps its walk in cached(); inject a pass-through so each
    // invoke walks the freshly built fs exactly as before (no cross-call cache).
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

describe('GET /api/files/recent limit guard', () => {
  // 45 content files: above the default page (10) but below the handler's
  // pre-existing slice bound (50). Keeping it under that bound lets a large valid
  // limit return every file (proving it is not clamped down), while preserving
  // the existing behavior byte-for-byte (this guard only fixes the NaN case).
  const N = 45;

  it('an absent limit returns the default-sized page (10)', async () => {
    const r = await invoke({ search: '', n: N });
    assert.equal(r.status, 200);
    assert.equal(r.payload.files.length, 10);
  });

  it('a valid numeric limit is honored', async () => {
    const r = await invoke({ search: '?limit=5', n: N });
    assert.equal(r.status, 200);
    assert.equal(r.payload.files.length, 5);
  });

  it('a large valid limit is not clamped (returns every available file)', async () => {
    const r = await invoke({ search: `?limit=${N}`, n: N });
    assert.equal(r.status, 200);
    assert.equal(r.payload.files.length, N, 'large limit honored, not reduced to the default');
    assert.ok(r.payload.files.length > 10, 'returns more than the default page');
  });

  it('a limit larger than the file count still returns all files, not the default', async () => {
    const r = await invoke({ search: '?limit=1000', n: N });
    assert.equal(r.status, 200);
    assert.equal(r.payload.files.length, N, 'all files returned; the limit is not clamped down to 10');
  });

  it('a non-numeric limit falls back to the default page, not an empty list', async () => {
    const def = await invoke({ search: '', n: N });
    const bad = await invoke({ search: '?limit=abc', n: N });
    assert.equal(bad.status, 200);
    assert.equal(bad.payload.files.length, 10, 'guarded to default 10, not slice(0, NaN) === []');
    assert.ok(bad.payload.files.length > 0, 'files are not silently dropped');
    assert.deepEqual(bad.payload, def.payload, 'matches the absent-limit result');
  });
});
