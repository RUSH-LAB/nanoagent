import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// fuzzyMatch is authored as an ES module under src/utils (consumed by the
// Docusaurus build) and is shared by the Workbench's quick open, the
// CommandPalette and the command bar. Node's module-syntax detection lets this
// .mjs test import the .js source directly and read the named export.
import { fuzzyMatch } from '../../../../../src/utils/fuzzyMatch.js';

const score = (query, text) => fuzzyMatch(query, text).score;

// These cases pin the ranking the scorer promises, so a future refactor cannot
// silently change search order, and the indices <Highlight> marks.
describe('fuzzyMatch (shared fuzzy search scorer)', () => {
  it('ranks a prefix over a substring over a scattered subsequence', () => {
    assert.ok(score('ab', 'abc') > score('bc', 'abc'));
    assert.ok(score('bc', 'abc') > score('ac', 'abc'));
  });

  it('marks the characters it matched', () => {
    assert.deepEqual(fuzzyMatch('ac', 'abc'), { match: true, score: fuzzyMatch('ac', 'abc').score, indices: [0, 2] });
    assert.deepEqual(fuzzyMatch('bc', 'abc').indices, [1, 2]);
  });

  it('rejects an out-of-order query, or one with characters left over', () => {
    assert.deepEqual(fuzzyMatch('ca', 'abc'), { match: false, score: 0, indices: [] });
    assert.deepEqual(fuzzyMatch('abcd', 'abc'), { match: false, score: 0, indices: [] });
  });

  it('is case insensitive in both directions', () => {
    assert.deepEqual(fuzzyMatch('ABC', 'abc').indices, [0, 1, 2]);
    assert.deepEqual(fuzzyMatch('abc', 'ABC').indices, [0, 1, 2]);
    assert.equal(score('ABC', 'abc'), score('abc', 'abc'));
  });

  it('matches everything for an empty query, with score 0', () => {
    assert.deepEqual(fuzzyMatch('', 'abc'), { match: true, score: 0, indices: [] });
  });

  it('prefers characters after / - _ . and spaces', () => {
    assert.deepEqual(fuzzyMatch('ms', 'src/my_scorer.js').indices, [4, 7]);
    assert.ok(score('fm', 'src/fuzzy-match.js') > score('fm', 'src/fumble.js'));
    assert.deepEqual(fuzzyMatch('ab', 'xa.b').indices, [1, 3]);
    assert.ok(score('rm', 'read me') > score('rm', 'rummy'));
  });

  it('prefers camelCase word starts', () => {
    assert.deepEqual(fuzzyMatch('qo', 'aquaQuickOpen').indices, [4, 9]);
    assert.ok(score('qo', 'QuickOpen.js') > score('qo', 'quoted.js'));
  });

  it('prefers a consecutive run over the same letters spread out', () => {
    assert.deepEqual(fuzzyMatch('tree', 'test/re/tree.js').indices, [8, 9, 10, 11]);
  });

  it('keeps the earliest placement when two score the same', () => {
    assert.deepEqual(fuzzyMatch('a', 'xaxa').indices, [1]);
    assert.deepEqual(fuzzyMatch('ab', 'ab/ab').indices, [0, 1]);
  });
});
