import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other route tests do
// (mirrors tests/next-citations-cache.test.mjs).
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// A two-entry references.yaml shaped like the real bibliography (key -> {title,
// year}). GET /api/content-summary counts its keys via
// Object.keys(loadReferencesCached()).length, which fixes `references` at 2.
const REFS_YAML =
  'smith2020:\n' +
  '  title: A Paper\n' +
  '  year: 2020\n' +
  'jones2019:\n' +
  '  title: Another Paper\n' +
  '  year: 2019\n';

// A fixture tree. <root>/content is the directory the handler walks; <root>/
// bibliography/references.yaml is read separately by loadReferencesCached via
// statSync + readFileSync. Plain strings are files; nested objects are
// directories. The scan counts every allowed-extension file whose name does not
// start with '.', summing the whitespace-split word count of the whole file.
// `_draft.md` is included on purpose: unlike the sibling handlers in this file,
// /api/content-summary skips only dotfiles, so an underscore-prefixed file IS
// counted. `skip.txt` (wrong extension) and `.hidden.md` (dotfile) must be
// skipped and never read.
const TREE = {
  content: {
    'alpha.md': 'word '.repeat(1000),        // 1000 words
    sub: {
      'beta.mdx': 'token '.repeat(200),       // 200 words
    },
    '_draft.md': 'draft note kept here',      // 4 words (underscore file: counted)
    'skip.txt': 'wrong extension ignored',    // skipped: not an allowed extension
    '.hidden.md': 'dotfile words ignored',    // skipped: dotfile
    bibliography: {
      'references.yaml': REFS_YAML,
    },
  },
};

// The summary the handler should produce over TREE: 3 counted files, 1204 total
// words (1000 + 200 + 4), 2 references, and readingHours =
// round(1204 / 200 / 60 * 10) / 10 = 0.1.
const EXPECTED = { files: 3, words: 1204, references: 2, readingHours: 0.1 };

// Build an in-memory fs over TREE keyed by absolute path. readdirSync,
// readFileSync, and statSync are counted so a test can prove the second request
// is served from cache (no repeat directory walk, file read, or bibliography stat).
function makeFs(tree, root) {
  const dirs = new Map();   // absDir -> [{name, dir}]
  const files = new Map();  // absFile -> contents
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
    statSync(fp) {
      counts.stat++;
      if (files.has(fp)) return { mtimeMs: 1000, size: files.get(fp).length };
      throw new Error(`ENOENT stat ${fp}`);
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

// By default each ctx gets its own fresh cache; pass an explicit `cached` to share
// one store across requests (used by the error-path test to prove a failed scan is
// not memoized).
const baseCtx = (fsMock, cached = makeCached()) => ({ fs: fsMock, path, PROJECT_ROOT, ALLOWED_EXTS, cached });

// loadReferencesCached keeps a module-scope memo of references.yaml that survives
// across requests, so each test starts from a cold bibliography cache.
beforeEach(() => { routes._clearReferencesCache(); });

describe('GET /api/content-summary: cached content scan', () => {
  it('returns the expected summary on the first call', async () => {
    const { fsMock } = makeFs(TREE, PROJECT_ROOT);
    const ctx = baseCtx(fsMock);

    const r = await invoke('/api/content-summary', ctx);

    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED);
  });

  it('serves a deeply equal payload from cache on the second back-to-back call', async () => {
    const { fsMock, counts } = makeFs(TREE, PROJECT_ROOT);
    const ctx = baseCtx(fsMock);

    const first = await invoke('/api/content-summary', ctx);
    const readdirAfterFirst = counts.readdir;
    const readAfterFirst = counts.read;
    const statAfterFirst = counts.stat;
    assert.ok(readdirAfterFirst > 0, 'the first request walks the content tree');

    const second = await invoke('/api/content-summary', ctx);

    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload, 'second payload matches the first');
    assert.deepEqual(second.payload, EXPECTED);
    assert.equal(counts.readdir, readdirAfterFirst, 'second request is served from cache: no repeat readdirSync');
    assert.equal(counts.read, readAfterFirst, 'second request reads no files: served from cache');
    assert.equal(counts.stat, statAfterFirst, 'second request does not re-stat the bibliography: served from cache');
  });

  it('does not cache the 500 from a failed scan: the error path stays outside the cache', async () => {
    // Share one cache store across both requests. The first runs over a tree with
    // no content/ directory, so scan(contentDir) throws inside the closure; because
    // cached() only stores fn()'s value after it returns, the throw propagates to
    // the outer try/catch and yields an UNCACHED 500. The second request, with a
    // healthy fs but the SAME cache store, must therefore recompute rather than
    // serve a memoized error. This assertion fails if the try/catch is ever moved
    // inside the closure (which would memoize an error payload for the whole TTL).
    const cached = makeCached();

    const broken = makeFs({ bibliography: { 'references.yaml': REFS_YAML } }, PROJECT_ROOT);
    const failed = await invoke('/api/content-summary', baseCtx(broken.fsMock, cached));
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.payload, { error: 'Summary failed' });
    assert.ok(broken.counts.readdir > 0, 'the failing request attempted the content walk');

    const healthy = makeFs(TREE, PROJECT_ROOT);
    const ok = await invoke('/api/content-summary', baseCtx(healthy.fsMock, cached));
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.payload, EXPECTED);
    assert.ok(healthy.counts.readdir > 0, 'the repaired request re-walked the tree: the 500 was never memoized');
  });
});
