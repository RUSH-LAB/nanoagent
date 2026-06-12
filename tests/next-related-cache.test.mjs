import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`, identical in
// shape to the one in next-file-related-hoist-stopwords.test.mjs but it counts
// readdirSync calls. The count lets these tests prove the recursive scanRelated
// walk runs on a cache miss and is skipped entirely on a cache hit.
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

  const counts = { readdirSync: 0 };
  return {
    counts,
    existsSync(p) { return dirs.has(p) || fileContents.has(p); },
    readdirSync(dir) {
      counts.readdirSync++;
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server
// helper: run fn and store on a miss, return the stored value untouched on a
// hit. Returned with its store so tests can assert the live entry count.
function makeCached() {
  const store = new Map();
  const cached = (key, _ttl, fn) => {
    if (store.has(key)) return store.get(key);
    const val = fn();
    store.set(key, val);
    return val;
  };
  return { cached, store };
}

// Drive GET /api/file/related once. The fs and cached are passed in so a single
// pair can be shared across calls within a test, letting the cache persist.
async function getRelated(fs, cached, filePath, isValidFilePath = () => true) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    isValidFilePath,
    cached,
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL(`http://localhost/api/file/related?path=${encodeURIComponent(filePath)}`);
  await fileToolsRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/file/related', ctx);
  return captured;
}

// Fixtures reused from next-file-related-hoist-stopwords.test.mjs so the
// expected payload is the proven one: tags (10) > content (5) > nested (2.5).
const SOURCE = `---
title: Source Doc
tags: [graph, theory]
---

machine learning neural networks this that with from will have been were
`;

const RELATED_CONTENT = `---
title: Related By Content
---

machine learning neural networks concepts
`;

const RELATED_TAGS = `---
title: Related By Tags
tags: [graph, theory]
---

completely different vocabulary here
`;

const NESTED = `---
title: Nested Related
---

machine zebra giraffe antelope
`;

const UNRELATED = `---
title: Unrelated
---

elephant ostrich walrus dolphin
`;

const FIXTURE = {
  'content/source.md': SOURCE,
  'content/related-content.md': RELATED_CONTENT,
  'content/related-tags.md': RELATED_TAGS,
  'content/sub/nested.md': NESTED,
  'content/unrelated.md': UNRELATED,
};

const EXPECTED_RELATED = [
  { path: 'content/related-tags.md', title: 'Related By Tags', score: 10 },
  { path: 'content/related-content.md', title: 'Related By Content', score: 5 },
  { path: 'content/sub/nested.md', title: 'Nested Related', score: 2.5 },
];

describe('GET /api/file/related (per-path cache)', () => {
  it('returns the expected related payload on the first call', async () => {
    const fs = makeFs(FIXTURE);
    const { cached } = makeCached();
    const res = await getRelated(fs, cached, 'content/source.md');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.related, EXPECTED_RELATED);
  });

  it('serves a repeat request for the same path from cache without rescanning', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();

    const first = await getRelated(fs, cached, 'content/source.md');
    const afterFirst = fs.counts.readdirSync;
    assert.equal(first.status, 200);
    assert.ok(afterFirst > 0, 'the first call walks the content tree');

    const second = await getRelated(fs, cached, 'content/source.md');
    assert.equal(second.status, 200);
    assert.equal(fs.counts.readdirSync, afterFirst, 'the second call does not read the directory again');
    assert.deepEqual(second.body, first.body);
    assert.equal(store.size, 1, 'one cache entry for the single path');
  });

  it('treats a different path as a distinct cache entry that scans again', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();

    await getRelated(fs, cached, 'content/source.md');
    const afterFirst = fs.counts.readdirSync;

    const other = await getRelated(fs, cached, 'content/related-content.md');
    assert.equal(other.status, 200);
    assert.ok(fs.counts.readdirSync > afterFirst, 'a new path triggers a fresh scan');
    assert.equal(store.size, 2, 'each path gets its own cache entry');
  });

  it('still returns 404 for a missing source file and never caches it', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();
    const res = await getRelated(fs, cached, 'content/missing.md');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'File not found' });
    assert.equal(store.size, 0, 'the 404 path is never cached');
  });
});
