import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// fuzzyMatch is authored as an ES module under src/utils (consumed by the
// Docusaurus build) and is shared by the editor's FileSearchDialog and the
// CommandPalette. Node's module-syntax detection lets this .mjs test import the
// .js source directly and read the named export, mirroring
// tests/next-fuzzymatch-score-tiers.test.mjs.
import { fuzzyMatch } from '../src/utils/fuzzyMatch.js';

// The score-tier suite pins an empty QUERY against a non-empty text; it never
// exercises an empty TEXT. These cases pin the CURRENT behavior on empty-text
// inputs so a future refactor cannot silently change it. fuzzyMatch lowercases
// both arguments; when text.includes(query) it returns score 2 for a match at
// index 0 (otherwise score 1); failing that, a subsequence scan over the text
// decides whether every query character appears in order. With an empty text
// that scan loop never runs, so a non-empty query is left unconsumed and the
// result is {match: false, score: 0}.
describe('fuzzyMatch (empty-text edges)', () => {
  it('rejects a non-empty query against empty text (the subsequence loop never runs)', () => {
    assert.deepStrictEqual(fuzzyMatch('ab', ''), { match: false, score: 0 });
  });

  it('matches an empty query against empty text as a prefix substring (score 2)', () => {
    assert.deepStrictEqual(fuzzyMatch('', ''), { match: true, score: 2 });
  });

  it('rejects a single-character query against empty text', () => {
    assert.deepStrictEqual(fuzzyMatch('a', ''), { match: false, score: 0 });
  });
});
