import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Pins the LRU recency and eviction ORDER of the bounded read cache in
// server/data-store.js:
//   - `const MAX_CACHE_ENTRIES = 200;` caps the Map.
//   - `cacheGet(key)` returns the entry and, on a hit, runs cache.delete(key)
//     then cache.set(key, entry), moving the key to most-recently-used.
//   - `cacheSet(key, mtimeMs, size, data)` runs cache.delete(key) then
//     cache.set(key, {...}) and, while the size exceeds the cap, evicts the
//     least-recently-used key via cache.keys().next().value.
//
// The existing tests/data-store.test.mjs "bounded cache" case asserts only that
// _cacheSize() stays at or below MAX_CACHE_ENTRIES; it never pins WHICH entry
// survives, so the LRU (recency), not FIFO (insertion), contract is unpinned.
// Eviction is invisible through the public loadJSON / saveJSON API (a cached
// value always equals disk content), so this add-only test uses the SOURCE-LIFT
// technique to drive the two primitives directly.
//
// Following tests/next-server-cached-invalidatecache.test.mjs and
// tests/next-server-ratelimit-keycap-evict.test.mjs, we read the real
// data-store.js, brace balance the cacheGet and cacheSet bodies, and instantiate
// them TOGETHER in ONE new Function scope sharing an injected `cache` Map and a
// small injected MAX_CACHE_ENTRIES, so eviction is driven cheaply (cap 3) without
// seeding 200 entries. This pins the real bytes, not a reimplementation, and
// never boots a server. The bodies hold no braces inside strings or comments, so
// plain brace counting is exact.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const DATA_STORE = path.join(REPO_ROOT, 'src', 'server', 'data-store.js');

// Lift a top-level `function <name>` out of data-store.js by brace balancing. The
// start is the line beginning with `function <name>`; the end is the line where
// the brace depth returns to zero. Fails loud (a failed assert or a SyntaxError
// from new Function), never silently. Mirrors the sibling source-lift tests.
function extractFn(src, name) {
  const lines = src.split('\n');
  const startRe = new RegExp('^function ' + name + '\\b');
  const start = lines.findIndex(l => startRe.test(l));
  assert.ok(start !== -1, `data-store.js must define a top-level \`function ${name}\``);
  let depth = 0, opened = false, end = -1;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') depth--;
    }
    if (opened && depth === 0) { end = i; break; }
  }
  assert.ok(end !== -1, `could not find the end of \`function ${name}\` in data-store.js`);
  return lines.slice(start, end + 1).join('\n');
}

// Read the real data-store.js once and lift cacheGet plus cacheSet into a single
// factory. make(cache, MAX_CACHE_ENTRIES) binds both functions to the supplied
// Map and cap, so every test gets an isolated, fresh cache they share.
const src = readFileSync(DATA_STORE, 'utf-8');
const cacheGetSrc = extractFn(src, 'cacheGet');
const cacheSetSrc = extractFn(src, 'cacheSet');
// Pin the real eviction cap against the source constant, not a hard-coded copy,
// so a future change to the cap is caught here.
const maxMatch = src.match(/^const MAX_CACHE_ENTRIES = (\d+);/m);
assert.ok(maxMatch, 'data-store.js must declare `const MAX_CACHE_ENTRIES = <n>;`');
const REAL_MAX_CACHE_ENTRIES = Number(maxMatch[1]);
const make = new Function(
  'cache', 'MAX_CACHE_ENTRIES',
  `${cacheGetSrc}\n\n${cacheSetSrc}\nreturn { cacheGet, cacheSet };`,
);

// A fresh, isolated Map plus the two functions bound to it and a tiny cap, for one
// test. Cap defaults to 3 so eviction triggers after a few inserts.
function freshInstance(cap = 3) {
  const cache = new Map();
  const { cacheGet, cacheSet } = make(cache, cap);
  return { cache, cacheGet, cacheSet };
}

// Insert `key` with throwaway but distinct entry fields, mirroring cacheSet's real
// (mtimeMs, size, data) signature.
function seed(cacheSet, key, i = 0) {
  cacheSet(key, 1000 + i, 10 + i, { v: key });
}

describe('data-store.js cacheGet/cacheSet source-lift (shape)', () => {
  it('lifts both real functions and the eviction cap (MAX_CACHE_ENTRIES === 200)', () => {
    assert.match(cacheGetSrc, /^function cacheGet\(key\) \{/m);
    assert.match(cacheSetSrc, /^function cacheSet\(key, mtimeMs, size, data\) \{/m);
    assert.equal(REAL_MAX_CACHE_ENTRIES, 200);
  });

  it('pins the real LRU recency-refresh bytes in cacheGet()', () => {
    // On a hit: read, delete, then re-set, moving the key to most-recently-used.
    assert.match(cacheGetSrc, /const entry = cache\.get\(key\);/);
    assert.ok(cacheGetSrc.includes('cache.delete(key);'), 'cacheGet must delete on a hit');
    assert.ok(cacheGetSrc.includes('cache.set(key, entry);'), 'cacheGet must re-set on a hit');
  });

  it('pins the real eviction bytes in cacheSet()', () => {
    assert.match(cacheSetSrc, /while \(cache\.size > MAX_CACHE_ENTRIES\) \{/);
    assert.ok(
      cacheSetSrc.includes('cache.delete(cache.keys().next().value);'),
      'cacheSet must evict the least-recently-used key (keys().next().value)',
    );
  });
});

describe('data-store.js LRU recency + eviction order', () => {
  it('(a) cacheSet seeds preserve insertion order', () => {
    const { cache, cacheSet } = freshInstance();
    seed(cacheSet, 'A', 1);
    seed(cacheSet, 'B', 2);
    seed(cacheSet, 'C', 3);
    assert.deepStrictEqual([...cache.keys()], ['A', 'B', 'C']);
  });

  it('(b) cacheGet(existing) moves the key to most-recently-used', () => {
    const { cache, cacheGet, cacheSet } = freshInstance();
    seed(cacheSet, 'A', 1);
    seed(cacheSet, 'B', 2);
    seed(cacheSet, 'C', 3);
    const got = cacheGet('A');                 // touch the current LRU
    assert.deepStrictEqual(got, { mtimeMs: 1001, size: 11, data: { v: 'A' } });
    assert.deepStrictEqual([...cache.keys()], ['B', 'C', 'A']);
  });

  it('(c) cacheSet at cap evicts keys().next().value (the LRU / oldest)', () => {
    const { cache, cacheSet } = freshInstance(3);
    seed(cacheSet, 'A', 1);
    seed(cacheSet, 'B', 2);
    seed(cacheSet, 'C', 3);
    seed(cacheSet, 'D', 4);                     // size 4 over cap 3: evict oldest (A)
    assert.deepStrictEqual([...cache.keys()], ['B', 'C', 'D']);
    assert.equal(cache.size, 3);
    assert.equal(cache.has('A'), false);
  });

  it('(d) LRU not FIFO: a cacheGet-touched entry survives eviction while a colder one is dropped', () => {
    const { cache, cacheGet, cacheSet } = freshInstance(3);
    seed(cacheSet, 'A', 1);
    seed(cacheSet, 'B', 2);
    seed(cacheSet, 'C', 3);
    cacheGet('A');                              // A becomes most-recently-used: B, C, A
    seed(cacheSet, 'D', 4);                     // size 4 over cap 3: evict the LRU, now B
    // Under FIFO, A (first inserted) would be dropped. Under LRU it survives because
    // it was just touched, and the colder B is evicted instead. This is the
    // load-bearing recency proof.
    assert.deepStrictEqual([...cache.keys()], ['C', 'A', 'D']);
    assert.equal(cache.has('A'), true, 'recently-touched A must survive (LRU, not FIFO)');
    assert.equal(cache.has('B'), false, 'colder B must be evicted');
  });

  it('(e) cacheGet(missing) returns undefined and inserts nothing', () => {
    const { cache, cacheGet, cacheSet } = freshInstance();
    seed(cacheSet, 'A', 1);
    seed(cacheSet, 'B', 2);
    const before = [...cache.keys()];
    assert.equal(cacheGet('Z'), undefined);
    assert.equal(cache.size, 2);
    assert.deepStrictEqual([...cache.keys()], before); // no insert, no reorder
  });

  it('(f) cacheSet overwrite moves the key to MRU and updates its data / mtimeMs / size', () => {
    const { cache, cacheSet } = freshInstance();
    cacheSet('A', 1001, 11, { v: 'A' });
    cacheSet('B', 1002, 12, { v: 'B' });
    cacheSet('C', 1003, 13, { v: 'C' });
    cacheSet('A', 9999, 88, { v: 'A2' });       // overwrite the existing key A
    assert.deepStrictEqual([...cache.keys()], ['B', 'C', 'A']); // A is now MRU
    assert.deepStrictEqual(cache.get('A'), { mtimeMs: 9999, size: 88, data: { v: 'A2' } });
  });
});
