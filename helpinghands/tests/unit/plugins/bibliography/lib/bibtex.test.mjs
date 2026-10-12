/**
 * plugins/bibliography/lib/bibtex.js: reading BibTeX.
 *
 * These three describes came from tests/unit/server/server-utils.test.mjs when
 * the parser left the server's shared helpers for the only plugin that ever
 * called it.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {parseBibtex, parseBibtexAuthors, mapBibtexEntryType} =
  require('../../../../../plugins/bibliography/lib/bibtex.js');

describe('parseBibtex', () => {
  it('parses a single article entry', () => {
    const input = `@article{doe2020,
      author = {John Doe},
      title = {A Paper},
      year = {2020}
    }`;
    const entries = parseBibtex(input);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].entryType, 'article');
    assert.equal(entries[0].citationKey, 'doe2020');
    assert.equal(entries[0].fields.author, 'John Doe');
    assert.equal(entries[0].fields.title, 'A Paper');
    assert.equal(entries[0].fields.year, '2020');
  });

  it('parses multiple entries', () => {
    const input = `@article{a1, title = {Title1}}
    @book{b1, title = {Title2}}`;
    const entries = parseBibtex(input);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].entryType, 'article');
    assert.equal(entries[1].entryType, 'book');
  });

  it('handles quoted values', () => {
    const input = '@article{k1, title = "Quoted Title"}';
    const entries = parseBibtex(input);
    assert.equal(entries[0].fields.title, 'Quoted Title');
  });

  it('handles bare numeric values', () => {
    const input = '@article{k1, year = 2023}';
    const entries = parseBibtex(input);
    assert.equal(entries[0].fields.year, '2023');
  });

  it('handles nested braces in values', () => {
    const input = '@article{k1, title = {A {Nested} Title}}';
    const entries = parseBibtex(input);
    assert.equal(entries[0].fields.title, 'A {Nested} Title');
  });

  it('normalizes entry type to lowercase', () => {
    const input = '@ARTICLE{k1, title = {Test}}';
    const entries = parseBibtex(input);
    assert.equal(entries[0].entryType, 'article');
  });

  it('normalizes field names to lowercase', () => {
    const input = '@article{k1, Title = {Test}, YEAR = {2020}}';
    const entries = parseBibtex(input);
    assert.ok('title' in entries[0].fields);
    assert.ok('year' in entries[0].fields);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseBibtex(''), []);
  });

  it('returns empty array for non-bibtex text', () => {
    assert.deepEqual(parseBibtex('just some random text'), []);
  });

  it('skips malformed entries without proper header', () => {
    const input = '@article{, title = {No Key}}';
    const entries = parseBibtex(input);
    assert.equal(entries.length, 0);
  });

  it('handles entries with many fields', () => {
    const input = `@inproceedings{smith2021,
      author = {Jane Smith},
      title = {Great Work},
      booktitle = {Proc ICML},
      year = {2021},
      pages = {1--10},
      publisher = {ACM}
    }`;
    const entries = parseBibtex(input);
    assert.equal(entries[0].fields.author, 'Jane Smith');
    assert.equal(entries[0].fields.booktitle, 'Proc ICML');
    assert.equal(entries[0].fields.pages, '1--10');
    assert.equal(entries[0].fields.publisher, 'ACM');
  });

  it('handles @InProceedings with mixed case', () => {
    const input = '@InProceedings{key1, title = {T}}';
    const entries = parseBibtex(input);
    assert.equal(entries[0].entryType, 'inproceedings');
  });

  it('preserves citation key as-is', () => {
    const input = '@article{CamelCase_Key-123, title = {T}}';
    const entries = parseBibtex(input);
    assert.equal(entries[0].citationKey, 'CamelCase_Key-123');
  });
});

describe('parseBibtexAuthors', () => {
  it('parses single "First Last" author', () => {
    assert.deepEqual(parseBibtexAuthors('John Doe'), ['John Doe']);
  });

  it('parses single "Last, First" author', () => {
    assert.deepEqual(parseBibtexAuthors('Doe, John'), ['John Doe']);
  });

  it('parses multiple authors separated by " and "', () => {
    const result = parseBibtexAuthors('John Doe and Jane Smith');
    assert.deepEqual(result, ['John Doe', 'Jane Smith']);
  });

  it('handles "Last, First" for multiple authors', () => {
    const result = parseBibtexAuthors('Doe, John and Smith, Jane');
    assert.deepEqual(result, ['John Doe', 'Jane Smith']);
  });

  it('handles mixed author formats', () => {
    const result = parseBibtexAuthors('Doe, John and Jane Smith');
    assert.deepEqual(result, ['John Doe', 'Jane Smith']);
  });

  it('returns empty array for null', () => {
    assert.deepEqual(parseBibtexAuthors(null), []);
  });

  it('returns empty array for undefined', () => {
    assert.deepEqual(parseBibtexAuthors(undefined), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(parseBibtexAuthors(''), []);
  });

  it('handles author with middle name in "First Last" format', () => {
    assert.deepEqual(parseBibtexAuthors('John M. Doe'), ['John M. Doe']);
  });

  it('handles "Last, First Middle" format', () => {
    const result = parseBibtexAuthors('Doe, John M.');
    assert.deepEqual(result, ['John M. Doe']);
  });

  it('handles single-name author (mononym)', () => {
    assert.deepEqual(parseBibtexAuthors('Aristotle'), ['Aristotle']);
  });

  it('handles three authors', () => {
    const result = parseBibtexAuthors('Alice A and Bob B and Charlie C');
    assert.deepEqual(result, ['Alice A', 'Bob B', 'Charlie C']);
  });
});

describe('mapBibtexEntryType', () => {
  it('maps "article" to "article"', () => {
    assert.equal(mapBibtexEntryType('article'), 'article');
  });

  it('maps "inproceedings" to "inproceedings"', () => {
    assert.equal(mapBibtexEntryType('inproceedings'), 'inproceedings');
  });

  it('maps "conference" to "inproceedings"', () => {
    assert.equal(mapBibtexEntryType('conference'), 'inproceedings');
  });

  it('maps "book" to "book"', () => {
    assert.equal(mapBibtexEntryType('book'), 'book');
  });

  it('maps "phdthesis" to "phdthesis"', () => {
    assert.equal(mapBibtexEntryType('phdthesis'), 'phdthesis');
  });

  it('maps "mastersthesis" to "mastersthesis"', () => {
    assert.equal(mapBibtexEntryType('mastersthesis'), 'mastersthesis');
  });

  it('maps "techreport" to "techreport"', () => {
    assert.equal(mapBibtexEntryType('techreport'), 'techreport');
  });

  it('maps "misc" to "misc"', () => {
    assert.equal(mapBibtexEntryType('misc'), 'misc');
  });

  it('maps "unpublished" to "unpublished"', () => {
    assert.equal(mapBibtexEntryType('unpublished'), 'unpublished');
  });

  it('maps "incollection" to "incollection"', () => {
    assert.equal(mapBibtexEntryType('incollection'), 'incollection');
  });

  it('maps "inbook" to "inbook"', () => {
    assert.equal(mapBibtexEntryType('inbook'), 'inbook');
  });

  it('maps "proceedings" to "proceedings"', () => {
    assert.equal(mapBibtexEntryType('proceedings'), 'proceedings');
  });

  it('maps unknown type to "misc"', () => {
    assert.equal(mapBibtexEntryType('somethingelse'), 'misc');
  });

  it('maps undefined to "misc"', () => {
    assert.equal(mapBibtexEntryType(undefined), 'misc');
  });
});
