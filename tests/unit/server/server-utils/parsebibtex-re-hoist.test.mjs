import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseBibtex,
  BIBTEX_ENTRY_SPLIT_RE,
  BIBTEX_HEADER_RE,
  BIBTEX_WS_OR_COMMA_RE,
  BIBTEX_WS_RE,
} = require('../../../../src/server/server-utils.js');

// Each hoisted constant must stay the exact non-global pattern it replaced, so
// the shared instance behaves identically to the former inline literal.
const EXPECTED_SOURCES = {
  BIBTEX_ENTRY_SPLIT_RE: '(?=@\\s*[a-zA-Z]+\\s*\\{)',
  BIBTEX_HEADER_RE: '^@\\s*([a-zA-Z]+)\\s*\\{\\s*([^,\\s]+)\\s*,',
  BIBTEX_WS_OR_COMMA_RE: '[\\s,]',
  BIBTEX_WS_RE: '[\\s]',
};

describe('parseBibtex regex hoist', () => {
  it('exposes each pattern as a non-global RegExp with the expected source', () => {
    const consts = {
      BIBTEX_ENTRY_SPLIT_RE,
      BIBTEX_HEADER_RE,
      BIBTEX_WS_OR_COMMA_RE,
      BIBTEX_WS_RE,
    };
    for (const [name, re] of Object.entries(consts)) {
      assert.ok(re instanceof RegExp, `${name} must be a RegExp`);
      assert.equal(re.global, false, `${name} must not be global`);
      assert.equal(re.flags, '', `${name} must carry no flags`);
      assert.equal(re.source, EXPECTED_SOURCES[name], `${name} source must be unchanged`);
    }
  });

  it('parses a representative multi-entry BibTeX string into the exact expected objects', () => {
    // Entry one mixes newlines, indentation, brace values, a comma-bearing
    // author brace, and a quoted value; entry two crams irregular spacing onto a
    // single line. Together they exercise every char-scan loop in parseBibtex.
    const bib = `@article{smith2020,
  title = {A Great Paper},
  author = {Smith, John and Doe, Jane},
  year = {2020},
  journal = "Journal of Things"
}

@inproceedings{doe2021, title={Another Work}, booktitle = {Proceedings},   year =   {2021} }`;

    const expected = [
      {
        entryType: 'article',
        citationKey: 'smith2020',
        fields: {
          title: 'A Great Paper',
          author: 'Smith, John and Doe, Jane',
          year: '2020',
          journal: 'Journal of Things',
        },
      },
      {
        entryType: 'inproceedings',
        citationKey: 'doe2021',
        fields: {
          title: 'Another Work',
          booktitle: 'Proceedings',
          year: '2021',
        },
      },
    ];

    assert.deepEqual(parseBibtex(bib), expected);
  });

  it('returns identical output across consecutive calls (shared instances carry no state)', () => {
    // A non-global regex never advances lastIndex, but parsing the same input
    // twice and getting the same result pins that the shared instances stay
    // stateless between calls.
    const bib = `@misc{k, title = {X},  note = "y" }`;
    const expected = [
      { entryType: 'misc', citationKey: 'k', fields: { title: 'X', note: 'y' } },
    ];
    const first = parseBibtex(bib);
    const second = parseBibtex(bib);
    assert.deepEqual(first, expected);
    assert.deepEqual(second, first);
  });
});
