import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the sibling per-key cache
// suites do (next-content-c-mentions-cache, next-statsdir-cache) and reuse their
// ctx-mocking shape. The three references.yaml query handlers
// (recommend-by-author, venue-stats, author-profile) now wrap their parse and
// aggregation in cached(<prefix> + param, 60000, fn); these tests drive that wrap
// directly with a counting fs and a memoizing cached, no network and no server.
// The handlers call require('js-yaml') and yaml.load themselves, so the fs stub
// just returns YAML text for bibliography/references.yaml and the real js-yaml
// parses it, exactly as production does.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

const PROJECT_ROOT = '/proj';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

// A tiny bibliography whose document order (smith2020, jones2019, white2021) is the
// iteration order of Object.entries / Object.values, so every score, sort, and Set
// insertion below is deterministic and hand-traceable. Years are unquoted so
// js-yaml parses them as numbers, matching the numeric year fields the handlers
// emit.
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

// fs stub that serves REFERENCES_YAML for the one path the handlers read and counts
// readFileSync calls. Each handler's computation reads references.yaml exactly once,
// so the counter proves a cache hit performs no fresh read while a distinct
// parameter re-parses.
function makeRefsFs(yamlText) {
  const counts = { readFileSync: 0 };
  const fs = {
    readFileSync(fp) {
      counts.readFileSync++;
      if (fp === REFS_PATH) return yamlText;
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
  return { fs, counts };
}

// fs stub whose readFileSync always throws, standing in for an unreadable or broken
// references.yaml. It lets a test prove the try/catch outside the closure still
// returns the existing 500 and that the throw inside fn() leaves nothing cached.
function makeThrowingFs() {
  const counts = { readFileSync: 0 };
  const fs = {
    readFileSync() {
      counts.readFileSync++;
      const e = new Error('boom'); e.code = 'EIO'; throw e;
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

// Invoke one GET handler with a mocked ctx and capture json(res, status, payload).
// `value` is undefined to omit the query parameter entirely (the missing-parameter
// guard case); otherwise it is encoded into the query string.
async function invoke({ pathname, param, value, fs, cached }) {
  const search = value === undefined ? '' : `?${param}=${encodeURIComponent(value)}`;
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    fs, path, PROJECT_ROOT, cached,
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// ── Hand-traced pre-cache outputs ──
// Each EXPECTED below is computed by hand from REFERENCES_YAML, so it is an
// independent reference for the handler's output, not a capture of it. Field order
// matches each handler's returned object literal, so a JSON.stringify comparison
// pins serialization (byte-identity), not just structural equality.

// recommend-by-author?name=Alice Smith: Alice co-authors with Bob (smith2020) and
// prefers NeurIPS. jones2019 shares coauthor Bob (score 2); white2021 shares only
// venue NeurIPS (score 1). Sorted by score desc.
const EXPECTED_BYAUTHOR_ALICE = {
  author: 'Alice Smith',
  recommendations: [
    { key: 'jones2019', title: 'Wide Nets', year: 2019, venue: 'ICML', score: 2 },
    { key: 'white2021', title: 'Graph Nets', year: 2021, venue: 'NeurIPS', score: 1 },
  ],
};
// recommend-by-author?name=Dave: no entry lists Dave, so there are no coauthors or
// preferred venues and nothing scores above zero.
const EXPECTED_BYAUTHOR_DAVE = { author: 'Dave', recommendations: [] };

// venue-stats?venue=NeurIPS: smith2020 and white2021. paperCount is the full count
// before papers is sorted desc and sliced; authorCount is the distinct-author count.
const EXPECTED_VENUE_NEURIPS = {
  venue: 'NeurIPS',
  paperCount: 2,
  authorCount: 3,
  topAuthors: [
    { name: 'Alice Smith', count: 1 },
    { name: 'Bob Jones', count: 1 },
    { name: 'Carol White', count: 1 },
  ],
  yearDistribution: [
    { year: 2020, count: 1 },
    { year: 2021, count: 1 },
  ],
  papers: [
    { key: 'white2021', title: 'Graph Nets', year: 2021, authors: ['Carol White'] },
    { key: 'smith2020', title: 'Deep Nets', year: 2020, authors: ['Alice Smith', 'Bob Jones'] },
  ],
};
// venue-stats?venue=ICML: only jones2019.
const EXPECTED_VENUE_ICML = {
  venue: 'ICML',
  paperCount: 1,
  authorCount: 2,
  topAuthors: [
    { name: 'Bob Jones', count: 1 },
    { name: 'Carol White', count: 1 },
  ],
  yearDistribution: [
    { year: 2019, count: 1 },
  ],
  papers: [
    { key: 'jones2019', title: 'Wide Nets', year: 2019, authors: ['Bob Jones', 'Carol White'] },
  ],
};

// author-profile?name=Carol White: jones2019 and white2021. papers sorted by year
// desc; venues in entry-iteration order (ICML then NeurIPS); yearRange spans the
// sorted ends.
const EXPECTED_PROFILE_CAROL = {
  name: 'Carol White',
  paperCount: 2,
  papers: [
    { key: 'white2021', title: 'Graph Nets', year: 2021, venue: 'NeurIPS' },
    { key: 'jones2019', title: 'Wide Nets', year: 2019, venue: 'ICML' },
  ],
  coauthors: ['Bob Jones'],
  venues: ['ICML', 'NeurIPS'],
  yearRange: { earliest: 2019, latest: 2021 },
};
// author-profile?name=Alice Smith: only smith2020.
const EXPECTED_PROFILE_ALICE = {
  name: 'Alice Smith',
  paperCount: 1,
  papers: [
    { key: 'smith2020', title: 'Deep Nets', year: 2020, venue: 'NeurIPS' },
  ],
  coauthors: ['Bob Jones'],
  venues: ['NeurIPS'],
  yearRange: { earliest: 2020, latest: 2020 },
};

// Shared suite proving, for one handler, the five GOAL invariants: byte-identity,
// cache hit skips the read, distinct parameters key separately, the exact key and
// TTL, and the 400 guard plus 500 path both staying outside the cache.
function describeCacheSuite({ title, pathname, param, keyPrefix, value1, value2, expected1, expected2, missing400, error500 }) {
  describe(title, () => {
    it('returns the expected payload, byte-identical, on the first call and parses references.yaml once', async () => {
      const { fs, counts } = makeRefsFs(REFERENCES_YAML);
      const { cached } = makeCached();
      const res = await invoke({ pathname, param, value: value1, fs, cached });
      assert.equal(res.status, 200);
      assert.deepEqual(res.payload, expected1);
      // Byte-identity: same fields, same order, same serialization as before caching.
      assert.equal(JSON.stringify(res.payload), JSON.stringify(expected1));
      assert.equal(counts.readFileSync, 1, 'the first call parses references.yaml exactly once');
    });

    it('serves a repeat request for the same parameter from cache with no second references.yaml read', async () => {
      const { fs, counts } = makeRefsFs(REFERENCES_YAML);
      const { cached, store } = makeCached();

      const first = await invoke({ pathname, param, value: value1, fs, cached });
      assert.equal(first.status, 200);
      assert.equal(counts.readFileSync, 1, 'the first call reads references.yaml');

      const second = await invoke({ pathname, param, value: value1, fs, cached });
      assert.equal(second.status, 200);
      assert.deepEqual(second.payload, first.payload);
      assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
      assert.equal(counts.readFileSync, 1, 'the cached repeat must not read references.yaml again');
      assert.equal(store.size, 1, 'one cache entry for the single parameter');
      assert.ok(store.has(keyPrefix + value1), `cache key is "${keyPrefix}" + ${param}`);
    });

    it('keys each distinct parameter separately and re-parses references.yaml for a new value', async () => {
      const { fs, counts } = makeRefsFs(REFERENCES_YAML);
      const { cached, store } = makeCached();

      const a = await invoke({ pathname, param, value: value1, fs, cached });
      assert.equal(a.status, 200);
      assert.equal(counts.readFileSync, 1);

      const b = await invoke({ pathname, param, value: value2, fs, cached });
      assert.equal(b.status, 200);
      assert.deepEqual(b.payload, expected2);
      assert.notDeepEqual(b.payload, a.payload);
      assert.equal(counts.readFileSync, 2, 'a new parameter misses the cache and re-parses references.yaml');
      assert.equal(store.size, 2, 'each parameter gets its own cache entry');
      assert.ok(store.has(keyPrefix + value1) && store.has(keyPrefix + value2));
    });

    it('pins the exact cache key prefix and the 60000 ms TTL the handler passes', async () => {
      const { fs } = makeRefsFs(REFERENCES_YAML);
      const { cached, calls } = makeCached();
      await invoke({ pathname, param, value: value1, fs, cached });
      assert.ok(calls.length >= 1, 'the handler routes through cached()');
      assert.equal(calls[0].key, keyPrefix + value1);
      assert.equal(calls[0].ttl, 60000);
    });

    it('returns 400 for a missing parameter before the cache and never reads or caches', async () => {
      const { fs, counts } = makeRefsFs(REFERENCES_YAML);
      const { cached, store, calls } = makeCached();
      const res = await invoke({ pathname, param, value: undefined, fs, cached });
      assert.equal(res.status, 400);
      assert.deepEqual(res.payload, { error: missing400 });
      assert.equal(calls.length, 0, 'the missing-parameter guard returns before cached() is reached');
      assert.equal(store.size, 0, 'the 400 path is never cached');
      assert.equal(counts.readFileSync, 0, 'no references.yaml read on a 400');
    });

    it('does not cache a 500 when references.yaml cannot be read (try/catch stays outside the closure)', async () => {
      const { fs, counts } = makeThrowingFs();
      const { cached, store, calls } = makeCached();
      const res = await invoke({ pathname, param, value: value1, fs, cached });
      assert.equal(res.status, 500);
      assert.deepEqual(res.payload, { error: error500 });
      // The parameter is present, so the handler reaches cached(); fn() throws inside
      // the closure before the store, so the real cached() (run-then-store) keeps the
      // 500 uncached.
      assert.ok(calls.length >= 1, 'the handler reaches cached() since the parameter is present');
      assert.equal(store.size, 0, 'the 500 is never cached');
      assert.ok(counts.readFileSync >= 1, 'the closure attempted the references.yaml read before throwing');
    });
  });
}

describeCacheSuite({
  title: 'GET /api/references/recommend-by-author (cached via "byauthor:" + name)',
  pathname: '/api/references/recommend-by-author',
  param: 'name',
  keyPrefix: 'byauthor:',
  value1: 'Alice Smith',
  value2: 'Dave',
  expected1: EXPECTED_BYAUTHOR_ALICE,
  expected2: EXPECTED_BYAUTHOR_DAVE,
  missing400: 'Missing name',
  error500: 'Recommendation failed',
});

describeCacheSuite({
  title: 'GET /api/references/venue-stats (cached via "venuestats:" + venue)',
  pathname: '/api/references/venue-stats',
  param: 'venue',
  keyPrefix: 'venuestats:',
  value1: 'NeurIPS',
  value2: 'ICML',
  expected1: EXPECTED_VENUE_NEURIPS,
  expected2: EXPECTED_VENUE_ICML,
  missing400: 'Missing venue',
  error500: 'Venue stats failed',
});

describeCacheSuite({
  title: 'GET /api/references/author-profile (cached via "authorprofile:" + name)',
  pathname: '/api/references/author-profile',
  param: 'name',
  keyPrefix: 'authorprofile:',
  value1: 'Carol White',
  value2: 'Alice Smith',
  expected1: EXPECTED_PROFILE_CAROL,
  expected2: EXPECTED_PROFILE_ALICE,
  missing400: 'Missing name',
  error500: 'Profile aggregation failed',
});

// recommend-by-author and author-profile both read ?name=, but their distinct key
// prefixes keep them from colliding: the same name on both endpoints yields two
// separate cache entries and two parses, never one endpoint serving the other's
// payload.
describe('shared ?name= does not collide across the byauthor: and authorprofile: caches', () => {
  it('keeps two distinct entries for the same name on the two endpoints', async () => {
    const { fs, counts } = makeRefsFs(REFERENCES_YAML);
    const { cached, store } = makeCached();

    const rec = await invoke({ pathname: '/api/references/recommend-by-author', param: 'name', value: 'Alice Smith', fs, cached });
    const prof = await invoke({ pathname: '/api/references/author-profile', param: 'name', value: 'Alice Smith', fs, cached });

    assert.equal(rec.status, 200);
    assert.equal(prof.status, 200);
    assert.deepEqual(rec.payload, EXPECTED_BYAUTHOR_ALICE);
    assert.deepEqual(prof.payload, EXPECTED_PROFILE_ALICE);
    assert.notDeepEqual(rec.payload, prof.payload);
    assert.equal(store.size, 2, 'distinct prefixes keep the two endpoints from sharing a cache entry');
    assert.ok(store.has('byauthor:Alice Smith'));
    assert.ok(store.has('authorprofile:Alice Smith'));
    assert.equal(counts.readFileSync, 2, 'each endpoint parses references.yaml for its own entry');
  });
});
