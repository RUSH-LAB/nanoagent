import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// formatTime is authored as an ES module under src/utils (consumed by the
// Docusaurus build); Node's module-syntax detection lets this .mjs test import
// the .js source directly and read the named export. We import the REAL
// formatTime instead of reimplementing it, so every case below pins its actual
// current behavior. The sibling tests/next-format-time-relative.test.mjs covers
// the relative paths; this file covers the withTime date fallback they skip.
import { formatTime } from '../../../../../src/utils/time.js';

// formatTime measures the gap with `Math.floor((new Date() - new Date(iso)) /
// 60000)` against the live clock, so the input is built relative to `Date.now()`.
// 400 days is far past the default 30-day cutoff, so every case below lands in
// the localized date fallback no matter when the suite runs.
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ISO-8601 timestamp for a moment `ms` milliseconds before now.
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// One fixed instant, reused across cases so the with-time and without-time
// outputs describe the SAME moment. Its formatted value depends only on this
// instant (not on the live clock), so the assertions stay deterministic.
const old = ago(400 * DAY);

// The fallback time component is locale and timezone dependent, so we never
// assert an exact string; we check for a colon-separated hour:minute pair.
// That ASCII colon and digit shape is the default en-US form the suite runs
// under (the locale Node resolves to when LANG and LC_* are unset). The withTime
// branch is what produces the pair, so this still fails loudly if it regresses.
const TIME = /\d{1,2}:\d{2}/;

describe('formatTime (withTime date fallback)', () => {
  it('appends an hour:minute component to the date fallback when withTime is true', () => {
    const result = formatTime(old, {withTime: true});
    assert.ok(!result.endsWith(' ago'), `expected a date fallback, got "${result}"`);
    assert.match(result, TIME, `expected an hour:minute component, got "${result}"`);
  });

  it('omits the time component for the same instant when withTime defaults to false', () => {
    const result = formatTime(old);
    assert.ok(!result.endsWith(' ago'), `expected a date fallback, got "${result}"`);
    assert.doesNotMatch(result, TIME, `expected no time component, got "${result}"`);
  });

  it('keeps the time component for the recentDays-7 withTime pair used by ChannelView', () => {
    // Mirrors the real call site:
    // formatTime(msg.createdAt, {recentDays: 7, withTime: true}).
    const result = formatTime(old, {recentDays: 7, withTime: true});
    assert.ok(!result.endsWith(' ago'), `expected a date fallback, got "${result}"`);
    assert.match(result, TIME, `expected an hour:minute component, got "${result}"`);
  });
});
