import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseBibtex } = require('../server/server-utils.js');

// Characterization tests for two so far unpinned branches of the field parser in
// parseBibtex (server/server-utils.js, function at line 132).
//
//   1. Duplicate field names. The field loop assigns `fields[name] = value`
//      (line 201) with no guard, so a repeated field silently overwrites the
//      earlier value: last write wins, regardless of value syntax.
//   2. An empty bare value terminated immediately by a comma. The bare-value
//      scanner (line 197) stops at the first comma, yields the empty string,
//      and parsing continues so the next field is still captured.
//
// The existing parseBibtex suites cover malformed entries, non-empty bare-value
// terminators, the re-hoist regression, and the happy path, but never a repeated
// field name or an empty bare value. Every expected value below was captured by
// running the real parseBibtex, so these pin current behavior rather than an
// assumed contract.
describe('server-utils parseBibtex duplicate fields and empty bare values', () => {
  it('overwrites a duplicate field so the last write wins (full result)', () => {
    const input = '@article{k, title = {First}, title = {Second}}';
    const expected = [
      {
        entryType: 'article',
        citationKey: 'k',
        fields: { title: 'Second' },
      },
    ];
    assert.deepStrictEqual(parseBibtex(input), expected);
  });

  it('keeps only the last of three duplicates of the same field', () => {
    const input = '@article{k, x = {a}, x = {b}, x = {c}}';
    const result = parseBibtex(input);
    assert.strictEqual(result.length, 1);
    // A single surviving key proves each duplicate overwrote the previous one.
    assert.deepStrictEqual(Object.keys(result[0].fields), ['x']);
    assert.strictEqual(result[0].fields.x, 'c');
  });

  it('overwrites across value syntaxes: a quoted duplicate replaces a braced one', () => {
    const input = '@article{k, v = {braced}, v = "quoted"}';
    const result = parseBibtex(input);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(Object.keys(result[0].fields), ['v']);
    assert.strictEqual(result[0].fields.v, 'quoted');
  });

  it('yields an empty string for a bare value ended by a comma and keeps parsing (full result)', () => {
    const input = '@article{k, title = , year = 2020}';
    const expected = [
      {
        entryType: 'article',
        citationKey: 'k',
        fields: { title: '', year: '2020' },
      },
    ];
    assert.deepStrictEqual(parseBibtex(input), expected);
  });
});
