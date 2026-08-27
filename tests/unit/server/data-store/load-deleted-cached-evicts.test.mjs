import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  saveJSON,
  loadJSON,
  _cacheSize,
  _clearCache,
} = require('../../../../server/data-store.js');

let root;

// Each case writes under its own sub-directory so the persistent fixture never
// lets one case's file collide with another's. saveJSON creates the parent
// directory recursively, so naming a fresh sub-directory per case is enough.
function fileIn(name) {
  return path.join(root, name, 'store.json');
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsload-'));
});

beforeEach(() => {
  _clearCache(); // never let the module cache leak across cases
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// These cases pin the CURRENT, correct behavior of the statSync failure branch
// of loadJSON (server/data-store.js, the catch around lines 84 to 86) for a file
// that was PRIMED into the write-through cache and is then deleted from disk.
// That catch runs `cache.delete(key); return {};`, so a cached file that
// disappears reads back as a fresh empty object AND its now stale entry is
// dropped. The existing data-store tests only delete a key that was never
// cached (a no-op delete), so eviction of a live entry stayed uncovered.
//
// The branch is provoked with a real filesystem condition (no fs mocking): the
// file is removed with fs.rmSync. The assertions compare returned values and
// integer cache sizes only, never err.code, so they are platform independent.
describe('loadJSON eviction when a primed cached file is deleted', () => {
  it('returns a fresh {} (not the stale value) after the cached file is deleted', () => {
    const f = fileIn('evict-returns-empty');
    saveJSON(f, { v: 1 });           // write-through primes the cache
    assert.equal(_cacheSize(), 1);   // the live entry is present

    fs.rmSync(f, { force: true });   // the file vanishes from disk

    // statSync now throws, so loadJSON takes the catch and returns a fresh {},
    // never the stale { v: 1 } and never null or undefined.
    assert.deepEqual(loadJSON(f), {});
  });

  it('drops the live entry and never caches the {} fallback', () => {
    const f = fileIn('evict-drops-entry');
    saveJSON(f, { v: 1 });
    assert.equal(_cacheSize(), 1);

    fs.rmSync(f, { force: true });

    // The catch ran `cache.delete(key)` on a present entry, so the size falls
    // back to 0 once the missing file is read.
    assert.deepEqual(loadJSON(f), {});
    assert.equal(_cacheSize(), 0);

    // A second read of the still missing file keeps the size at 0: the {}
    // fallback is never cached.
    assert.deepEqual(loadJSON(f), {});
    assert.equal(_cacheSize(), 0);
  });

  it('serves fresh content from disk after the deleted path is recreated', () => {
    const f = fileIn('recreate-fresh');
    saveJSON(f, { v: 1 });             // prime the cache
    fs.rmSync(f, { force: true });     // then delete to force the catch

    assert.deepEqual(loadJSON(f), {}); // this read drops the stale entry
    assert.equal(_cacheSize(), 0);     // the cache is now empty

    // Recreate the path with NEW content via a raw write (no write-through), so
    // the next read is a genuine cache miss that re-reads from disk. It returns
    // the new value, proving no stale entry was served, and repopulates the
    // cache with one entry.
    fs.writeFileSync(f, JSON.stringify({ v: 2 }), 'utf-8');
    assert.deepEqual(loadJSON(f), { v: 2 });
    assert.equal(_cacheSize(), 1);
  });
});
