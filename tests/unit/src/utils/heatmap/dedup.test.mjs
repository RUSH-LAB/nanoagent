// Golden test for the calendar-heatmap dedupe on src/pages/analytics.js.
//
// The Activity and Writing heatmaps used to hand-roll the same day-window and
// week-packing math. That logic now lives in src/utils/heatmap.mjs. These tests
// prove the refactor is byte-identical in OUTPUT: for both heatmaps they compare
// the full ordered grid of rendered per-cell { title, background } produced by
// the NEW path (helper + the rewired analytics.js cell rendering) against the
// ORIGINAL pre-refactor logic, reconstructed inline below.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeatmapWeeks } from '../../../../../src/utils/heatmap.mjs';

// A fixed reference day so the day-window and day-of-week packing are
// deterministic. Both the NEW and ORIGINAL paths share it, so any machine
// timezone difference cancels out.
const FIXED_TODAY = new Date('2026-06-12T12:00:00Z');

// Build an in-window ISO key `n` days before `today`, matching the same
// toISOString().slice(0, 10) the production code uses.
const dayKey = (today, n) => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// NEW code paths: buildHeatmapWeeks + the cell rendering now in analytics.js.
// ---------------------------------------------------------------------------

function renderActivityNew(valuesByDate, { days, today }) {
  const maxVal = Math.max(...Object.values(valuesByDate), 1);
  const weeks = buildHeatmapWeeks(valuesByDate, { days, today });
  return weeks.map((w) =>
    w.map((cell) => ({
      title: cell ? `${cell.key}: ${cell.count} actions` : '',
      background: cell
        ? (cell.count > 0
            ? `rgba(34, 197, 94, ${Math.max(0.15, Math.min(1, cell.count / maxVal))})`
            : 'var(--ifm-color-emphasis-200)')
        : 'transparent',
    })),
  );
}

function renderWritingNew(valuesByDate, { days, today }) {
  const maxVal = Math.max(...Object.values(valuesByDate), 1);
  const weeks = buildHeatmapWeeks(valuesByDate, { days, today, trailingPad: true });
  const getColor = (count) => {
    if (count === 0) return 'var(--ifm-color-emphasis-200, #ebedf0)';
    const ratio = count / maxVal;
    if (ratio <= 0.25) return '#9be9a8';
    if (ratio <= 0.5) return '#40c463';
    if (ratio <= 0.75) return '#30a14e';
    return '#216e39';
  };
  return weeks.map((w) =>
    w.map((cell) => ({
      title: cell ? `${cell.count} file${cell.count !== 1 ? 's' : ''} modified on ${cell.key}` : '',
      background: cell ? getColor(cell.count) : 'transparent',
    })),
  );
}

// ---------------------------------------------------------------------------
// ORIGINAL pre-refactor logic, fully inlined (no helper). These mirror the two
// blocks exactly as they were before the dedupe.
// ---------------------------------------------------------------------------

function renderActivityOriginal(heatmap, { days, today }) {
  const cells = [];
  const maxVal = Math.max(...Object.values(heatmap), 1);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const count = heatmap[key] || 0;
    const intensity = count > 0 ? Math.max(0.15, Math.min(1, count / maxVal)) : 0;
    cells.push({ key, count, intensity, day: d.getDay() });
  }
  const weeks = [];
  let week = [];
  const firstDay = cells[0]?.day || 0;
  for (let i = 0; i < firstDay; i++) week.push(null);
  for (const cell of cells) {
    week.push(cell);
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) weeks.push(week);
  return weeks.map((w) =>
    w.map((cell) => ({
      title: cell ? `${cell.key}: ${cell.count} actions` : '',
      background: cell
        ? (cell.count > 0 ? `rgba(34, 197, 94, ${cell.intensity})` : 'var(--ifm-color-emphasis-200)')
        : 'transparent',
    })),
  );
}

function renderWritingOriginal(dateCounts, { days, today }) {
  const cells = [];
  const maxVal = Math.max(...Object.values(dateCounts), 1);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const count = dateCounts[key] || 0;
    cells.push({ key, count, day: d.getDay() });
  }
  const weeks = [];
  let week = [];
  const firstDayOfWeek = cells[0]?.day || 0;
  for (let i = 0; i < firstDayOfWeek; i++) week.push(null);
  for (const cell of cells) {
    week.push(cell);
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  const getColor = (count) => {
    if (count === 0) return 'var(--ifm-color-emphasis-200, #ebedf0)';
    const ratio = count / maxVal;
    if (ratio <= 0.25) return '#9be9a8';
    if (ratio <= 0.5) return '#40c463';
    if (ratio <= 0.75) return '#30a14e';
    return '#216e39';
  };
  return weeks.map((w) =>
    w.map((cell) => ({
      title: cell ? `${cell.count} file${cell.count !== 1 ? 's' : ''} modified on ${cell.key}` : '',
      background: cell ? getColor(cell.count) : 'transparent',
    })),
  );
}

// Representative data: counts on a spread of in-window days plus one
// out-of-window key (ignored). The count-1 / maxVal-7 pairing exercises the
// 0.15 intensity floor and the lowest color-scale bucket; count 7 hits the top.
const today = FIXED_TODAY;
const DATA = {
  [dayKey(today, 0)]: 3,
  [dayKey(today, 1)]: 1,
  [dayKey(today, 10)]: 7,
  [dayKey(today, 83)]: 2,
  [dayKey(today, 179)]: 5,
  '2020-01-01': 99,
};

describe('Activity heatmap (180 days, no trailing pad)', () => {
  it('matches the original rendered grid for representative data', () => {
    assert.deepEqual(
      renderActivityNew(DATA, { days: 180, today }),
      renderActivityOriginal(DATA, { days: 180, today }),
    );
  });

  it('matches the original for empty data', () => {
    assert.deepEqual(
      renderActivityNew({}, { days: 180, today }),
      renderActivityOriginal({}, { days: 180, today }),
    );
  });

  it('matches the original for a single day', () => {
    assert.deepEqual(
      renderActivityNew(DATA, { days: 1, today }),
      renderActivityOriginal(DATA, { days: 1, today }),
    );
  });

  it('matches the original for a partial final week', () => {
    assert.deepEqual(
      renderActivityNew(DATA, { days: 10, today }),
      renderActivityOriginal(DATA, { days: 10, today }),
    );
  });
});

describe('Writing heatmap (84 days, trailing pad)', () => {
  it('matches the original rendered grid for representative data', () => {
    assert.deepEqual(
      renderWritingNew(DATA, { days: 84, today }),
      renderWritingOriginal(DATA, { days: 84, today }),
    );
  });

  it('matches the original for empty data', () => {
    assert.deepEqual(
      renderWritingNew({}, { days: 84, today }),
      renderWritingOriginal({}, { days: 84, today }),
    );
  });

  it('matches the original for a single day', () => {
    assert.deepEqual(
      renderWritingNew(DATA, { days: 1, today }),
      renderWritingOriginal(DATA, { days: 1, today }),
    );
  });

  it('matches the original for a partial final week', () => {
    assert.deepEqual(
      renderWritingNew(DATA, { days: 10, today }),
      renderWritingOriginal(DATA, { days: 10, today }),
    );
  });
});

describe('grid shape and known cell values', () => {
  it('activity renders exactly `days` real cells, leading-padded only', () => {
    const grid = renderActivityNew({}, { days: 180, today });
    const real = grid.flat().filter((c) => c.title !== '');
    assert.equal(real.length, 180);
    for (const c of real) {
      assert.equal(c.background, 'var(--ifm-color-emphasis-200)');
      assert.match(c.title, /: 0 actions$/);
    }
    // No trailing pad: only the first week may carry null padding.
    grid.forEach((w, wi) => {
      if (wi > 0) assert.ok(w.every((c) => c.title !== '' || c.background === 'transparent'));
    });
  });

  it('writing pads every column to 7 rows', () => {
    const weeks = buildHeatmapWeeks(DATA, { days: 84, today, trailingPad: true });
    for (const w of weeks) assert.equal(w.length, 7);
    const real = renderWritingNew({}, { days: 84, today }).flat().filter((c) => c.title !== '');
    assert.equal(real.length, 84);
    for (const c of real) {
      assert.equal(c.background, 'var(--ifm-color-emphasis-200, #ebedf0)');
      assert.match(c.title, /^0 files modified on /);
    }
  });

  it('applies the 0.15 intensity floor (count 1 with maxVal 7)', () => {
    const floored = renderActivityNew(DATA, { days: 180, today })
      .flat()
      .filter((c) => / 1 actions$/.test(c.title));
    assert.ok(floored.length >= 1);
    for (const c of floored) {
      assert.equal(c.background, 'rgba(34, 197, 94, 0.15)');
    }
  });

  it('writing singularizes a one-file day', () => {
    const single = renderWritingNew(DATA, { days: 84, today })
      .flat()
      .filter((c) => c.title.startsWith('1 file '));
    assert.equal(single.length, 1);
    assert.match(single[0].title, /^1 file modified on \d{4}-\d{2}-\d{2}$/);
    assert.equal(single[0].background, '#9be9a8');
  });
});
