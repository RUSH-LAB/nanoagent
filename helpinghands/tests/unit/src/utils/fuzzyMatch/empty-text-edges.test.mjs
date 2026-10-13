import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// fuzzyMatch is authored as an ES module under src/utils (consumed by the
// Docusaurus build) and is shared by the Workbench's quick open, the
// CommandPalette and the command bar. Node's module-syntax detection lets this
// .mjs test import the .js source directly and read the named export,
// mirroring score-tiers.test.mjs.
import { fuzzyMatch } from '../../../../../src/utils/fuzzyMatch.js';

// The score-tier suite pins an empty QUERY against a non-empty text; these
// cases pin an empty TEXT. A non-empty query has nothing to match there; an
// empty query matches everything, empty text included, with score 0.
describe('fuzzyMatch (empty-text edges)', () => {
  it('rejects a non-empty query against empty text', () => {
    assert.deepStrictEqual(fuzzyMatch('ab', ''), { match: false, score: 0, indices: [] });
    assert.deepStrictEqual(fuzzyMatch('a', ''), { match: false, score: 0, indices: [] });
  });

  it('matches an empty query against empty text with score 0', () => {
    assert.deepStrictEqual(fuzzyMatch('', ''), { match: true, score: 0, indices: [] });
  });
});
