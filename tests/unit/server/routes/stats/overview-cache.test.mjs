import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other route tests do
// (mirrors tests/next-content-a-cache-refs.test.mjs).
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/stats.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// A fixture content tree under <root>/content. Plain strings are files; nested
// objects are directories. The non-allowed extension and the hidden directory
// exercise the handler's skip paths so they must not contribute to the totals.
const TREE = {
  content: {
    'a.md': '# Heading One\n\nHello world foo [@smith2020] [[WikiLink]] [text](http://x)',
    notes: {
      'b.md': '## Sub\n### Deep\nalpha beta gamma [@a; @b]',
    },
    'skip.txt': 'wrong extension, not counted',
    '.git': { config: 'ignored hidden directory' },
  },
};

// The aggregate the handler should produce over TREE. `references` is 0 because
// the fake fs has no bibliography/references.yaml: statSync throws and
// loadReferencesCached swallows that to {}, exactly as the GOAL anticipates.
const EXPECTED = {
  files: 2,
  words: 18,
  headings: 3,
  citations: 2,
  links: 2,
  references: 0,
  avgWordsPerFile: 9,
  avgHeadingsPerFile: 1.5,
  avgCitationsPerFile: 1,
  readingTimeHours: 0,
};

// Build an in-memory fs over TREE keyed by absolute path. readdirSync and
// readFileSync are counted so a test can prove the second request is served from
// cache (no repeat directory walk). statSync always throws, so the bibliography
// read inside loadReferencesCached falls back to {} deterministically.
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

  const counts = { readdir: 0, read: 0, stat: 0 };
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
    statSync() { counts.stat++; throw new Error('ENOENT stat'); },
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

// loadReferencesCached keeps a module-scope memo; start each test from a cold
// cache so the references fallback is exercised fresh.
beforeEach(() => { routes._clearReferencesCache(); });

describe('GET /api/stats/overview: cached content scan', () => {
  it('returns the expected aggregate counts on the first call', async () => {
    const { fsMock } = makeFs(TREE, PROJECT_ROOT);
    const ctx = baseCtx(fsMock);

    const r = await invoke('/api/stats/overview', ctx);

    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED);
  });

  it('serves a deeply equal payload from cache on the second back-to-back call', async () => {
    const { fsMock, counts } = makeFs(TREE, PROJECT_ROOT);
    const ctx = baseCtx(fsMock);

    const first = await invoke('/api/stats/overview', ctx);
    const readdirAfterFirst = counts.readdir;
    assert.ok(readdirAfterFirst > 0, 'the first request walks the content tree');

    const second = await invoke('/api/stats/overview', ctx);

    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload, 'second payload matches the first');
    assert.deepEqual(second.payload, EXPECTED);
    assert.equal(counts.readdir, readdirAfterFirst, 'second request is served from cache: no repeat readdirSync');
  });
});
