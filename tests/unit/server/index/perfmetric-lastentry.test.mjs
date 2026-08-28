import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Pins the recordPerfMetric eviction loop hoist in server/index.js:
//   - the loop that drops the endpoint with the oldest last entry now reads
//     `arr[arr.length - 1]` a single time per iteration into `const lastEntry`;
//   - both the `if` condition and the `oldestTime` assignment reuse `lastEntry`
//     instead of re-reading the array tail.
// The hoist must be byte-for-byte behavior preserving: same victim chosen, same
// endpoint added, same handling of an empty history (lastEntry falls back to 0).
//
// recordPerfMetric is internal to server/index.js, which calls server.listen() at
// module load and exports nothing, so it cannot be require()'d from a unit test.
// Following tests/next-server-walkdir-hasallowedext.test.mjs (itself modeled on
// tests/moon-etag-json-cachecontrol.test.mjs), we lift the exact source of the
// top-level function, brace-balance its body, and instantiate it with new
// Function while injecting the module-scope values it closes over: a fresh
// perfMetrics object plus the real PERF_MAX_ENDPOINTS / PERF_MAX_ENTRIES caps
// read straight from server/index.js. This pins the function's real bytes rather than
// a reimplementation, and never boots a server (matching the rest of the suite).
//
// Each test lifts against its own fresh local perfMetrics, so there is no shared
// module state to leak between tests (the save and restore the goal calls for is
// satisfied by construction).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

// Lift a top-level `function <name>` out of server/index.js by brace balancing. The
// start is the line beginning with `function <name>`; the end is the line where
// the brace depth returns to zero. Robust to indentation and nested blocks (the
// body holds no braces inside strings or comments). Fails loud (a failed assert
// or a SyntaxError from new Function), never silently.
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

// Read a module-scope `const <name> = <integer>;` value from server/index.js so the
// caps come from the real source rather than a hard-coded copy.
function extractIntConst(src, name) {
  const m = src.match(new RegExp('^const ' + name + ' = (\\d+);', 'm'));
  assert.ok(m, `server/index.js must define a module-scope \`const ${name} = <integer>;\``);
  return Number(m[1]);
}

// Lift recordPerfMetric bound to the given perfMetrics object, returning the
// callable plus the source text and the real caps for assertions.
function liftRecordPerfMetric(perfMetrics) {
  const src = readFileSync(path.join(REPO_ROOT, 'src/server/index.js'), 'utf-8');
  const fnSrc = extractFn(src, 'recordPerfMetric');
  const PERF_MAX_ENDPOINTS = extractIntConst(src, 'PERF_MAX_ENDPOINTS');
  const PERF_MAX_ENTRIES = extractIntConst(src, 'PERF_MAX_ENTRIES');
  const make = new Function(
    'perfMetrics', 'PERF_MAX_ENDPOINTS', 'PERF_MAX_ENTRIES',
    `${fnSrc}\nreturn recordPerfMetric;`,
  );
  return {
    fnSrc,
    PERF_MAX_ENDPOINTS,
    PERF_MAX_ENTRIES,
    recordPerfMetric: make(perfMetrics, PERF_MAX_ENDPOINTS, PERF_MAX_ENTRIES),
  };
}

describe('server/index.js recordPerfMetric eviction reads the last entry once (source shape)', () => {
  const { fnSrc } = liftRecordPerfMetric({});

  it('computes lastEntry once per iteration from arr[arr.length - 1]', () => {
    assert.ok(
      fnSrc.includes('const lastEntry = arr.length > 0 ? arr[arr.length - 1] : 0;'),
      'the eviction loop must hoist the last entry into a single `const lastEntry`',
    );
  });

  it('routes the if condition and the oldestTime assignment through lastEntry', () => {
    assert.ok(
      fnSrc.includes('if (arr.length === 0 || lastEntry < oldestTime) {'),
      'the if condition must compare lastEntry, not a fresh arr[arr.length - 1] read',
    );
    assert.ok(
      fnSrc.includes('oldestTime = lastEntry;'),
      'oldestTime must be assigned from lastEntry',
    );
  });

  it('leaves no redundant arr[arr.length - 1] read inside the eviction loop', () => {
    assert.ok(
      !fnSrc.includes('arr[arr.length - 1] < oldestTime'),
      'the old inline read in the if condition must be gone',
    );
    assert.ok(
      !fnSrc.includes('oldestTime = arr.length > 0 ? arr[arr.length - 1] : 0'),
      'the old inline read in the oldestTime assignment must be gone',
    );
  });
});

describe('server/index.js recordPerfMetric eviction behavior', () => {
  it('evicts the strict-oldest endpoint and adds the new one at the cap', () => {
    const perfMetrics = {};
    const { recordPerfMetric, PERF_MAX_ENDPOINTS } = liftRecordPerfMetric(perfMetrics);

    // Fill to exactly the cap. Every endpoint carries a non-empty history, so the
    // `arr.length === 0` branch never fires; the victim alone holds the strict
    // minimum last entry (1) while every other last entry is >= 100, making the
    // victim the unique oldest the eviction loop must drop.
    const VICTIM = 'GET /api/victim';
    for (let i = 0; i < PERF_MAX_ENDPOINTS - 1; i++) {
      perfMetrics[`GET /api/e${i}`] = [100 + i];
    }
    perfMetrics[VICTIM] = [1];
    assert.equal(
      Object.keys(perfMetrics).length,
      PERF_MAX_ENDPOINTS,
      'precondition: perfMetrics sits exactly at the endpoint cap',
    );

    recordPerfMetric('NEW /api/x', 5);

    assert.ok(!(VICTIM in perfMetrics), 'the strict-oldest endpoint is evicted');
    assert.deepEqual(perfMetrics['NEW /api/x'], [5], 'the new endpoint is added with its sample');
    assert.equal(
      Object.keys(perfMetrics).length,
      PERF_MAX_ENDPOINTS,
      'one evicted and one added keeps the endpoint count at the cap',
    );
    assert.ok('GET /api/e0' in perfMetrics, 'a non-oldest endpoint survives the eviction');
  });

  it('adds without evicting when below the endpoint cap', () => {
    const perfMetrics = {};
    const { recordPerfMetric } = liftRecordPerfMetric(perfMetrics);

    perfMetrics['GET /api/a'] = [1];
    perfMetrics['GET /api/b'] = [2];

    recordPerfMetric('GET /api/c', 9);

    assert.deepEqual(
      Object.keys(perfMetrics).sort(),
      ['GET /api/a', 'GET /api/b', 'GET /api/c'],
      'no endpoint is dropped while below the cap',
    );
    assert.deepEqual(perfMetrics['GET /api/c'], [9], 'the new endpoint records its sample');
  });
});
