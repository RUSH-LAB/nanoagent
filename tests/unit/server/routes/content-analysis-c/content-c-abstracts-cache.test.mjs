import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the sibling per-key cache
// suites do (next-content-c-ref-caches, next-content-c-mentions-cache) and reuse
// their ctx-mocking shape. GET /api/references/abstracts now wraps its
// references.yaml parse and per-key content-tree citation-context walk in
// cached('abstracts:' + query, 60000, fn); these tests drive that wrap directly
// with a counting fs and a memoizing cached, no network and no server. The handler
// calls require('js-yaml') and yaml.load itself, so the fs stub just serves YAML
// text for bibliography/references.yaml plus the content files, and the real
// js-yaml parses it, exactly as production does.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-c.js');

const PROJECT_ROOT = '/proj';
const REFS_PATH = path.join(PROJECT_ROOT, 'content', 'bibliography', 'references.yaml');
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');
const INTRO_PATH = path.join(CONTENT_DIR, 'intro.md');
const METHODS_PATH = path.join(CONTENT_DIR, 'sub', 'methods.md');
const ALLOWED_EXTS = ['.md', '.mdx'];

// A tiny bibliography whose document order (smith2020, jones2019, white2021) is the
// iteration order of Object.entries, so every match, sort, and slice below is
// deterministic and hand-traceable. Years are unquoted so js-yaml parses them as
// numbers, matching the numeric year fields the handler emits.
const REFERENCES_YAML = `smith2020:
  title: Deep Nets
  year: 2020
  venue: NeurIPS
  author:
    - Alice Smith
    - Bob Jones
jones2019:
  title: Wide Nets
  year: 2019
  venue: ICML
  author:
    - Bob Jones
    - Carol White
white2021:
  title: Graph Nets
  year: 2021
  venue: NeurIPS
  author:
    - Carol White
`;

// A two-file content tree (one nested under sub/) exercising the recursive scanCtx
// walk. intro.md cites smith2020; sub/methods.md cites white2021; nothing cites
// jones2019. Both files are short (under 80 chars), so each citation context spans
// the whole file: c.slice(max(0, idx - 80), min(len, idx + matchLen + 80)) is the
// entire string, with no newlines to collapse and nothing to trim.
const INTRO_MD = 'See [@smith2020] for details.';
const METHODS_MD = 'Per [@white2021] graphs work.';

const FILES = {
  [REFS_PATH]: REFERENCES_YAML,
  [INTRO_PATH]: INTRO_MD,
  [METHODS_PATH]: METHODS_MD,
};

// Directory listing for the content walk, keyed by absolute dir. Entries mirror
// fs.Dirent: a `name` plus an `isDirectory()` method, the only two the handler reads.
const DIRENTS = {
  [CONTENT_DIR]: [
    { name: 'intro.md', dir: false },
    { name: 'sub', dir: true },
  ],
  [path.join(CONTENT_DIR, 'sub')]: [
    { name: 'methods.md', dir: false },
  ],
};

// fs stub that serves FILES for readFileSync and DIRENTS for readdirSync, counting
// both. The readFileSync counter proves a cache hit performs no fresh read (neither
// references.yaml nor any content file) while a distinct query re-parses and re-walks.
function makeFs() {
  const counts = { readFileSync: 0, readdirSync: 0 };
  const fs = {
    readFileSync(fp) {
      counts.readFileSync++;
      if (fp in FILES) return FILES[fp];
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
    readdirSync(dir) {
      counts.readdirSync++;
      const entries = DIRENTS[dir] || [];
      return entries.map(e => ({ name: e.name, isDirectory: () => e.dir }));
    },
  };
  return { fs, counts };
}

// fs stub whose readFileSync always throws, standing in for an unreadable or broken
// references.yaml (the handler reads it first inside the closure). It lets a test
// prove the try/catch outside the closure still returns the existing 500 and that
// the throw inside fn() leaves nothing cached.
function makeThrowingFs() {
  const counts = { readFileSync: 0, readdirSync: 0 };
  const fs = {
    readFileSync() {
      counts.readFileSync++;
      const e = new Error('boom'); e.code = 'EIO'; throw e;
    },
    readdirSync(dir) {
      counts.readdirSync++;
      const entries = DIRENTS[dir] || [];
      return entries.map(e => ({ name: e.name, isDirectory: () => e.dir }));
    },
  };
  return { fs, counts };
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

// Invoke the GET /api/references/abstracts handler with a mocked ctx and capture
// json(res, status, payload). `value` is undefined to omit the q parameter entirely
// (the missing-query guard case); otherwise it is encoded into the query string.
async function invoke({ value, fs, cached }) {
  const pathname = '/api/references/abstracts';
  const search = value === undefined ? '' : `?q=${encodeURIComponent(value)}`;
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    fs, path, PROJECT_ROOT, cached, ALLOWED_EXTS,
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// ── Hand-traced pre-cache outputs ──
// Each EXPECTED below is computed by hand from REFERENCES_YAML and the content tree,
// so it is an independent reference for the handler's output, not a capture of it.
// Field order matches the handler's returned object literals
// ({key, title, year, venue, authors, contexts} then {results, total}), so a
// JSON.stringify comparison pins serialization (byte-identity), not just structure.

// q=smith: only smith2020 matches ("smith" appears in its key and author "Alice
// Smith"); jones2019 and white2021 hold no "smith". scanCtx finds [@smith2020] in
// intro.md (one context) and nothing more.
const EXPECTED_SMITH = {
  results: [
    { key: 'smith2020', title: 'Deep Nets', year: 2020, venue: 'NeurIPS', authors: ['Alice Smith', 'Bob Jones'], contexts: ['See [@smith2020] for details.'] },
  ],
  total: 1,
};

// q=graph: only white2021 matches (title "Graph Nets"). scanCtx finds [@white2021]
// in sub/methods.md (one context).
const EXPECTED_GRAPH = {
  results: [
    { key: 'white2021', title: 'Graph Nets', year: 2021, venue: 'NeurIPS', authors: ['Carol White'], contexts: ['Per [@white2021] graphs work.'] },
  ],
  total: 1,
};

// q=nets: every title contains "Nets", so all three match in document order. Each
// gets its own content walk: smith2020 -> intro.md context, jones2019 -> no citation
// anywhere (empty contexts), white2021 -> sub/methods.md context.
const EXPECTED_NETS = {
  results: [
    { key: 'smith2020', title: 'Deep Nets', year: 2020, venue: 'NeurIPS', authors: ['Alice Smith', 'Bob Jones'], contexts: ['See [@smith2020] for details.'] },
    { key: 'jones2019', title: 'Wide Nets', year: 2019, venue: 'ICML', authors: ['Bob Jones', 'Carol White'], contexts: [] },
    { key: 'white2021', title: 'Graph Nets', year: 2021, venue: 'NeurIPS', authors: ['Carol White'], contexts: ['Per [@white2021] graphs work.'] },
  ],
  total: 3,
};

describe('GET /api/references/abstracts (cached via "abstracts:" + query)', () => {
  it('returns the expected payload, byte-identical, and reads references.yaml + both content files exactly once', async () => {
    const { fs, counts } = makeFs();
    const { cached } = makeCached();
    const res = await invoke({ value: 'smith', fs, cached });
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_SMITH);
    // Byte-identity: same fields, same order, same serialization as before caching.
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_SMITH));
    // 1 references.yaml + intro.md + sub/methods.md (the smith2020 walk reads both
    // content files: it stops only at three contexts, which it never reaches).
    assert.equal(counts.readFileSync, 3, 'first call parses references.yaml once and walks both content files once');
  });

  it('serves a repeat request for the same query from cache with no second references.yaml or content read', async () => {
    const { fs, counts } = makeFs();
    const { cached, store } = makeCached();

    const first = await invoke({ value: 'smith', fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 3, 'the first call reads references.yaml and the content files');

    const second = await invoke({ value: 'smith', fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 3, 'the cached repeat must not read references.yaml or any content file again');
    assert.equal(store.size, 1, 'one cache entry for the single query');
    assert.ok(store.has('abstracts:smith'), 'cache key is "abstracts:" + query');
  });

  it('keys each distinct query separately and re-parses + re-walks for a new query', async () => {
    const { fs, counts } = makeFs();
    const { cached, store } = makeCached();

    const a = await invoke({ value: 'smith', fs, cached });
    assert.equal(a.status, 200);
    assert.deepEqual(a.payload, EXPECTED_SMITH);
    assert.equal(counts.readFileSync, 3);

    const b = await invoke({ value: 'graph', fs, cached });
    assert.equal(b.status, 200);
    assert.deepEqual(b.payload, EXPECTED_GRAPH);
    assert.notDeepEqual(b.payload, a.payload);
    // graph misses the cache: +1 references.yaml +2 content files = 6 total.
    assert.equal(counts.readFileSync, 6, 'a new query misses the cache and re-parses + re-walks');
    assert.equal(store.size, 2, 'each query gets its own cache entry');
    assert.ok(store.has('abstracts:smith') && store.has('abstracts:graph'));
  });

  it('returns a byte-identical multi-match payload (one matched key has no citation context)', async () => {
    const { fs, counts } = makeFs();
    const { cached, store } = makeCached();
    const res = await invoke({ value: 'nets', fs, cached });
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_NETS);
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_NETS));
    // 1 references.yaml + a full two-file walk for each of the three matches = 1 + 6.
    assert.equal(counts.readFileSync, 7, 'each matched key walks the whole content tree');
    assert.ok(store.has('abstracts:nets'));
  });

  it('pins the exact cache key prefix "abstracts:" and the 60000 ms TTL the handler passes', async () => {
    const { fs } = makeFs();
    const { cached, calls } = makeCached();
    await invoke({ value: 'smith', fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'abstracts:smith');
    assert.equal(calls[0].ttl, 60000);
  });

  it('keys on the normalized (lowercased, trimmed) query, so "  SMITH  " hits the same entry', async () => {
    const { fs, counts } = makeFs();
    const { cached, store, calls } = makeCached();

    const first = await invoke({ value: 'smith', fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 3);

    const second = await invoke({ value: '  SMITH  ', fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, EXPECTED_SMITH);
    assert.equal(counts.readFileSync, 3, 'the normalized query hits the existing "abstracts:smith" entry, no re-read');
    assert.equal(store.size, 1, 'normalized variants share one cache entry');
    assert.equal(calls[1].key, 'abstracts:smith', 'the key uses the normalized query, not the raw parameter');
  });

  it('returns 400 for a missing query before cached(), and never reads or caches', async () => {
    const { fs, counts } = makeFs();
    const { cached, store, calls } = makeCached();
    const res = await invoke({ value: undefined, fs, cached });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Missing query' });
    assert.equal(calls.length, 0, 'the missing-query guard returns before cached() is reached');
    assert.equal(store.size, 0, 'the 400 path is never cached');
    assert.equal(counts.readFileSync, 0, 'no references.yaml or content read on a 400');
  });

  it('treats a whitespace-only query as missing: 400 before cached(), nothing cached', async () => {
    const { fs, counts } = makeFs();
    const { cached, store, calls } = makeCached();
    const res = await invoke({ value: '   ', fs, cached });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Missing query' });
    assert.equal(calls.length, 0, 'the trimmed-empty query returns before cached()');
    assert.equal(store.size, 0);
    assert.equal(counts.readFileSync, 0);
  });

  it('does not cache a 500 when references.yaml cannot be read (try/catch stays outside the closure)', async () => {
    const { fs, counts } = makeThrowingFs();
    const { cached, store, calls } = makeCached();
    const res = await invoke({ value: 'smith', fs, cached });
    assert.equal(res.status, 500);
    assert.deepEqual(res.payload, { error: 'Abstract search failed' });
    // The query is present, so the handler reaches cached(); fn() throws inside the
    // closure before the store, so the real cached() (run-then-store) keeps it uncached.
    assert.ok(calls.length >= 1, 'the handler reaches cached() since the query is present');
    assert.equal(store.size, 0, 'the 500 is never cached');
    assert.ok(counts.readFileSync >= 1, 'the closure attempted the references.yaml read before throwing');
  });
});
