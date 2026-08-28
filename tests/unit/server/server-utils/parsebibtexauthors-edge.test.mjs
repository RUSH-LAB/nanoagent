import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

// Add-only characterization test. It loads the REAL server/server-utils.js via
// createRequire and pins the currently-uncovered edge branches of the pure
// function parseBibtexAuthors. The happy-path inputs are already covered by
// tests/server-utils.test.mjs and tests/next-serverutils-authors-re-hoist.test.mjs,
// so this file pins only the empty-segment, bare-comma, leading/trailing
// separator, and multi-comma edges. Every expected value below was captured by
// running the real function (no hand-written goldens); it pins CURRENT behavior
// and edits no source.
const require = createRequire(import.meta.url);
const { parseBibtexAuthors } = require('../../../../src/server/server-utils.js');

describe('parseBibtexAuthors edge branches', () => {
  it('leading-comma segment ", John" keeps the trailing space from an empty last name', () => {
    // The segment has a comma, so it reorders as "First Last". The last-name part
    // (before the comma) is empty while the first-name part is "John", so the
    // template literal yields "John " with a trailing space. This is a known mild
    // quirk, not a bug, and is correct to characterize.
    assert.deepStrictEqual(parseBibtexAuthors(', John'), ['John ']);
  });

  it('bare comma "," drops the segment entirely', () => {
    // Both the last-name and first-name parts are empty, so the segment maps to
    // an empty string and is removed by the final filter(Boolean).
    assert.deepStrictEqual(parseBibtexAuthors(','), []);
  });

  it('trailing separator "John Doe and " drops the empty trailing segment', () => {
    // Splitting on the " and " separator leaves an empty trailing segment that
    // trims to "" and is dropped; only "John Doe" survives.
    assert.deepStrictEqual(parseBibtexAuthors('John Doe and '), ['John Doe']);
  });

  it('leading separator " and John Doe" drops the empty leading segment', () => {
    // The empty leading segment is dropped; only "John Doe" survives.
    assert.deepStrictEqual(parseBibtexAuthors(' and John Doe'), ['John Doe']);
  });

  it('bare trailing comma "Doe," keeps only the last name', () => {
    // The first-name part (after the comma) is empty, so firstName is falsy and
    // the function returns the last name "Doe" alone.
    assert.deepStrictEqual(parseBibtexAuthors('Doe,'), ['Doe']);
  });

  it('multi-comma "Doe, John, Jr" joins the parts after the first comma', () => {
    // parts becomes ["Doe", "John", "Jr"]: the last name is "Doe" and everything
    // after the first comma joins with a space into firstName "John Jr", yielding
    // "John Jr Doe".
    assert.deepStrictEqual(parseBibtexAuthors('Doe, John, Jr'), ['John Jr Doe']);
  });

  it('bare "and" token without surrounding whitespace survives as a literal', () => {
    // The separator regex requires whitespace on both sides of "and", so a bare
    // "and" does not match and is returned as a literal author name.
    assert.deepStrictEqual(parseBibtexAuthors('and'), ['and']);
  });
});
