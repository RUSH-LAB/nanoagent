import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// formatAuthorList is authored as an ES module under src/utils (consumed by the
// Docusaurus build); Node's module-syntax detection lets this .mjs test import
// the .js source directly and read the named export.
import { formatAuthorList } from '../../../../../src/utils/authors.js';

describe('formatAuthorList (shared author-list formatter)', () => {
  it('returns Unknown for an empty array', () => {
    assert.equal(formatAuthorList([]), 'Unknown');
  });

  it('returns Unknown for null or undefined', () => {
    assert.equal(formatAuthorList(null), 'Unknown');
    assert.equal(formatAuthorList(undefined), 'Unknown');
  });

  it('joins one to three authors with a comma and space', () => {
    assert.equal(formatAuthorList(['Alice']), 'Alice');
    assert.equal(formatAuthorList(['Alice', 'Bob']), 'Alice, Bob');
    assert.equal(formatAuthorList(['Alice', 'Bob', 'Carol']), 'Alice, Bob, Carol');
  });

  it('keeps the first three then appends ", et al." for four or more authors', () => {
    assert.equal(formatAuthorList(['a', 'b', 'c', 'd']), 'a, b, c, et al.');
    assert.equal(formatAuthorList(['a', 'b', 'c', 'd', 'e']), 'a, b, c, et al.');
  });
});
