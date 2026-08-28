import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// server-utils.js is CommonJS; load the REAL module the way the other server
// tests do (see tests/feeds-guard.test.mjs, which exercises numericParam too).
const require = createRequire(import.meta.url);
const { numericParam } = require('../../../../src/server/server-utils.js');

// numericParam(raw, def, max) computes
//   Math.min(Number.isNaN(parseInt(raw, 10)) ? def : parsed, max).
// It bounds only the upper end: it clamps to `max` and falls back to `def` when
// `raw` is absent or non-numeric, but it never floors at zero. Callers that need
// a lower bound wrap the result in Math.max(x, 0) themselves, so a negative
// numeric input is expected to pass straight through here. The function is pure
// (no I/O, clock, or randomness), so every edge below is pinned with exact
// strict equality.
//
// These cases cover edges the existing feeds-guard suite does not: the negative
// pass-through, the default being clamped by max on both fallback paths, and the
// parseInt truncation of a float-like string. They characterize the current,
// intended contract and are not bug reports.
describe('numericParam clamp and fallback edges (server/server-utils.js)', () => {
  it('exports numericParam as a pure function from the real module', () => {
    assert.equal(typeof numericParam, 'function');
  });

  it('passes a negative numeric string through unclamped (no lower-bound floor)', () => {
    // parseInt('-5', 10) is -5, which sits below max, so Math.min returns it as is.
    assert.equal(numericParam('-5', 20, 100), -5);
  });

  it('clamps the default itself by max when raw is absent (null)', () => {
    // parseInt(null, 10) is NaN, so def (500) is used, then capped at max (100).
    assert.equal(numericParam(null, 500, 100), 100);
  });

  it('clamps the default itself by max when raw is non-numeric', () => {
    // parseInt('abc', 10) is NaN, so def (500) is used, then capped at max (100).
    assert.equal(numericParam('abc', 500, 100), 100);
  });

  it('truncates a float-like string toward zero via parseInt', () => {
    // parseInt('3.9', 10) stops at the dot and yields 3, which sits below max.
    assert.equal(numericParam('3.9', 20, 100), 3);
  });
});
