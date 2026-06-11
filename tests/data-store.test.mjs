import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  loadJSON,
  saveJSON,
  MAX_CACHE_ENTRIES,
  _cacheSize,
  _clearCache,
} = require('../server/data-store.js');

let dir;

beforeEach(() => {
  _clearCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const tmpLeftovers = (d) => fs.readdirSync(d).filter((n) => n.endsWith('.tmp'));

// ─── Round-trip ─────────────────────────────────────────────────────────────

describe('round-trip', () => {
  it('saves and loads an object unchanged', () => {
    const f = path.join(dir, 'a.json');
    const data = { a: 1, b: [1, 2, 3], c: { d: 'e' }, u: '日本語' };
    saveJSON(f, data);
    assert.deepEqual(loadJSON(f), data);
  });

  it('round-trips an array payload (preserves type)', () => {
    const f = path.join(dir, 'arr.json');
    const data = [{ id: 1 }, { id: 2 }];
    saveJSON(f, data);
    assert.deepEqual(loadJSON(f), data);
    assert.ok(Array.isArray(loadJSON(f)));
  });
});

// ─── Missing / corrupt fallback ─────────────────────────────────────────────

describe('fallback to {}', () => {
  it('returns {} for a missing file', () => {
    assert.deepEqual(loadJSON(path.join(dir, 'nope.json')), {});
  });

  it('returns {} for a corrupt file', () => {
    const f = path.join(dir, 'bad.json');
    fs.writeFileSync(f, '{ this is not valid json at all');
    assert.deepEqual(loadJSON(f), {});
  });

  it('returns {} once a previously valid (cached) file becomes corrupt', () => {
    const f = path.join(dir, 'turns-bad.json');
    saveJSON(f, { ok: true });
    assert.deepEqual(loadJSON(f), { ok: true }); // primes the cache
    fs.writeFileSync(f, 'GARBAGE, definitely not json and a different size');
    assert.deepEqual(loadJSON(f), {});
  });
});

// ─── Nested directory creation ──────────────────────────────────────────────

describe('nested directory creation', () => {
  it('creates missing parent directories', () => {
    const f = path.join(dir, 'x', 'y', 'z', 'deep.json');
    saveJSON(f, { deep: true });
    assert.ok(fs.existsSync(f));
    assert.deepEqual(loadJSON(f), { deep: true });
  });
});

// ─── Atomic writes ──────────────────────────────────────────────────────────

describe('atomic writes', () => {
  it('leaves no .tmp files behind', () => {
    const f = path.join(dir, 'atomic.json');
    saveJSON(f, { v: 1 });
    saveJSON(f, { v: 2 });
    saveJSON(f, { v: 3 });
    assert.deepEqual(tmpLeftovers(dir), []);
  });

  it('writes the full content with no truncation', () => {
    const f = path.join(dir, 'full.json');
    const data = { big: 'x'.repeat(50000), list: Array.from({ length: 500 }, (_, i) => i) };
    saveJSON(f, data);
    assert.deepEqual(loadJSON(f), data);
  });
});

// ─── 2-space indent format preservation ─────────────────────────────────────

describe('format preservation', () => {
  it('writes 2-space indentation identical to JSON.stringify(data, null, 2)', () => {
    const f = path.join(dir, 'fmt.json');
    const data = { a: 1, b: { c: 2 } };
    saveJSON(f, data);
    const content = fs.readFileSync(f, 'utf-8');
    assert.equal(content, JSON.stringify(data, null, 2));
    assert.ok(content.includes('\n  "a"'));   // top-level key indented 2 spaces
    assert.ok(content.includes('\n    "c"')); // nested key indented 4 spaces
  });
});

// ─── Write-through cache ────────────────────────────────────────────────────

describe('write-through cache', () => {
  it('serves the latest data after an overwrite (write-through)', () => {
    const f = path.join(dir, 'wt.json');
    saveJSON(f, { v: 1 });
    assert.deepEqual(loadJSON(f), { v: 1 }); // primes the cache
    saveJSON(f, { v: 2 });                   // write-through replaces the entry
    assert.deepEqual(loadJSON(f), { v: 2 });
  });

  it('detects an external change via mtime/size and re-reads', () => {
    const f = path.join(dir, 'ext.json');
    saveJSON(f, { v: 1 });
    assert.deepEqual(loadJSON(f), { v: 1 }); // primes the cache
    fs.writeFileSync(f, JSON.stringify({ changed: true, extra: 'padding changes the size' }));
    assert.deepEqual(loadJSON(f), { changed: true, extra: 'padding changes the size' });
  });
});

// ─── Copy isolation ─────────────────────────────────────────────────────────

describe('copy isolation', () => {
  it('mutating a loaded result does not poison the cache', () => {
    const f = path.join(dir, 'iso1.json');
    saveJSON(f, { n: 1 });
    const a = loadJSON(f);
    a.n = 999;
    a.injected = 'x';
    const b = loadJSON(f);
    assert.equal(b.n, 1);
    assert.equal(b.injected, undefined);
  });

  it('mutating the input object after save does not poison the cache', () => {
    const f = path.join(dir, 'iso2.json');
    const input = { n: 5, nested: { k: 'v' } };
    saveJSON(f, input);
    input.n = 999;
    input.nested.k = 'mutated';
    assert.deepEqual(loadJSON(f), { n: 5, nested: { k: 'v' } });
  });

  it('two loads return independent deep copies', () => {
    const f = path.join(dir, 'iso3.json');
    saveJSON(f, { arr: [1, 2] });
    const a = loadJSON(f);
    const b = loadJSON(f);
    assert.notEqual(a, b);
    assert.notEqual(a.arr, b.arr);
    a.arr.push(3);
    assert.deepEqual(b.arr, [1, 2]);
  });
});

// ─── Bounded cache ──────────────────────────────────────────────────────────

describe('bounded cache', () => {
  it('never exceeds MAX_CACHE_ENTRIES', () => {
    _clearCache();
    const n = MAX_CACHE_ENTRIES + 50;
    for (let i = 0; i < n; i++) {
      saveJSON(path.join(dir, `f${i}.json`), { i });
    }
    assert.ok(_cacheSize() > 0);
    assert.ok(_cacheSize() <= MAX_CACHE_ENTRIES);
  });
});
