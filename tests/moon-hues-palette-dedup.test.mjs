import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// CHART_HUES is authored as an ES module under src/utils (consumed by the
// Docusaurus build); Node's module-syntax detection lets this .mjs test import
// the .js source directly and read the named export.
import { CHART_HUES } from '../src/utils/chartColors.js';

// The canonical palette, spelled out independently of the source so this test
// pins the exact ten hues (values and order) the stats and analytics charts
// relied on before they were consolidated onto the shared constant.
const ORIGINAL_HUES = [210, 340, 150, 30, 270, 180, 0, 60, 300, 120];

describe('CHART_HUES (shared dashboard chart hue palette)', () => {
  it('deep equals the original ten hue palette', () => {
    assert.deepEqual(CHART_HUES, ORIGINAL_HUES);
  });

  it('renders the byte-identical hsl(...) colors the charts relied on', () => {
    // Independently pin the exact rendered color strings (the charts build them
    // as `hsl(${hue}, 60%, 50%)`), so a reordered or altered hue is caught here
    // and not only by the deep-equal above.
    const expected = [
      'hsl(210, 60%, 50%)', 'hsl(340, 60%, 50%)', 'hsl(150, 60%, 50%)',
      'hsl(30, 60%, 50%)', 'hsl(270, 60%, 50%)', 'hsl(180, 60%, 50%)',
      'hsl(0, 60%, 50%)', 'hsl(60, 60%, 50%)', 'hsl(300, 60%, 50%)',
      'hsl(120, 60%, 50%)',
    ];
    assert.deepEqual(CHART_HUES.map((h) => `hsl(${h}, 60%, 50%)`), expected);
  });

  it('stays distinct from the divergent analytics pie palette', () => {
    // analytics.js keeps a separate pieHues palette that swaps indices 5 and 7;
    // the shared constant must never silently adopt those values.
    const pieHues = [210, 340, 150, 30, 270, 60, 0, 180, 300, 120];
    assert.notDeepEqual(CHART_HUES, pieHues);
    assert.equal(CHART_HUES[5], 180);
    assert.equal(CHART_HUES[7], 60);
  });
});
