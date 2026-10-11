import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// fuzzyMatch is authored as an ES module under src/utils (consumed by the
// Docusaurus build) and is shared by the editor's FileSearchDialog and the
// CommandPalette. Node's module-syntax detection lets this .mjs test import the
// .js source directly and read the named export.
import { fuzzyMatch } from '../../../../../src/utils/fuzzyMatch.js';

// These cases pin the CURRENT, correct behavior of the scorer so a future
// refactor cannot silently change search ranking. Each case asserts the whole
// {match, score} result, locking in both the boolean and the score tier.
describe('fuzzyMatch (shared fuzzy search scorer)', () => {
  it('scores a prefix substring (index 0) as 2', () => {
    assert.deepEqual(fuzzyMatch('ab', 'abc'), { match: true, score: 2 });
  });

  it('scores a substring found elsewhere as 1', () => {
    assert.deepEqual(fuzzyMatch('bc', 'abc'), { match: true, score: 1 });
  });

  it('scores an in-order subsequence that is not a substring as 0', () => {
    assert.deepEqual(fuzzyMatch('ac', 'abc'), { match: true, score: 0 });
  });

  it('rejects an out-of-order query', () => {
    assert.deepEqual(fuzzyMatch('ca', 'abc'), { match: false, score: 0 });
  });

  it('rejects a query with leftover characters the text cannot satisfy', () => {
    assert.deepEqual(fuzzyMatch('abcd', 'abc'), { match: false, score: 0 });
  });

  it('is case insensitive in both directions, scoring 2 for a full match', () => {
    assert.deepEqual(fuzzyMatch('ABC', 'abc'), { match: true, score: 2 });
    assert.deepEqual(fuzzyMatch('abc', 'ABC'), { match: true, score: 2 });
  });

  it('treats an empty query as a prefix substring (score 2)', () => {
    assert.deepEqual(fuzzyMatch('', 'abc'), { match: true, score: 2 });
  });
});
