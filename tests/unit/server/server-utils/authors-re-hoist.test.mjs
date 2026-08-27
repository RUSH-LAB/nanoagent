import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseBibtexAuthors,
  AUTHORS_AND_SPLIT_RE,
  AUTHOR_NAME_WS_SPLIT_RE,
  AUTHOR_INITIAL_DOT_RE,
} = require('../../../../server/server-utils.js');

describe('server-utils author regex hoist', () => {
  it('exports each author regex as a module-scope RegExp with the expected source and flags', () => {
    assert.ok(AUTHORS_AND_SPLIT_RE instanceof RegExp);
    assert.equal(AUTHORS_AND_SPLIT_RE.source, '\\s+and\\s+');
    assert.equal(AUTHORS_AND_SPLIT_RE.flags, 'i');

    assert.ok(AUTHOR_NAME_WS_SPLIT_RE instanceof RegExp);
    assert.equal(AUTHOR_NAME_WS_SPLIT_RE.source, '\\s+');
    assert.equal(AUTHOR_NAME_WS_SPLIT_RE.flags, '');

    assert.ok(AUTHOR_INITIAL_DOT_RE instanceof RegExp);
    assert.equal(AUTHOR_INITIAL_DOT_RE.source, '\\.');
    assert.equal(AUTHOR_INITIAL_DOT_RE.flags, 'g');
  });

  it('parseBibtexAuthors returns a byte-identical array across repeated calls', () => {
    // One input that exercises all three behaviors at once: the case-insensitive
    // `and` split (lowercase `and` plus uppercase `AND`), the `Last, First`
    // reorder, and a bare initial (`D.`).
    const input = 'Doe, Jane and John Smith AND Knuth, D.';
    const expected = ['Jane Doe', 'John Smith', 'D. Knuth'];

    const first = parseBibtexAuthors(input);
    assert.deepEqual(first, expected);

    // Calling again must yield the same result: the shared regex instances carry
    // no leftover state between parses.
    const second = parseBibtexAuthors(input);
    assert.deepEqual(second, first);
  });

  it('AUTHOR_INITIAL_DOT_RE (the only /g instance) carries no lastIndex state across replace calls', () => {
    // splitAuthorName strips initial dots via String.prototype.replace, which
    // resets lastIndex; a shared /g instance must therefore strip identically on
    // every call. parseBibtexAuthors never reaches this regex, so exercise it
    // directly through the exported constant.
    assert.equal('J.R.R.'.replace(AUTHOR_INITIAL_DOT_RE, ''), 'JRR');
    assert.equal('J.R.R.'.replace(AUTHOR_INITIAL_DOT_RE, ''), 'JRR');
    assert.equal(AUTHOR_INITIAL_DOT_RE.lastIndex, 0);
  });
});
