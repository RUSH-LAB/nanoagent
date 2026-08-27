// Proves that swapping deepCopy's serialize-and-reparse round-trip for the
// native structuredClone preserves loadJSON/saveJSON behaviour exactly.
//
// WHY THIS IS BEHAVIOUR-PRESERVING: the value handed to deepCopy is ALWAYS the
// cached `data`, which is itself ALWAYS the output of a JSON parse. On a read
// miss it is the parse of the file bytes; on the write-through path it is the
// reparse of the freshly serialized value. JSON-parse output contains only JSON
// types (null, booleans, finite numbers, strings, arrays, and plain objects):
// never `undefined` property values, NaN/Infinity, Date/Map/Set, functions,
// symbols, or BigInt. For such values structuredClone produces a deep copy that
// is deep-equal to, and structurally identical to, the old round-trip, so every
// loadJSON caller still receives a byte-identical, independently-mutable copy.
// structuredClone is a Node global since v17 (this runtime is v24), so there is
// no import and no new dependency.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { loadJSON, saveJSON, deepCopy, _clearCache } = require('../../../../server/data-store.js');

let dir;

beforeEach(() => {
  _clearCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sclone-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── 1. Deep-copy isolation ──────────────────────────────────────────────────
// Mutating a returned value (top level, nested object, nested array) must not
// affect a subsequently-loaded copy nor the cached entry.

describe('deep-copy isolation', () => {
  it('mutating a returned nested object does not leak into later loads or the cache', () => {
    const f = path.join(dir, 'iso-obj.json');
    saveJSON(f, { top: 1, nested: { k: 'v', deeper: { n: 1 } } });

    const a = loadJSON(f); // served from the write-through cache
    a.top = 999;
    a.nested.k = 'mutated';
    a.nested.deeper.n = 999;
    a.injected = 'x';

    const b = loadJSON(f); // a fresh isolated copy of the same cached entry
    assert.deepEqual(b, { top: 1, nested: { k: 'v', deeper: { n: 1 } } });
    assert.equal(b.injected, undefined);
  });

  it('mutating a returned nested array does not leak into later loads or the cache', () => {
    const f = path.join(dir, 'iso-arr.json');
    saveJSON(f, { list: [1, 2, [3, 4]] });

    const a = loadJSON(f);
    a.list.push(99);
    a.list[2].push(99);

    const b = loadJSON(f);
    assert.deepEqual(b, { list: [1, 2, [3, 4]] });
  });
});

// ─── 2. Independent references ────────────────────────────────────────────────
// Two successive loads of the same unchanged file (both cache hits) must be
// distinct objects at the top level AND for every nested object/array.

describe('independent references', () => {
  it('two loads are not === at the top level nor for nested objects/arrays', () => {
    const f = path.join(dir, 'refs.json');
    saveJSON(f, { obj: { k: 'v' }, arr: [1, 2, 3] });

    const a = loadJSON(f);
    const b = loadJSON(f);

    assert.notEqual(a, b); // distinct top-level objects
    assert.notEqual(a.obj, b.obj); // distinct nested object
    assert.notEqual(a.arr, b.arr); // distinct nested array
    assert.deepEqual(a, b); // ...yet structurally equal
  });
});

// ─── 3. Round-trip fidelity ──────────────────────────────────────────────────
// A representative store deep-equals the original after load, both from the
// write-through cache and from a fresh disk read.

describe('round-trip fidelity', () => {
  it('preserves nested objects, arrays, unicode, numbers, booleans, and null', () => {
    const f = path.join(dir, 'fidelity.json');
    const data = {
      title: '日本語のタイトル',
      count: 42,
      ratio: 3.14159,
      enabled: true,
      disabled: false,
      missing: null,
      tags: ['α', 'β', '日本語'],
      nested: {
        items: [{ id: 1, name: 'one' }, { id: 2, name: '二' }],
        meta: { ok: true, empty: null },
      },
    };

    saveJSON(f, data);
    assert.deepEqual(loadJSON(f), data); // from the write-through cache

    _clearCache();
    assert.deepEqual(loadJSON(f), data); // from a fresh disk read + parse
  });
});

// ─── 4. The `undefined` guard ────────────────────────────────────────────────
// The guard is unreachable through loadJSON/saveJSON (their data is always
// JSON-shaped), so exercise deepCopy directly: an `undefined` input must yield
// `undefined`, not a throw.

describe('undefined guard', () => {
  it('deepCopy(undefined) returns undefined rather than throwing', () => {
    assert.equal(deepCopy(undefined), undefined);
  });

  it('deepCopy of a JSON-shaped value is an isolated deep-equal copy', () => {
    const original = { a: [1, { b: 2 }], c: null, d: '日本語' };
    const copy = deepCopy(original);

    assert.deepEqual(copy, original);
    assert.notEqual(copy, original); // distinct top level
    assert.notEqual(copy.a, original.a); // distinct nested array

    copy.a[1].b = 999;
    assert.equal(original.a[1].b, 2); // mutation stays isolated
  });
});
