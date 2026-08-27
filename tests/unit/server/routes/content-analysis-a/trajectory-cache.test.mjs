import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the sibling route suites do
// (next-related-cache, next-content-c-mentions-cache) and reuse their ctx-mocking
// shape. The exported _clearReferencesCache hook resets the module-scope
// references.yaml memo so each test starts from a cold cache.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`, the same shape
// the sibling per-target cache suites use, extended with statSync because the
// trajectory scan stats every matching file and loadReferencesCached stats and
// reads bibliography/references.yaml. It counts readdirSync and readFileSync so a
// test can prove a cached repeat skips the whole recursive content walk: neither
// the directory reads nor the file reads run a second time. statSync returns a
// fixed mtimeMs and a content-length size, so the references.yaml memo (keyed on
// mtimeMs + size) hits on a repeat call within one test and never reads the file
// twice.
function makeFs(fileMap) {
  const dirs = new Map(); // absDir -> Map<name, isDir>
  const fileContents = new Map(); // absFile -> content
  const ensureDir = absDir => { if (!dirs.has(absDir)) dirs.set(absDir, new Map()); };

  for (const [rel, content] of Object.entries(fileMap)) {
    const segs = rel.split('/');
    let cur = PROJECT_ROOT;
    for (let i = 0; i < segs.length; i++) {
      const isDir = i < segs.length - 1;
      ensureDir(cur);
      if (!dirs.get(cur).has(segs[i])) dirs.get(cur).set(segs[i], isDir);
      cur = path.join(cur, segs[i]);
    }
    fileContents.set(cur, content);
  }

  const counts = { readdirSync: 0, readFileSync: 0, statSync: 0 };
  return {
    counts,
    readdirSync(dir) {
      counts.readdirSync++;
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      counts.readFileSync++;
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
    statSync(fp) {
      counts.statSync++;
      if (!fileContents.has(fp)) { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; }
      const content = fileContents.get(fp);
      return {
        mtimeMs: 1700000000000,
        size: content.length,
        mtime: { toISOString: () => '2021-11-14T00:00:00.000Z' },
      };
    },
  };
}

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server/index.js
// helper: run fn and store on a miss, return the stored value untouched on a hit;
// fn() throwing stores nothing, so an error response stays uncached. Every call is
// recorded in `calls` so a test can pin the exact key and TTL the handler passes.
function makeCached() {
  const store = new Map();
  const calls = [];
  const cached = (key, ttl, fn) => {
    calls.push({ key, ttl });
    if (store.has(key)) return store.get(key);
    const val = fn();
    store.set(key, val);
    return val;
  };
  return { cached, store, calls };
}

// Drive GET /api/references/trajectory once. fs and cached are passed in so a
// single pair can be shared across calls within a test, letting the cache persist.
// `key` is omitted from the query string entirely when null, to exercise the
// missing-key 400 guard.
async function getTrajectory(fs, cached, key) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const qs = key === null ? '' : `?key=${encodeURIComponent(key)}`;
  const url = new URL(`http://localhost/api/references/trajectory${qs}`);
  await routes({ method: 'GET' }, { writableEnded: false }, url, '/api/references/trajectory', ctx);
  return captured;
}

// references.yaml parsed by the real js-yaml the module requires: two known keys,
// each with a title that the handler echoes into the payload from outside the cache.
const REFS_YAML = `smith2020:
  title: A Study of Graphs
jones2019:
  title: Another Reference
`;

// Two pages cite smith2020 with distinct frontmatter dates (one nested, proving the
// recursive walk is part of the cached scan). other.md cites only jones2019, and
// none.md cites nothing, so neither appears in the smith2020 trajectory.
const INTRO = `---
title: Intro Page
date: 2021-01-01
---

Discussion of the topic [@smith2020] in depth.
`;

const DEEP = `---
title: Deep Dive
date: 2020-06-15
---

A deeper look [@smith2020] at the subject.
`;

const OTHER = `---
title: Other Page
date: 2022-01-01
---

References [@jones2019] only, not the other key.
`;

const NONE = `---
title: No Citations
date: 2022-02-02
---

Plain text with no citation markers at all.
`;

const FIXTURE = {
  'content/bibliography/references.yaml': REFS_YAML,
  'content/intro.md': INTRO,
  'content/sub/deep.md': DEEP,
  'content/other.md': OTHER,
  'content/none.md': NONE,
};

// The proven pre-cache output for key smith2020. Field order matches the handler's
// returned payload literal ({key, title, trajectory, totalCitations}) and each
// pushed page ({path, title, date}), so a JSON.stringify comparison pins
// byte-identity, not just structural equality. Sorted by date ascending, so the
// nested 2020-06-15 page precedes the 2021-01-01 page.
const EXPECTED_SMITH = {
  key: 'smith2020',
  title: 'A Study of Graphs',
  trajectory: [
    { path: 'content/sub/deep.md', title: 'Deep Dive', date: '2020-06-15' },
    { path: 'content/intro.md', title: 'Intro Page', date: '2021-01-01' },
  ],
  totalCitations: 2,
};

describe('GET /api/references/trajectory (scan cached via cached("trajectory:" + key))', () => {
  it('returns the expected trajectory payload, byte-identical, on the first call', async () => {
    routes._clearReferencesCache();
    const fs = makeFs(FIXTURE);
    const { cached } = makeCached();
    const res = await getTrajectory(fs, cached, 'smith2020');
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_SMITH);
    // Byte-identity: same fields, same order, same serialization as before caching.
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_SMITH));
    assert.ok(fs.counts.readdirSync > 0, 'the first call walks content/');
    assert.ok(fs.counts.readFileSync > 0, 'the first call reads files');
  });

  it('serves a repeat request for the same key from cache with no repeat content walk', async () => {
    routes._clearReferencesCache();
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();

    const first = await getTrajectory(fs, cached, 'smith2020');
    const dirAfterFirst = fs.counts.readdirSync;
    const fileAfterFirst = fs.counts.readFileSync;
    assert.equal(first.status, 200);
    assert.ok(dirAfterFirst > 0 && fileAfterFirst > 0, 'the first call hits the filesystem');

    const second = await getTrajectory(fs, cached, 'smith2020');
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(fs.counts.readdirSync, dirAfterFirst, 'cached repeat must not readdirSync again');
    assert.equal(fs.counts.readFileSync, fileAfterFirst, 'cached repeat must not readFileSync again');
    assert.equal(store.size, 1, 'one cache entry for the single key');
    assert.ok(store.has('trajectory:smith2020'), 'cache key is "trajectory:" + key');
  });

  it('keys each distinct citation key separately and re-walks for a new key', async () => {
    routes._clearReferencesCache();
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();

    await getTrajectory(fs, cached, 'smith2020');
    const dirAfterFirst = fs.counts.readdirSync;

    const other = await getTrajectory(fs, cached, 'jones2019');
    assert.equal(other.status, 200);
    assert.deepEqual(other.payload, {
      key: 'jones2019',
      title: 'Another Reference',
      trajectory: [
        { path: 'content/other.md', title: 'Other Page', date: '2022-01-01' },
      ],
      totalCitations: 1,
    });
    assert.ok(fs.counts.readdirSync > dirAfterFirst, 'a new key misses the cache and re-walks content/');
    assert.equal(store.size, 2, 'each key gets its own cache entry');
    assert.ok(store.has('trajectory:jones2019'));
  });

  it('pins the cache key prefix and the 60000 ms TTL the handler passes', async () => {
    routes._clearReferencesCache();
    const fs = makeFs(FIXTURE);
    const { cached, calls } = makeCached();
    await getTrajectory(fs, cached, 'smith2020');
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'trajectory:smith2020');
    assert.equal(calls[0].ttl, 60000);
  });

  it('returns 400 for a missing key before the cache and never scans', async () => {
    routes._clearReferencesCache();
    const fs = makeFs(FIXTURE);
    const { cached, store, calls } = makeCached();
    const res = await getTrajectory(fs, cached, null);
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Missing key' });
    assert.equal(calls.length, 0, 'the missing-key guard returns before cached() is reached');
    assert.equal(store.size, 0, 'the 400 path is never cached');
    assert.equal(fs.counts.readdirSync, 0, 'no scan on a missing key');
  });

  it('returns 404 for an unknown key before the cache and never caches it', async () => {
    routes._clearReferencesCache();
    const fs = makeFs(FIXTURE);
    const { cached, store, calls } = makeCached();
    const res = await getTrajectory(fs, cached, 'nonexistent2099');
    assert.equal(res.status, 404);
    assert.deepEqual(res.payload, { error: 'Reference not found' });
    assert.equal(calls.length, 0, 'the unknown-key guard returns before cached() is reached');
    assert.equal(store.size, 0, 'the 404 path is never cached');
    assert.equal(fs.counts.readdirSync, 0, 'no content walk for an unknown key');
  });
});
