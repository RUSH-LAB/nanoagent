import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other route tests do
// (mirrors tests/next-statsoverview-cache.test.mjs).
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/stats.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// A fixture content tree under <root>/content. Plain strings are files; nested
// objects are directories. `alpha.md` carries frontmatter so the title branch is
// exercised; the others fall back to the filename. The non-allowed extension, the
// dotfile, and the underscore-prefixed file all hit the handler's skip paths, so
// they must not contribute a page (and must never be read).
const TREE = {
  content: {
    'alpha.md': '---\ntitle: Alpha Post\n---\nintro [@a] [@b] [@c] end',
    sub: {
      'gamma.md': '[@a] [@b] [@c] [@d] [@e]',
    },
    'beta.md': '[@a] w w w',
    'skip.txt': 'wrong extension [@nope] not counted',
    '.hidden.md': 'hidden [@x] [@y]',
    '_draft.md': 'underscore [@z]',
  },
};

// The ranking the handler should produce over TREE: pages sorted by citation
// count descending (gamma 5, alpha 3, beta 1), the 20-page slice, the total page
// count, and the rounded average citations per page (round((5+3+1)/3 * 10) / 10).
const EXPECTED = {
  pages: [
    { path: 'content/sub/gamma.md', title: 'gamma', citations: 5, words: 5, citationsPerKWords: 1000 },
    { path: 'content/alpha.md', title: 'Alpha Post', citations: 3, words: 10, citationsPerKWords: 300 },
    { path: 'content/beta.md', title: 'beta', citations: 1, words: 4, citationsPerKWords: 250 },
  ],
  total: 3,
  avgCitations: 3,
};

// Build an in-memory fs over TREE keyed by absolute path. readdirSync and
// readFileSync are counted so a test can prove the second request is served from
// cache (no repeat directory walk).
function makeFs(tree, root) {
  const dirs = new Map();  // absDir -> [{name, dir}]
  const files = new Map(); // absFile -> contents
  (function walk(node, dirPath) {
    const entries = [];
    for (const [name, val] of Object.entries(node)) {
      const fp = path.join(dirPath, name);
      if (typeof val === 'string') { entries.push({ name, dir: false }); files.set(fp, val); }
      else { entries.push({ name, dir: true }); walk(val, fp); }
    }
    dirs.set(dirPath, entries);
  })(tree, root);

  const counts = { readdir: 0, read: 0 };
  const fsMock = {
    readdirSync(dir) {
      counts.readdir++;
      const entries = dirs.get(dir);
      if (!entries) throw new Error(`ENOENT readdir ${dir}`);
      return entries.map(e => ({ name: e.name, isDirectory: () => e.dir }));
    },
    readFileSync(fp) {
      counts.read++;
      if (files.has(fp)) return files.get(fp);
      throw new Error(`ENOENT read ${fp}`);
    },
  };
  return { fsMock, counts };
}

// A memoizing cached(key, ttl, fn) mirroring server/index.js's TTL cache minus the
// expiry: the test issues back-to-back calls, so a permanent per-key memo makes
// the cache-hit assertion deterministic without depending on wall-clock time.
function makeCached() {
  const store = new Map();
  return function cached(key, _ttlMs, fn) {
    if (store.has(key)) return store.get(key);
    const data = fn();
    store.set(key, data);
    return data;
  };
}

// Invoke a content-analysis-a GET handler with a mocked ctx, capturing the
// json(res, status, payload) response. Fully in-process: no network, no server.
async function invoke(pathname, ctx) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  let jsonResp = null;
  const res = {
    writableEnded: false,
    writeHead() { return this; },
    end() { this.writableEnded = true; return this; },
  };
  const fullCtx = {
    json(_res, status, payload) { jsonResp = { status, payload }; res.writableEnded = true; return jsonResp; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return jsonResp;
}

const baseCtx = (fsMock) => ({ fs: fsMock, path, PROJECT_ROOT, ALLOWED_EXTS, cached: makeCached() });

describe('GET /api/stats/citations-per-page: cached content scan', () => {
  it('returns the expected ranking on the first call', async () => {
    const { fsMock } = makeFs(TREE, PROJECT_ROOT);
    const ctx = baseCtx(fsMock);

    const r = await invoke('/api/stats/citations-per-page', ctx);

    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED);
  });

  it('serves a deeply equal payload from cache on the second back-to-back call', async () => {
    const { fsMock, counts } = makeFs(TREE, PROJECT_ROOT);
    const ctx = baseCtx(fsMock);

    const first = await invoke('/api/stats/citations-per-page', ctx);
    const readdirAfterFirst = counts.readdir;
    const readAfterFirst = counts.read;
    assert.ok(readdirAfterFirst > 0, 'the first request walks the content tree');

    const second = await invoke('/api/stats/citations-per-page', ctx);

    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload, 'second payload matches the first');
    assert.deepEqual(second.payload, EXPECTED);
    assert.equal(counts.readdir, readdirAfterFirst, 'second request is served from cache: no repeat readdirSync');
    assert.equal(counts.read, readAfterFirst, 'second request reads no files: served from cache');
  });
});
