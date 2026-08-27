import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the sibling route tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

// GET /api/admin/health-summary now wraps its whole content-tree scan and score
// assembly in cached('health-summary', 60000, fn). This suite proves the wrap is
// behavior preserving (the payload is unchanged and stable across back-to-back
// calls) AND that the cache actually short-circuits the scan: the second request
// must not walk the filesystem again.
//
// The handler is driven over an in-memory mock fs (so readdirSync calls can be
// counted) and a memoizing cached (so the second call is served from the store).

const PROJECT_ROOT = '/virtual-root';

// Fixture content tree, rooted at <PROJECT_ROOT>/content. A nested `guide/`
// directory exercises the recursive collect() (so a full scan makes more than one
// readdirSync call) and lets a self-link resolve through the id.endsWith(target)
// suffix check. Each file carries one resolvable self-link and one missing target,
// so totalLinks/brokenLinks are independent of the directory walk order.
const CONTENT_TREE = {
  'target.md': `---
title: Target
tags: [a]
---
# Target
[[target]] [[missing-alpha]]
`,
  guide: {
    'hub.md': `---
title: Hub
---
[[hub]] [[missing-beta]]
`,
  },
};

// Hand-computed expected payload for the fixture above:
//   • 2 files, both titled; only target.md has tags.
//   • totalWords = 10 (target.md) + 6 (hub.md) = 16 → wordScore round(16/2/100) = 0.
//   • 1 heading ("# Target")                        → headingScore round(1/2*5) = 3.
//   • titleScore round(2/2*25) = 25, tagScore round(1/2*15) = 8.
//   • 4 wiki-links, 2 broken (missing-alpha, missing-beta); the two self-links
//     resolve (target via the id set, hub via "guide/hub".endsWith("hub")) →
//     linkHealth round((4-2)/4*20) = 10.
//   • overall = 25 + 8 + 3 + 0 + 10 = 46            → level 'adequate' (40..59).
const EXPECTED = {
  score: 46,
  level: 'adequate',
  breakdown: { titles: 25, tags: 8, headings: 3, wordCount: 0, linkHealth: 10 },
  stats: { totalFiles: 2, filesWithTitle: 2, filesWithTags: 1, totalWords: 16, totalLinks: 4, brokenLinks: 2 },
};

// Minimal in-memory fs exposing only what the handler uses: readdirSync (with
// withFileTypes Dirent-likes) and readFileSync. It records how many times
// readdirSync runs so a test can prove the cached second request never re-walks
// the tree. Directory listing order is fixed (object insertion order), keeping the
// scan deterministic without depending on a platform-defined fs ordering.
function buildMockFs(rootPath, tree) {
  const dirEntries = new Map(); // fullPath -> [{ name, isDir }]
  const fileContent = new Map(); // fullPath -> string
  (function walk(prefix, node) {
    const entries = [];
    for (const [name, value] of Object.entries(node)) {
      const full = path.join(prefix, name);
      if (typeof value === 'string') {
        fileContent.set(full, value);
        entries.push({ name, isDir: false });
      } else {
        entries.push({ name, isDir: true });
        walk(full, value);
      }
    }
    dirEntries.set(prefix, entries);
  })(rootPath, tree);

  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    readdirSync(dir) {
      readdirCalls++;
      const entries = dirEntries.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return entries.map(({ name, isDir }) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      if (fileContent.has(fp)) return fileContent.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// A memoizing cached(key, ttl, fn): runs fn once per key, then serves the stored
// value, modelling the real server cache on a within-TTL hit. ttl is irrelevant to
// back-to-back calls, so it is intentionally ignored here.
function buildMemoizingCached() {
  const store = new Map();
  return (key, _ttl, fn) => {
    if (store.has(key)) return store.get(key);
    const value = fn();
    store.set(key, value);
    return value;
  };
}

// Drive the real GET /api/admin/health-summary handler once and return the
// captured json() response.
async function runHealthSummary({ fs, cached }) {
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL('http://localhost/api/admin/health-summary');
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, '/api/admin/health-summary', ctx);
  return captured;
}

describe('GET /api/admin/health-summary (cached scan)', () => {
  it('returns the expected score/level/breakdown/stats on the first call', async () => {
    const fs = buildMockFs(path.join(PROJECT_ROOT, 'content'), CONTENT_TREE);
    const cached = buildMemoizingCached();
    const { status, payload } = await runHealthSummary({ fs, cached });
    assert.equal(status, 200);
    assert.deepEqual(payload, EXPECTED);
  });

  it('serves a deeply-equal payload from cache on the second call without re-scanning', async () => {
    const fs = buildMockFs(path.join(PROJECT_ROOT, 'content'), CONTENT_TREE);
    const cached = buildMemoizingCached();

    const first = await runHealthSummary({ fs, cached });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, EXPECTED);
    const callsAfterFirst = fs.readdirCalls;
    assert.ok(callsAfterFirst > 0, 'first request walks the content tree');

    const second = await runHealthSummary({ fs, cached });
    assert.equal(second.status, 200);
    // (2) The back-to-back call returns a deeply-equal payload.
    assert.deepEqual(second.payload, first.payload);
    // (3) The cache short-circuits the scan: no further readdirSync on the 2nd call.
    assert.equal(fs.readdirCalls, callsAfterFirst, 'second request is served from cache (no re-scan)');
  });
});
