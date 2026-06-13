import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// formatTime is authored as an ES module under src/utils (consumed by the
// Docusaurus build); Node's module-syntax detection lets this .mjs test import
// the .js source directly and read the named export. We import the REAL
// formatTime instead of reimplementing it, so every case below pins its actual
// current behavior.
import { formatTime } from '../src/utils/time.js';

// formatTime measures the gap with `Math.floor((new Date() - new Date(iso)) /
// 60000)` against the live clock, so each input is built relative to
// `Date.now()` at call time. That keeps the test deterministic whenever it runs.
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A few seconds of margin past each boundary keeps Math.floor on the intended
// integer no matter how many milliseconds elapse between building the input and
// formatTime reading the clock, so the boundary cases never flake.
const MARGIN = 5 * SECOND;

// ISO-8601 timestamp for a moment `ms` milliseconds before now.
const ago = (ms) => new Date(Date.now() - ms).toISOString();

describe('formatTime (shared relative-time formatter)', () => {
  it('returns "just now" for a gap under one minute', () => {
    assert.equal(formatTime(ago(30 * SECOND)), 'just now');
  });

  it('returns "just now" for a future timestamp', () => {
    // A future instant makes the diff negative, which is still below one minute.
    assert.equal(formatTime(new Date(Date.now() + HOUR).toISOString()), 'just now');
  });

  it('returns "Nm ago" for one to fifty-nine minutes', () => {
    assert.equal(formatTime(ago(5 * MINUTE + MARGIN)), '5m ago');
  });

  it('returns "1h ago" at exactly sixty minutes', () => {
    assert.equal(formatTime(ago(60 * MINUTE + MARGIN)), '1h ago');
  });

  it('returns "Nh ago" for one to twenty-three hours', () => {
    assert.equal(formatTime(ago(2 * HOUR + MARGIN)), '2h ago');
  });

  it('returns "1d ago" at exactly twenty-four hours', () => {
    assert.equal(formatTime(ago(24 * HOUR + MARGIN)), '1d ago');
  });

  it('returns "Nd ago" for one day up to the recentDays cutoff', () => {
    assert.equal(formatTime(ago(3 * DAY + MARGIN)), '3d ago');
  });

  it('falls back to a non-relative localized date at or beyond recentDays', () => {
    const result = formatTime(ago(31 * DAY));
    assert.ok(!result.endsWith(' ago'), `expected a date fallback, got "${result}"`);
    assert.notEqual(result, 'just now');
  });

  it('moves the date cutoff when a smaller recentDays is passed', () => {
    const fiveDaysAgo = ago(5 * DAY + MARGIN);
    // With the default 30-day cutoff the same instant is still relative.
    assert.equal(formatTime(fiveDaysAgo), '5d ago');
    // Lowering recentDays below the gap pushes it into the date fallback.
    const lowered = formatTime(fiveDaysAgo, {recentDays: 3});
    assert.ok(!lowered.endsWith(' ago'), `expected a date fallback, got "${lowered}"`);
    assert.notEqual(lowered, 'just now');
  });
});
