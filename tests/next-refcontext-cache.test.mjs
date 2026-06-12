import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from a `${rel-from-PROJECT_ROOT}: content` map. Only the
// two calls the context handler makes are implemented (readdirSync with
// withFileTypes, and readFileSync), each with a `counts` tally. The readdirSync
// count proves the recursive scanContexts walk runs on a cache miss and is skipped
// on a hit; readFileSync separates the per-request references.yaml read (kept
// outside the cache) from the cached per-file content reads.
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

  const counts = { readdirSync: 0, readFileSync: 0 };
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
  };
}

// A cached(key, ttl, fn) stub that BOTH memoizes by key (so a hit is served
// without re-running the producer, returning the stored value by reference like
// the production helper) AND records every (key, ttl) it was asked to cache, so a
// test can pin the key prefix and TTL.
function makeCached() {
  const store = new Map();
  const captures = [];
  const cached = (key, ttl, fn) => {
    captures.push({ key, ttl });
    if (store.has(key)) return store.get(key);
    const value = fn();
    store.set(key, value);
    return value;
  };
  return { cached, store, captures };
}

// Drive GET /api/references/context once against the supplied fs + cached stubs.
// Passing the pair in lets a single cache persist across calls within a test.
async function getContext(fs, cached, key) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const qs = key === undefined ? '' : `?key=${encodeURIComponent(key)}`;
  const url = new URL(`http://localhost/api/references/context${qs}`);
  await studyKnowledgeRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/references/context', ctx);
  return captured;
}

// references.yaml maps two keys to titles. Content lives at the content root and
// one nested dir so the cache-skip proof covers a real recursive walk. notes.txt
// is filtered by extension, _draft.md by its leading underscore, .hidden.md by its
// leading dot, so none of them are ever read. Each markdown body is a single short
// line, so every citation's 100-char window spans the whole file: the context is
// the trimmed line verbatim with neither a leading nor trailing ellipsis.
const FIXTURE = {
  'content/intro.md': 'See [@smith2020] for details.',
  'content/sub/methods.md': 'Built on [@smith2020] and [@jones2021].',
  'content/notes.txt': 'Ignore [@smith2020] in plain text.',
  'content/_draft.md': 'Hidden [@smith2020] draft.',
  'content/.hidden.md': 'Hidden [@smith2020] dotfile.',
  'content/other.md': 'Only [@jones2021] here.',
  'bibliography/references.yaml': 'smith2020:\n  title: A Study of Caching\njones2021:\n  title: Another Work\n',
};

// Citations follow the content/ walk order (intro.md, then the nested
// sub/methods.md, then other.md). position is the byte index of the match.
const EXPECTED_SMITH = {
  key: 'smith2020',
  title: 'A Study of Caching',
  contexts: [
    { file: 'content/intro.md', context: 'See [@smith2020] for details.', position: 4 },
    { file: 'content/sub/methods.md', context: 'Built on [@smith2020] and [@jones2021].', position: 9 },
  ],
  totalCitations: 2,
};

const EXPECTED_JONES = {
  key: 'jones2021',
  title: 'Another Work',
  contexts: [
    { file: 'content/sub/methods.md', context: 'Built on [@smith2020] and [@jones2021].', position: 26 },
    { file: 'content/other.md', context: 'Only [@jones2021] here.', position: 5 },
  ],
  totalCitations: 2,
};

describe('GET /api/references/context (per-key scan cache)', () => {
  it('returns the byte-identical payload on the first call', async () => {
    const fs = makeFs(FIXTURE);
    const { cached } = makeCached();
    const res = await getContext(fs, cached, 'smith2020');
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_SMITH);
    // Field order is part of the contract; pin it explicitly.
    assert.deepEqual(Object.keys(res.payload), ['key', 'title', 'contexts', 'totalCitations']);
  });

  it('serves a repeat request for the same key from cache without re-walking the content tree', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();

    const first = await getContext(fs, cached, 'smith2020');
    assert.equal(first.status, 200);
    const readdirAfterFirst = fs.counts.readdirSync;
    const readFileAfterFirst = fs.counts.readFileSync;
    assert.ok(readdirAfterFirst > 0, 'the first call walks the content tree');

    const second = await getContext(fs, cached, 'smith2020');
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.deepEqual(second.payload, EXPECTED_SMITH);
    // The scan is skipped: readdirSync does not advance at all on a hit.
    assert.equal(fs.counts.readdirSync, readdirAfterFirst, 'the second call does not walk the content tree again');
    // Only references.yaml is re-read outside the cache (exactly one readFileSync);
    // none of the content files are read again.
    assert.equal(fs.counts.readFileSync, readFileAfterFirst + 1, 'only references.yaml is re-read on a hit, no content files');
    // The production cached() hands back its stored array by reference.
    assert.strictEqual(second.payload.contexts, first.payload.contexts, 'the cache returns the same contexts array');
    assert.equal(store.size, 1, 'one cache entry for the single key');
  });

  it('pins the refcontext: key prefix and the 30000 ms TTL', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, captures } = makeCached();
    await getContext(fs, cached, 'smith2020');
    assert.equal(captures.length, 1, 'the scan is cached exactly once');
    assert.equal(captures[0].key, 'refcontext:smith2020');
    assert.equal(captures[0].ttl, 30000);
  });

  it('treats a different key as a distinct cache entry that re-walks', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store, captures } = makeCached();

    const smith = await getContext(fs, cached, 'smith2020');
    assert.equal(smith.status, 200);
    const readdirAfterSmith = fs.counts.readdirSync;

    const jones = await getContext(fs, cached, 'jones2021');
    assert.equal(jones.status, 200);
    // A new key triggers a fresh walk and holds its OWN result, not smith's.
    assert.ok(fs.counts.readdirSync > readdirAfterSmith, 'a new key triggers a fresh content walk');
    assert.deepEqual(jones.payload, EXPECTED_JONES);
    assert.notDeepEqual(jones.payload.contexts, smith.payload.contexts);
    assert.equal(captures[0].key, 'refcontext:smith2020');
    assert.equal(captures[1].key, 'refcontext:jones2021');
    assert.equal(store.size, 2, 'each key gets its own cache entry');
  });

  it('returns 400 for a missing key and never caches it', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();
    const res = await getContext(fs, cached, undefined);
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Missing key' });
    assert.equal(store.size, 0, 'the 400 path is never cached');
    assert.equal(fs.counts.readdirSync, 0, 'the 400 path never scans');
  });

  it('returns 404 for an unknown key and never caches it', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();
    const res = await getContext(fs, cached, 'doesNotExist');
    assert.equal(res.status, 404);
    assert.deepEqual(res.payload, { error: 'Reference not found' });
    assert.equal(store.size, 0, 'the 404 path is never cached');
    assert.equal(fs.counts.readdirSync, 0, 'the 404 path never scans');
  });
});
