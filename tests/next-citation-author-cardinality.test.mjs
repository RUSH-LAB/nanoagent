// Characterization test for the pure citation formatter buildCitation, defined
// at server/routes/references.js line 75 and exported at line 652. It pins the
// CURRENT output on author-cardinality and name-tokenization edges that
// tests/moon-citation-format-dedup.test.mjs leaves uncovered: that sibling only
// exercises 0, 1, and 3 simple two-token authors, so the 2-author boundary,
// multi-token (middle) names, mononyms, and the missing-venue spacing stay
// unpinned until now.
//
// buildCitation is pure string formatting, so every output is deterministic.
// The expected strings below were captured by running the real exported
// function, then frozen as literals so any future change to the formatter trips
// this test. The module is loaded read-only through createRequire, mirroring
// tests/moon-citation-format-dedup.test.mjs; no source is modified.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const referencesRoutes = require('../server/routes/references.js');
const { buildCitation } = referencesRoutes;

describe('buildCitation author-cardinality and name-tokenization edges', () => {
  it('exports buildCitation as a function', () => {
    assert.equal(typeof buildCitation, 'function');
  });

  describe('APA style', () => {
    it('joins exactly two authors with a serial ampersand (single-element slice branch)', () => {
      assert.equal(
        buildCitation('apa', { authors: ['Alice Johnson', 'Bob Williams'], year: 2023, title: 'Two Author Paper', venue: 'ICML' }),
        'Johnson, A., & Williams, B. (2023). Two Author Paper. ICML.',
      );
    });

    it('reduces a middle name inside a two-author list to stacked initials', () => {
      assert.equal(
        buildCitation('apa', { authors: ['John Michael Smith', 'Jane Doe'], year: 2022, title: 'Mixed Tokens Paper', venue: 'ACL' }),
        'Smith, J. M., & Doe, J. (2022). Mixed Tokens Paper. ACL.',
      );
    });

    it('reduces a single multi-token author to surname plus every initial', () => {
      assert.equal(
        buildCitation('apa', { authors: ['John Michael Smith'], year: 2024, title: 'Middle Name Paper', venue: 'NeurIPS' }),
        'Smith, J. M. (2024). Middle Name Paper. NeurIPS.',
      );
    });

    it('leaves a trailing space after the title when a single author has no venue', () => {
      assert.equal(
        buildCitation('apa', { authors: ['John Smith'], year: 2024, title: 'No Venue Paper', venue: '' }),
        // The missing venue collapses to an empty string, so the template keeps
        // the space that normally precedes the venue. The trailing space is real.
        'Smith, J. (2024). No Venue Paper. ',
      );
    });

    it('keeps the bare surname and a doubled space for a mononym', () => {
      assert.equal(
        buildCitation('apa', { authors: ['Aristotle'], year: 2024, title: 'Ancient Work', venue: 'Academy' }),
        // No given-name tokens means the initials join is empty, so the author
        // string ends in a comma and a space, doubling the space before the year.
        'Aristotle,  (2024). Ancient Work. Academy.',
      );
    });
  });

  describe('MLA style', () => {
    it('collapses exactly two authors to the first plus et al. at the boundary', () => {
      assert.equal(
        buildCitation('mla', { authors: ['Alice Johnson', 'Bob Williams'], year: 2023, title: 'Two Author Paper', venue: 'ICML' }),
        // More than one author triggers et al.; its period and the template
        // period land together as the doubled "et al..".
        'Johnson, Alice, et al.. "Two Author Paper." ICML, 2023.',
      );
    });

    it('keeps the full first and middle name for a single multi-token author', () => {
      assert.equal(
        buildCitation('mla', { authors: ['John Michael Smith'], year: 2024, title: 'Middle Name Paper', venue: 'NeurIPS' }),
        'Smith, John Michael. "Middle Name Paper." NeurIPS, 2024.',
      );
    });

    it('drops the venue segment for a single author with no venue', () => {
      assert.equal(
        buildCitation('mla', { authors: ['John Smith'], year: 2024, title: 'No Venue Paper', venue: '' }),
        'Smith, John. "No Venue Paper." 2024.',
      );
    });

    it('yields the comma, space, then period form for a mononym', () => {
      assert.equal(
        buildCitation('mla', { authors: ['Aristotle'], year: 2024, title: 'Ancient Work', venue: 'Academy' }),
        'Aristotle, . "Ancient Work." Academy, 2024.',
      );
    });
  });
});
