import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Pins the behavior of the module-scope TTL-cache primitives in server/index.js:
//   - `cached(key, ttlMs, fn)` returns a cached entry when one exists and is younger
//     than ttlMs; otherwise, once the cache reaches MAX_CACHE_ENTRIES (200), it drops
//     the oldest 25% of entries by time, runs fn(), stores {data, time}, and returns it.
//   - `invalidateCache(pattern)` deletes every key whose name includes `pattern`, or
//     clears the whole cache when called with no pattern (or an empty one).
//
// The ~24 cached / invalidateCache references already in tests/ are all test-local
// MOCKED ctx.cached / ctx.invalidateCache used to drive route handlers; none exercise
// server/index.js's REAL eviction (drop the oldest 25% at the 200-entry cap) or the real
// substring-match / full-clear. This add-only characterization test pins those bytes.
//
// server/index.js calls server.listen() at module load and exports nothing, so it cannot be
// require()'d from a unit test. Following tests/next-server-walkdir-hasallowedext.test.mjs
// and tests/moon-etag-json-cachecontrol.test.mjs, we lift the exact source of the two
// top-level functions, brace-balance their bodies, and instantiate them together in
// ONE new Function scope (they share the module-scope `cache` object) while injecting a
// fresh cache and the real MAX_CACHE_ENTRIES. This pins the helpers' real bytes rather
// than a reimplementation, and never boots a server (matching the rest of the suite).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

// Lift a top-level `function <name>` out of server/index.js by brace balancing. The start is
// the line beginning with `function <name>`; the end is the line where the brace depth
// returns to zero. Robust to indentation and nested blocks (the bodies hold no braces
// inside strings or comments). Fails loud (a failed assert or a SyntaxError from new
// Function), never silently. Mirrors the sibling source-lift tests.
function extractFn(src, name) {
  const lines = src.split('\n');
  const startRe = new RegExp('^function ' + name + '\\b');
  const start = lines.findIndex(l => startRe.test(l));
  assert.ok(start !== -1, `server/index.js must define a top-level \`function ${name}\``);
  let depth = 0, opened = false, end = -1;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') depth--;
    }
    if (opened && depth === 0) { end = i; break; }
  }
  assert.ok(end !== -1, `could not find the end of \`function ${name}\` in server/index.js`);
  return lines.slice(start, end + 1).join('\n');
}

// Read the real server/index.js once and lift cached + invalidateCache into a single factory.
// Each call to make(cache, MAX_CACHE_ENTRIES) binds both functions to the supplied cache
// object, so every test gets an isolated, fresh cache.
function liftCacheFns() {
  const src = readFileSync(path.join(REPO_ROOT, 'src/server/index.js'), 'utf-8');
  const cachedSrc = extractFn(src, 'cached');
  const invalidateCacheSrc = extractFn(src, 'invalidateCache');
  // Pin the eviction cap against the real source constant, not a hard-coded copy.
  const maxMatch = src.match(/^const MAX_CACHE_ENTRIES = (\d+);/m);
  assert.ok(maxMatch, 'server/index.js must declare `const MAX_CACHE_ENTRIES = <n>;`');
  const MAX_CACHE_ENTRIES = Number(maxMatch[1]);
  const combined = [cachedSrc, invalidateCacheSrc].join('\n\n');
  const make = new Function(
    'cache', 'MAX_CACHE_ENTRIES',
    `${combined}\nreturn { cached, invalidateCache };`,
  );
  return { cachedSrc, invalidateCacheSrc, MAX_CACHE_ENTRIES, make };
}

const { cachedSrc, invalidateCacheSrc, MAX_CACHE_ENTRIES, make } = liftCacheFns();

// A fresh, isolated cache plus the two functions bound to it, for one test.
function freshInstance() {
  const cache = {};
  const { cached, invalidateCache } = make(cache, MAX_CACHE_ENTRIES);
  return { cache, cached, invalidateCache };
}

describe('server/index.js cached/invalidateCache source-lift (shape)', () => {
  it('lifts both real functions and the eviction cap (MAX_CACHE_ENTRIES === 200)', () => {
    assert.match(cachedSrc, /^function cached\(key, ttlMs, fn\) \{/m);
    assert.match(invalidateCacheSrc, /^function invalidateCache\(pattern\) \{/m);
    assert.equal(MAX_CACHE_ENTRIES, 200);
  });

  it('pins the real freshness check and eviction bytes in cached()', () => {
    assert.match(cachedSrc, /if \(entry && Date\.now\(\) - entry\.time < ttlMs\) return entry\.data;/);
    assert.match(cachedSrc, /if \(keys\.length >= MAX_CACHE_ENTRIES\) \{/);
    assert.match(cachedSrc, /sorted\.slice\(0, Math\.floor\(MAX_CACHE_ENTRIES \* 0\.25\)\)/);
    assert.ok(cachedSrc.includes('for (const k of toRemove) delete cache[k];'),
      'cached() must keep the real eviction loop');
  });

  it('pins the real substring-match / full-clear bytes in invalidateCache()', () => {
    assert.match(invalidateCacheSrc, /if \(!pattern \|\| key\.includes\(pattern\)\) delete cache\[key\];/);
  });
});

describe('server/index.js cached() TTL + eviction behavior', () => {
  it('TTL HIT: returns the fresh cached value without calling fn', () => {
    const { cache, cached } = freshInstance();
    let calls = 0;
    const spy = () => { calls++; return 'fresh'; };
    cache['key'] = { data: 'hit', time: Date.now() };
    const out = cached('key', 1e9, spy);
    assert.equal(out, 'hit');
    assert.equal(calls, 0, 'fn must not run on a fresh hit');
  });

  it('TTL MISS (expiry): re-runs fn and overwrites the stale entry', () => {
    const { cache, cached } = freshInstance();
    // time 0 against a 1 ms ttl is flake-proof: the live clock sits around 1.78e12 ms,
    // so the entry always reads as far past expiry without needing a frozen clock.
    cache['key'] = { data: 'old', time: 0 };
    const out = cached('key', 1, () => 'fresh');
    assert.equal(out, 'fresh');
    assert.equal(cache['key'].data, 'fresh');
  });

  it('COLD miss: runs fn and stores the result', () => {
    const { cache, cached } = freshInstance();
    const out = cached('k', 1e9, () => 'v');
    assert.equal(out, 'v');
    assert.equal(cache['k'].data, 'v');
  });

  it('EVICTION at capacity: drops the 50 oldest-by-time entries, keeps the rest plus the new entry', () => {
    const { cache, cached } = freshInstance();
    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
      cache['k' + i] = { data: 'v' + i, time: i };
    }
    assert.equal(Object.keys(cache).length, MAX_CACHE_ENTRIES);

    const out = cached('new', 1e9, () => 'n');
    assert.equal(out, 'n');

    const toEvict = Math.floor(MAX_CACHE_ENTRIES * 0.25); // 50
    // The 50 lowest-time keys (k0 through k49) are gone.
    for (let i = 0; i < toEvict; i++) {
      assert.equal(cache['k' + i], undefined, `k${i} should have been evicted`);
    }
    // The boundary survivor and the highest-time key remain.
    assert.ok(cache['k' + toEvict], 'k50 (first survivor) must remain');
    assert.ok(cache['k' + (MAX_CACHE_ENTRIES - 1)], 'k199 (highest time) must survive');
    assert.equal(cache['new'].data, 'n');
    // 200 seeded, then 50 evicted, then 1 new, leaving 151.
    assert.equal(Object.keys(cache).length, MAX_CACHE_ENTRIES - toEvict + 1);
  });
});

describe('server/index.js invalidateCache() substring-match / full-clear', () => {
  it('deletes only keys matching the pattern, leaving the rest', () => {
    const { cache, invalidateCache } = freshInstance();
    cache['search:a'] = { data: 1, time: 0 };
    cache['search:b'] = { data: 2, time: 0 };
    cache['graph:c'] = { data: 3, time: 0 };

    invalidateCache('search');
    assert.equal(cache['search:a'], undefined);
    assert.equal(cache['search:b'], undefined);
    assert.ok(cache['graph:c'], 'a non-matching key must survive');
    assert.equal(Object.keys(cache).length, 1);
  });

  it('clears the entire cache when called with no pattern', () => {
    const { cache, invalidateCache } = freshInstance();
    cache['search:a'] = { data: 1, time: 0 };
    cache['graph:c'] = { data: 3, time: 0 };
    assert.equal(Object.keys(cache).length, 2);

    invalidateCache();
    assert.equal(Object.keys(cache).length, 0);
  });

  it('treats an empty-string pattern as a full clear', () => {
    const { cache, invalidateCache } = freshInstance();
    cache['search:a'] = { data: 1, time: 0 };
    cache['graph:c'] = { data: 3, time: 0 };

    invalidateCache('');
    assert.equal(Object.keys(cache).length, 0);
  });
});
