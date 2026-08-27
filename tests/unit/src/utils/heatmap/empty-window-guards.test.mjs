// Edge-branch tests for buildHeatmapWeeks in src/utils/heatmap.mjs.
//
// The sibling moon-heatmap-dedup suite already pins representative data, an
// empty `{}` map, a single day, a partial final week, and trailing padding.
// It never exercises two reliability branches:
//
//   1. The `valuesByDate || {}` input guard, reached when the caller passes a
//      null or undefined map.
//   2. The empty-window path, reached when `days` is 0: the day loop never runs
//      and no week is emitted.
//
// These cases lock in the CURRENT, correct behavior of those two branches. They
// touch no source and need no mocks: a fixed `today` plus plain object literals
// keep every assertion clock-independent and side-effect-free.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeatmapWeeks } from '../../../../../src/utils/heatmap.mjs';

// A fixed reference day so the window and day-of-week packing are deterministic.
// `getDay()` reads local time, so an absolute weekday can shift with the runner
// timezone. Every assertion below is written to be timezone-independent: it
// compares two calls that share this `today`, or it checks counts, ranges, and
// the leading-pad invariant rather than a hard-coded weekday.
const TODAY = new Date('2026-06-12T12:00:00Z');

describe('buildHeatmapWeeks input guard (null / undefined valuesByDate)', () => {
  it('treats a null valuesByDate like an empty map via the || {} guard', () => {
    assert.deepEqual(
      buildHeatmapWeeks(null, { days: 7, today: TODAY }),
      buildHeatmapWeeks({}, { days: 7, today: TODAY }),
    );
  });

  it('treats an undefined valuesByDate like an empty map', () => {
    assert.deepEqual(
      buildHeatmapWeeks(undefined, { days: 7, today: TODAY }),
      buildHeatmapWeeks({}, { days: 7, today: TODAY }),
    );
  });

  it('still builds the full window for null input with every cell count 0', () => {
    const weeks = buildHeatmapWeeks(null, { days: 7, today: TODAY });
    const cells = weeks.flat().filter((c) => c !== null);
    // The window is always `days` real cells; null only pads the grid corners.
    assert.equal(cells.length, 7);
    for (const cell of cells) assert.equal(cell.count, 0);
  });
});

describe('buildHeatmapWeeks empty window (days: 0)', () => {
  it('returns [] for a zero-length window without throwing', () => {
    assert.deepEqual(buildHeatmapWeeks({}, { days: 0, today: TODAY }), []);
  });

  it('returns [] for days 0 even when valuesByDate is null', () => {
    // The guard runs first, then the empty day loop yields no cells and no week.
    assert.deepEqual(buildHeatmapWeeks(null, { days: 0, today: TODAY }), []);
  });
});

describe('buildHeatmapWeeks cell shape and leading pad (positive path)', () => {
  it('shapes every non-null cell as {key, count, day} and leading-pads week 0', () => {
    const weeks = buildHeatmapWeeks(null, { days: 7, today: TODAY });
    const cells = weeks.flat().filter((c) => c !== null);
    for (const cell of cells) {
      // Exact shape: no extra fields beyond key, count, and day.
      assert.deepEqual(Object.keys(cell).sort(), ['count', 'day', 'key']);
      assert.match(cell.key, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(cell.count, 0);
      assert.ok(Number.isInteger(cell.day) && cell.day >= 0 && cell.day <= 6);
    }
    // weeks[0] is leading-padded: the count of leading nulls equals the
    // day-of-week of the first real cell, so that cell lands on its own row.
    const firstReal = weeks.flat().find((c) => c !== null);
    assert.equal(weeks[0].findIndex((c) => c !== null), firstReal.day);
  });
});
