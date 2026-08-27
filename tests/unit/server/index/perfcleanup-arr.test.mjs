import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Pins the perfMetrics cap inside the 60s periodic-cleanup interval in server/index.js:
//   - the cleanup `.map` over perfKeys now binds `perfMetrics[k]` once into
//     `const arr` and reuses it, instead of re-reading the subscript three times
//     (and `.length` twice) to compute each endpoint's `last` sample.
// The dedupe is byte-for-byte behavior preserving: `sorted` carries the same
// `{k, last}` entries, ascending by `last`, so the same lowest-`last` endpoints
// are chosen for deletion. An empty history still maps to a `last` of 0.
//
// This test pins BEHAVIOR, not syntax: it extracts the live cleanup snippet from
// server/index.js and runs it over a fixture, asserting the resulting order and the
// deletions it drives. It therefore passes against BOTH the deduped form and a
// revert to the old inline reads, exactly as the goal requires ("a revert of the
// change must still produce the identical sorted"). The syntax gate lives in
// verify.sh; here we only prove the array tail is read correctly. (Contrast with
// tests/next-perfmetric-lastentry.test.mjs, whose goal additionally pinned a
// specific source shape; ours deliberately does not.)
//
// The cleanup logic lives in an anonymous setInterval callback, and server/index.js
// calls server.listen() at module load while exporting nothing, so it cannot be
// require()'d. Following tests/next-perfmetric-lastentry.test.mjs (itself modeled
// on tests/moon-etag-json-cachecontrol.test.mjs), we lift the exact source of the
// smallest self-contained snippet, balance its delimiters, and instantiate it
// with new Function over a constructed perfMetrics fixture. This pins the real
// bytes rather than a reimplementation, and never boots a server. None of the
// lifted snippets hold braces/parens inside strings or comments, so plain
// delimiter counting is exact.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

const readServer = () => readFileSync(path.join(REPO_ROOT, 'server/index.js'), 'utf-8');

// Lift the `const sorted = perfKeys ... .sort(...);` statement out of server/index.js.
// The start is the line beginning `const sorted = perfKeys`; the end is the first
// `;` reached at combined ()/[]/{} depth 0, i.e. the terminator of the whole
// `.map(...).sort(...)` chain. Robust to the map callback being an expression
// body (old) or a block body (new): the inner `;` of the block sit at depth > 0.
function extractSortedStatement(src) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => /^\s*const sorted = perfKeys\b/.test(l));
  assert.ok(start !== -1, 'server/index.js must declare `const sorted = perfKeys` in the perfMetrics cleanup');
  let depth = 0;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ';' && depth === 0) return out.join('\n');
    }
  }
  assert.fail('could not find the end of the `const sorted = perfKeys ...` statement in server/index.js');
}

// Lift the whole cap block: the `const perfKeys = Object.keys(perfMetrics);`
// declaration plus the `if (perfKeys.length > PERF_MAX_ENDPOINTS) { ... }` that
// sorts and deletes. Brace-balanced from the `if` line so the block body shape
// does not matter.
function extractCapBlock(src) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => /^\s*const perfKeys = Object\.keys\(perfMetrics\);/.test(l));
  assert.ok(start !== -1, 'server/index.js must declare `const perfKeys = Object.keys(perfMetrics);`');
  const ifLine = start + 1;
  assert.ok(
    /^\s*if \(perfKeys\.length > PERF_MAX_ENDPOINTS\) \{/.test(lines[ifLine]),
    'the perfKeys declaration must be immediately followed by the cap `if`',
  );
  let depth = 0, opened = false, end = -1;
  for (let i = ifLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') depth--;
    }
    if (opened && depth === 0) { end = i; break; }
  }
  assert.ok(end !== -1, 'could not find the end of the perfMetrics cap `if` block');
  return lines.slice(start, end + 1).join('\n');
}

// Run the lifted `sorted` statement over a perfMetrics fixture, returning the
// computed `sorted` array. perfKeys is derived inside the wrapper exactly as the
// cleanup does (Object.keys(perfMetrics)).
function liftSorted(perfMetrics) {
  const stmt = extractSortedStatement(readServer());
  const make = new Function(
    'perfMetrics',
    `const perfKeys = Object.keys(perfMetrics);\n${stmt}\nreturn sorted;`,
  );
  return make(perfMetrics);
}

// Run the lifted cap block over a fixture with an injected PERF_MAX_ENDPOINTS so
// a tiny cap can be exercised. Mutates perfMetrics in place (deletes victims).
function runCap(perfMetrics, cap) {
  const block = extractCapBlock(readServer());
  const run = new Function('perfMetrics', 'PERF_MAX_ENDPOINTS', block);
  run(perfMetrics, cap);
}

// A fixture where, for every non-empty endpoint, the last array entry differs
// from that array's first / min / max element. So a misread of the tail (reading
// the head, the min, or the max instead) would change `last` and break the
// assertions, proving the snippet reads arr[arr.length - 1] specifically.
const makeFixture = () => ({
  'GET /api/a': [5, 40, 30],  // first 5, min 5, max 40, last 30
  'GET /api/b': [9, 1, 6],    // first 9, min 1, max 9,  last 6
  'GET /api/c': [100, 3, 7],  // first 100, min 3, max 100, last 7
  'GET /api/d': [],           // empty history -> last 0
  'GET /api/e': [1, 99, 2],   // first 1, min 1, max 99, last 2
});

describe('server/index.js perfMetrics cleanup orders endpoints ascending by last sample', () => {
  it('sorts by the array tail, empty histories counting as 0', () => {
    const sorted = liftSorted(makeFixture());
    assert.deepEqual(
      sorted.map(x => x.k),
      ['GET /api/d', 'GET /api/e', 'GET /api/b', 'GET /api/c', 'GET /api/a'],
      'endpoints come out ascending by their last sample (0, 2, 6, 7, 30)',
    );
    assert.deepEqual(
      sorted.map(x => x.last),
      [0, 2, 6, 7, 30],
      'last is read from arr[arr.length - 1], with [] mapping to 0',
    );
  });

  it('is order-stable across the same input shape', () => {
    // Two independent lifts over equivalent fixtures agree, guarding against any
    // hidden dependence on shared module state.
    const a = liftSorted(makeFixture()).map(x => x.last);
    const b = liftSorted(makeFixture()).map(x => x.last);
    assert.deepEqual(a, b);
  });
});

describe('server/index.js perfMetrics cleanup deletes the lowest-last endpoints', () => {
  it('drops the count above the cap, victims chosen lowest-last first', () => {
    const perfMetrics = makeFixture();
    runCap(perfMetrics, 3); // 5 endpoints, cap 3 -> delete the 2 lowest-last (d=0, e=2)
    assert.deepEqual(
      Object.keys(perfMetrics).sort(),
      ['GET /api/a', 'GET /api/b', 'GET /api/c'],
      'the two lowest-last endpoints (d, e) are evicted; the higher-last survive',
    );
  });

  it('deletes nothing when at or below the cap', () => {
    const perfMetrics = { 'GET /api/a': [3], 'GET /api/b': [1] };
    runCap(perfMetrics, 5);
    assert.deepEqual(
      Object.keys(perfMetrics).sort(),
      ['GET /api/a', 'GET /api/b'],
      'with the endpoint count under the cap no eviction runs',
    );
  });
});
