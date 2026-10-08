import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeMetadataSources } = require('../../../../../plugins/bibliography/lib/bibtex.js');

// Field precedence, author dedup, and the empty-input contract of the
// bibliography's multi-source metadata merge. These blocks travelled here from
// tests/unit/server/server-utils/latex-and-dedup.test.mjs, where they sat beside
// unrelated LaTeX and title-dedup blocks, when the merge moved into the plugin
// that owns it. The assertions are unchanged.
describe('mergeMetadataSources', () => {
  it('fills each missing field from whichever source has it', () => {
    const merged = mergeMetadataSources({
      semanticScholar: {title: 'Attention Is All You Need', year: 2017, citationCount: 100000},
      crossref: {doi: '10.1234/abc', publisher: 'ACM'},
      dblp: {venue: 'NeurIPS'},
    });
    assert.equal(merged.title, 'Attention Is All You Need');
    assert.equal(merged.year, 2017);
    assert.equal(merged.citationCount, 100000);
    assert.equal(merged.doi, '10.1234/abc');
    assert.equal(merged.publisher, 'ACM');
    assert.equal(merged.venue, 'NeurIPS');
  });

  it('keeps a zero-valued field rather than treating it as missing', () => {
    const merged = mergeMetadataSources({
      crossref: {citationCount: 0},
      semanticScholar: {citationCount: 5},
    });
    // 0 is a real value: the higher-precedence CrossRef 0 must win over the
    // lower-precedence Semantic Scholar 5, never fall through as if absent.
    assert.equal(merged.citationCount, 0);
  });

  it('applies deterministic field precedence across sources', () => {
    const merged = mergeMetadataSources({
      semanticScholar: {title: 'S2 Title', doi: 's2-doi', venue: 'S2 Venue', year: 2000},
      crossref: {title: 'CrossRef Title', doi: 'crossref-doi', venue: 'CrossRef Venue', year: 2001},
      dblp: {title: 'DBLP Title', doi: 'dblp-doi', venue: 'DBLP Venue', year: 2002},
    });
    assert.equal(merged.doi, 'crossref-doi'); // CrossRef wins for DOI
    assert.equal(merged.venue, 'DBLP Venue'); // DBLP wins for venue
    assert.equal(merged.title, 'CrossRef Title'); // default order: CrossRef first
    assert.equal(merged.year, 2001); // default order: CrossRef first
  });

  it('de-duplicates authors across name formats, keeping the fuller spelling', () => {
    const merged = mergeMetadataSources({
      crossref: {authors: ['John Doe', 'Jane Smith']},
      semanticScholar: {authors: ['J. Doe', 'Jane Smith', 'Bob Lee']},
    });
    assert.deepEqual(merged.authors, ['John Doe', 'Jane Smith', 'Bob Lee']);
    assert.ok(!merged.authors.includes('J. Doe'));
  });

  it('keeps distinct full first names with the same initial separate', () => {
    const merged = mergeMetadataSources({
      crossref: {authors: ['John Doe']},
      semanticScholar: {authors: ['Jane Doe']},
    });
    assert.deepEqual(merged.authors, ['John Doe', 'Jane Doe']);
  });

  it('ignores prototype-polluting field names without throwing', () => {
    // Own __proto__/constructor keys (as JSON.parse produces) must not crash the
    // precedence lookup or pollute the output, while normal fields still merge.
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "x", "title": "Safe", "doi": "10.1/ok"}');
    let merged;
    assert.doesNotThrow(() => { merged = mergeMetadataSources({crossref: evil}); });
    assert.equal(merged.title, 'Safe');
    assert.equal(merged.doi, '10.1/ok');
    assert.ok(!Object.prototype.hasOwnProperty.call(merged, 'constructor'));
    assert.equal({}.polluted, undefined);
  });

  it('returns {} for empty, missing, or partial input without throwing', () => {
    assert.deepEqual(mergeMetadataSources({}), {});
    assert.deepEqual(mergeMetadataSources(), {});
    assert.deepEqual(mergeMetadataSources(null), {});
    assert.deepEqual(mergeMetadataSources({semanticScholar: null, crossref: null, dblp: null}), {});
    assert.deepEqual(mergeMetadataSources({crossref: {doi: 'x'}}), {doi: 'x'});
  });
});
