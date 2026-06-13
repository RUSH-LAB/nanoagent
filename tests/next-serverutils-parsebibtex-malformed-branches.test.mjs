import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseBibtex } = require('../server/server-utils.js');

// Characterization test for the malformed and unterminated input recovery
// branches of parseBibtex in ../server/server-utils.js. Its happy path and the
// two reject paths (non-@ / empty input, empty-key header) are pinned in
// tests/server-utils.test.mjs and tests/next-serverutils-parsebibtex-re-hoist.test.mjs;
// these cases cover the recovery branches that those leave unasserted.
//
// Every expected array below was captured by running the real module on the
// broken input, so each case documents the parser's CURRENT recovery behavior.
// None of these inputs is valid BibTeX and none of these outputs is a claim
// about correct or desired behavior; they only lock in what the scanner does
// today so a future change to that behavior is surfaced.
describe('parseBibtex malformed input recovery', () => {
  it('returns the fields collected so far when the entry brace is never closed', () => {
    // The field value's own closing brace is present, but the entry never closes
    // its outer brace. The brace depth scan therefore never returns to zero,
    // bodyEnd falls back to the end of the string, and the single field parsed
    // before the input ends is still returned as one entry.
    const input = '@article{open, title = {No Closing Brace}';
    const expected = [
      { entryType: 'article', citationKey: 'open', fields: { title: 'No Closing Brace' } },
    ];
    assert.deepEqual(parseBibtex(input), expected);
  });

  it('skips a field token with no equals sign and resumes one character into the next field name', () => {
    // The token "noeq" carries no "=", so the recovery branch advances the cursor
    // by a single character and continues. That step lands inside the following
    // field name, so "year" is read as "ear"; the dropped leading character is
    // the visible effect of the misaligned resume.
    const input = '@article{key, noeq year = {2020}}';
    const expected = [
      { entryType: 'article', citationKey: 'key', fields: { ear: '2020' } },
    ];
    assert.deepEqual(parseBibtex(input), expected);
  });

  it('drops a field whose equals sign sits at the very end of the body', () => {
    // After consuming the "=", the value side immediately reaches the end of the
    // body and breaks, so the field name is never recorded and the entry carries
    // an empty fields object.
    const input = '@article{key, title =}';
    const expected = [
      { entryType: 'article', citationKey: 'key', fields: {} },
    ];
    assert.deepEqual(parseBibtex(input), expected);
  });

  it('keeps the text gathered so far when a quoted value is never closed', () => {
    // The quoted value has no closing double quote, so the quote loop runs to the
    // end of the body and the collected value "Unterminated" is kept for the field.
    const input = '@article{key, title = "Unterminated}';
    const expected = [
      { entryType: 'article', citationKey: 'key', fields: { title: 'Unterminated' } },
    ];
    assert.deepEqual(parseBibtex(input), expected);
  });
});
