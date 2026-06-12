import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the sibling route suites do
// (next-graphexport-cache, next-content-c-mentions-cache).
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/virtual';

// A counting fs whose only method is readFileSync: the /api/references/duplicates
// handler's single filesystem touch is one read of bibliography/references.yaml.
// Counting that read lets a test prove a cached repeat performs no second read.
function makeFs(yamlText) {
  const counts = { readFileSync: 0 };
  return {
    counts,
    readFileSync(p) {
      counts.readFileSync++;
      if (String(p).endsWith('references.yaml')) return yamlText;
      const e = new Error(`unexpected read: ${p}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// A memoizing cached(key, ttl, fn) mirroring the server.js helper: run fn and
// store on a miss, return the stored value untouched on a hit; fn() throwing
// stores nothing, so an error response stays uncached. Every call is recorded in
// `calls` so a test can pin the exact key and TTL the handler passes.
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

// Drive GET /api/references/duplicates once. fs and cached are passed in so a
// single pair can be shared across calls within a test, letting the cache persist.
async function getDuplicates(fs, cached) {
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL('http://localhost/api/references/duplicates');
  await routes({ method: 'GET' }, { writableEnded: false }, url, '/api/references/duplicates', ctx);
  return captured;
}

// The same two-collision fixture the fold-total suite pins:
//   - "Attention Is All You Need" x2 (case-only difference normalizes the same)
//   - "BERT Pre-training ..." x3 (punctuation/case differences normalize the same)
//   - two unique singletons (count 1, excluded), a too-short title ("AI"), and an
//     entry with no title (both skipped). The BERT group (3) outsizes the Attention
//     group (2), so the descending-by-count sort is deterministic.
const FIXTURE = `
vaswani2017:
  title: "Attention Is All You Need"
  year: 2017
  venue: "NeurIPS"
vaswani2017dup:
  title: "Attention is all you need"
  year: 2017
  venue: "arXiv"
bert1:
  title: "BERT Pre-training of Deep Bidirectional Transformers"
  year: 2019
  venue: "NAACL"
bert2:
  title: "BERT: Pre-training of Deep Bidirectional Transformers"
  year: 2018
  venue: "arXiv"
bert3:
  title: "Bert pre-training of deep bidirectional transformers"
  year: 2019
  venue: "ACL"
gan2014:
  title: "Generative Adversarial Networks"
  year: 2014
  venue: "NeurIPS"
dropout2014:
  title: "Dropout A Simple Way to Prevent Overfitting"
  year: 2014
  venue: "JMLR"
short1:
  title: "AI"
  year: 2020
  venue: "X"
notitle:
  year: 2020
  venue: "Y"
`;

// The proven pre-cache output for FIXTURE. Field order matches the handler's
// returned object literal (duplicates, totalDuplicateGroups, totalDuplicateEntries)
// and each group/entry's key order, so a JSON.stringify comparison pins byte
// identity, not just structural equality. This is the same payload the existing
// next-duplicates-fold-total suite pins for this fixture, so matching it proves
// wrapping the handler in cached() left the response byte-for-byte unchanged.
const EXPECTED = {
  duplicates: [
    {
      title: 'BERT Pre-training of Deep Bidirectional Transformers',
      entries: [
        { key: 'bert1', title: 'BERT Pre-training of Deep Bidirectional Transformers', year: 2019, venue: 'NAACL' },
        { key: 'bert2', title: 'BERT: Pre-training of Deep Bidirectional Transformers', year: 2018, venue: 'arXiv' },
        { key: 'bert3', title: 'Bert pre-training of deep bidirectional transformers', year: 2019, venue: 'ACL' },
      ],
      count: 3,
    },
    {
      title: 'Attention Is All You Need',
      entries: [
        { key: 'vaswani2017', title: 'Attention Is All You Need', year: 2017, venue: 'NeurIPS' },
        { key: 'vaswani2017dup', title: 'Attention is all you need', year: 2017, venue: 'arXiv' },
      ],
      count: 2,
    },
  ],
  totalDuplicateGroups: 2,
  totalDuplicateEntries: 5,
};

describe('GET /api/references/duplicates (scan + fold cached under references-duplicates)', () => {
  it('returns the expected duplicates payload, byte-identical, on the first call', async () => {
    const fs = makeFs(FIXTURE);
    const { cached } = makeCached();
    const res = await getDuplicates(fs, cached);
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED);
    // Byte-identity: same fields, same order, same serialization as before caching.
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED));
    // The first request must actually read references.yaml, else the cache-hit
    // assertion below would pass vacuously.
    assert.ok(fs.counts.readFileSync > 0, 'the first call reads references.yaml');
  });

  it('serves a repeat request from cache with no repeat references.yaml read', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();

    const first = await getDuplicates(fs, cached);
    const readAfterFirst = fs.counts.readFileSync;
    assert.equal(first.status, 200);
    assert.ok(readAfterFirst > 0, 'the first call hits the filesystem');

    const second = await getDuplicates(fs, cached);
    assert.equal(second.status, 200);
    // (1)/(2) The payload is byte-identical across back-to-back cached calls.
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    // (3) The cache is actually used: the second request triggered no further read.
    assert.equal(fs.counts.readFileSync, readAfterFirst, 'cached repeat must not re-read references.yaml');
    assert.equal(store.size, 1, 'one cache entry for the single static key');
    assert.ok(store.has('references-duplicates'), "cache key is 'references-duplicates'");
  });

  it("pins the cache key and the 60000 ms TTL the handler passes", async () => {
    const fs = makeFs(FIXTURE);
    const { cached, calls } = makeCached();
    await getDuplicates(fs, cached);
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'references-duplicates');
    assert.equal(calls[0].ttl, 60000);
  });

  it('returns 500 and caches nothing when the read fails (try/catch stays outside the cache)', async () => {
    const counts = { readFileSync: 0 };
    const throwingFs = {
      counts,
      readFileSync(_p) { counts.readFileSync++; const e = new Error('boom'); e.code = 'EACCES'; throw e; },
    };
    const { cached, store } = makeCached();

    const first = await getDuplicates(throwingFs, cached);
    assert.equal(first.status, 500);
    assert.deepEqual(first.payload, { error: 'Deduplication failed' });
    assert.equal(store.size, 0, 'a failed computation caches nothing');

    // The read threw inside cached() before anything was stored, so a repeat
    // request re-attempts the read and still 500s, never serving a cached error.
    const second = await getDuplicates(throwingFs, cached);
    assert.equal(second.status, 500);
    assert.deepEqual(second.payload, { error: 'Deduplication failed' });
    assert.equal(store.size, 0, 'still nothing cached after a repeat failure');
    assert.ok(counts.readFileSync >= 2, 'each failing request re-reads because nothing is cached');
  });
});
