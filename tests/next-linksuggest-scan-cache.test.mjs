import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];
const TARGET = 'content/index.md';

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`, the same shape
// the link-suggestions walk expects (readdirSync with withFileTypes-style entries
// plus readFileSync), but it counts readdirSync calls. The count proves the
// recursive scanLinks walk runs on a cache miss and is skipped on a cache hit.
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
// helper: run fn and store on a miss, return the stored value untouched on a hit.
// Returned with its store so tests can assert the live entry count.
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

// Drive GET /api/file/link-suggestions once. The fs and cached are passed in so a
// single pair can be shared across calls within a test, letting the cache persist.
async function getLinkSuggestions(fs, cached, filePath, isValidFilePath = () => true) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    isValidFilePath,
    cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL(`http://localhost/api/file/link-suggestions?path=${encodeURIComponent(filePath)}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await routes(req, { writableEnded: false }, url, '/api/file/link-suggestions', ctx);
  return captured;
}

// Fixture reused from next-linksuggest-hoist-wikire.test.mjs so the expected
// payload is the proven one: the target already links to [[Transformers]] and
// [[Attention]] (both excluded despite appearing in the prose), leaving
// embeddings.md and the hyphenated reinforcement-learning.md (matched on its
// "reinforcement" segment). unrelated.md shares no word; diagram.png is filtered
// out by extension.
const FIXTURE = {
  'content/index.md': `---
title: Research Notes
---

This note already references [[Transformers]] and [[Attention]].

It also discusses embeddings and reinforcement strategies in depth.
`,
  'content/transformers.md': '---\ntitle: Transformers\n---\n\nAbout transformers.\n',
  'content/attention.md': '---\ntitle: Attention\n---\n\nAbout attention.\n',
  'content/embeddings.md': '---\ntitle: Embeddings Explained\n---\n\nAbout embeddings.\n',
  'content/reinforcement-learning.md': 'Body about reinforcement learning, no front matter.\n',
  'content/unrelated.md': '---\ntitle: Unrelated\n---\n\nNothing overlaps here.\n',
  'content/diagram.png': 'not markdown\n',
};

// Suggestions follow the content/ walk order. Titles come from front matter when
// present (embeddings.md) and fall back to the filename stem otherwise
// (reinforcement-learning.md).
const EXPECTED = {
  suggestions: [
    { path: 'content/embeddings.md', title: 'Embeddings Explained', pageName: 'embeddings' },
    { path: 'content/reinforcement-learning.md', title: 'reinforcement-learning', pageName: 'reinforcement-learning' },
  ],
  total: 2,
};

describe('GET /api/file/link-suggestions (per-path scan cache)', () => {
  it('returns the expected suggestions payload on the first call', async () => {
    const fs = makeFs(FIXTURE);
    const { cached } = makeCached();
    const res = await getLinkSuggestions(fs, cached, TARGET);
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED);
  });

  it('serves a repeat request for the same path from cache without rescanning', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();

    const first = await getLinkSuggestions(fs, cached, TARGET);
    const afterFirst = fs.counts.readdirSync;
    assert.equal(first.status, 200);
    assert.ok(afterFirst > 0, 'the first call walks the content tree');

    const second = await getLinkSuggestions(fs, cached, TARGET);
    assert.equal(second.status, 200);
    assert.equal(fs.counts.readdirSync, afterFirst, 'the second call does not read the directory again');
    assert.deepEqual(second.payload, first.payload);
    assert.deepEqual(second.payload, EXPECTED);
    // The production cached() hands back its stored object by reference, so the hit
    // returns the very same payload instance, never a re-scan or a clone.
    assert.strictEqual(second.payload, first.payload, 'the cache returns the same object reference');
    assert.equal(store.size, 1, 'one cache entry for the single path');
  });

  it('treats a different path as a distinct cache entry that scans again', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();

    await getLinkSuggestions(fs, cached, TARGET);
    const afterFirst = fs.counts.readdirSync;

    const other = await getLinkSuggestions(fs, cached, 'content/embeddings.md');
    assert.equal(other.status, 200);
    assert.ok(fs.counts.readdirSync > afterFirst, 'a new path triggers a fresh scan');
    // The distinct entry holds embeddings.md's OWN scan result: it links nothing
    // and shares no candidate word, and it is excluded from its own scan by the
    // rel === filePath guard, so the suggestions are empty. This pins that the
    // second key returns a fresh scan rather than the TARGET's cached payload.
    assert.deepEqual(other.payload, { suggestions: [], total: 0 });
    assert.equal(store.size, 2, 'each path gets its own cache entry');
  });

  it('still returns 404 for a missing source file and never caches it', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();
    const res = await getLinkSuggestions(fs, cached, 'content/missing.md');
    assert.equal(res.status, 404);
    assert.deepEqual(res.payload, { error: 'File not found' });
    assert.equal(store.size, 0, 'the 404 path is never cached');
  });
});
