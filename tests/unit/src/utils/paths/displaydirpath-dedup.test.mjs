import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// displayDirPath is authored as an ES module under src/utils (consumed by the
// Docusaurus build); Node's module-syntax detection lets this .mjs test import
// the .js source directly and read the named export.
import { displayDirPath } from '../../../../../src/utils/paths.js';

describe('displayDirPath (shared parent-directory label)', () => {
  it('strips the content/ prefix and drops the final segment', () => {
    assert.equal(displayDirPath('content/books/foo/bar.md'), 'books/foo');
  });

  it('returns the remainder unchanged when no directory separator is left', () => {
    // After stripping `content/`, `x.md` has no slash, so the final-segment
    // drop matches nothing and the remainder is returned as is.
    assert.equal(displayDirPath('content/x.md'), 'x.md');
  });

  it('drops the final segment even without a content/ prefix', () => {
    assert.equal(displayDirPath('posts/2024/hello.md'), 'posts/2024');
  });

  it('returns an empty string for empty, null, or undefined input', () => {
    assert.equal(displayDirPath(''), '');
    assert.equal(displayDirPath(null), '');
    assert.equal(displayDirPath(undefined), '');
  });
});
