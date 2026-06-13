import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseBibtex } = require('../server/server-utils.js');

// Characterization tests for the bare-value scanner in parseBibtex
// (server/server-utils.js, function at line 132; bare-value loop at line 197).
// An unquoted, unbraced value stops at the first comma, closing brace, or
// whitespace character. The existing suite only covers a single bare field that
// terminates on the closing brace (@article{k1, year = 2023}); the comma and
// whitespace terminators, where a bare value is followed by another field, were
// untested. Every expected object below was captured by running the real
// parseBibtex, so these pin current behavior rather than an assumed contract.
describe('parseBibtex bare-value terminators', () => {
  it('stops each bare value at the comma when fields are comma separated', () => {
    const input = '@article{k1, year = 2020, volume = 7, note = draft}';
    const expected = [
      {
        entryType: 'article',
        citationKey: 'k1',
        fields: { year: '2020', volume: '7', note: 'draft' },
      },
    ];
    assert.deepStrictEqual(parseBibtex(input), expected);
  });

  it('stops a bare value at whitespace so the next bare field is read', () => {
    const input = '@article{k1, year = 2020 month = jan}';
    const expected = [
      {
        entryType: 'article',
        citationKey: 'k1',
        fields: { year: '2020', month: 'jan' },
      },
    ];
    assert.deepStrictEqual(parseBibtex(input), expected);
  });

  it('composes a bare value with braced and quoted values in one entry', () => {
    const input = '@article{k1, year = 2020, title = {A Title}, note = "quoted"}';
    const expected = [
      {
        entryType: 'article',
        citationKey: 'k1',
        fields: { year: '2020', title: 'A Title', note: 'quoted' },
      },
    ];
    assert.deepStrictEqual(parseBibtex(input), expected);
  });

  it('stops a trailing bare value at the closing brace after a prior field', () => {
    const input = '@book{k2, title = {T}, year = 2023}';
    const expected = [
      {
        entryType: 'book',
        citationKey: 'k2',
        fields: { title: 'T', year: '2023' },
      },
    ];
    assert.deepStrictEqual(parseBibtex(input), expected);
  });
});
