import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeMetadataSources } = require('../server/server-utils.js');

// Characterization test for two aspects of mergeMetadataSources
// (server/server-utils.js, the function around lines 311 to 362) that the
// existing suites leave unpinned:
//
//   1. The OUTPUT KEY ORDER. The merged record's keys follow the source
//      precedence union (crossref fields first, then the new dblp fields, then
//      the new semanticScholar field), and `authors` is always moved to the end.
//      The sibling suites compare values with deepStrictEqual, which does NOT
//      verify own-key insertion order, so the order is asserted here directly
//      with `Object.keys(result)`.
//   2. The OBJECT-VALUED field branch. hasValue (line 327) treats a plain object
//      as a real value, so an object field is kept, and it fills through an empty
//      higher-precedence value (an empty string is not a value) from a
//      lower-precedence source.
//
// Every golden below was captured by running the real module; nothing is
// guessed. mergeMetadataSources is pure and deterministic (no clock, randomness,
// network, or filesystem), so these goldens are stable. The real output is the
// source of truth: if it ever differs, the real output wins.
describe('server-utils mergeMetadataSources key order and object values', () => {
  it('orders output keys by source precedence union (crossref, then dblp, then semanticScholar)', () => {
    // crossref contributes title and year, dblp adds venue and pages, and
    // semanticScholar adds tldr. The union keeps each field at its first
    // appearance, so the merged key order is the concatenation of the new
    // fields each source brings.
    const result = mergeMetadataSources({
      crossref: { title: 'T', year: 2020 },
      dblp: { venue: 'V', pages: '1-9' },
      semanticScholar: { tldr: 's' },
    });

    assert.deepStrictEqual(Object.keys(result), ['title', 'year', 'venue', 'pages', 'tldr']);
    // Full value pinned too, so the order assertion is anchored to real output.
    assert.deepStrictEqual(result, { title: 'T', year: 2020, venue: 'V', pages: '1-9', tldr: 's' });
  });

  it('moves authors to the last key even when it appears mid-source', () => {
    // The single source lists authors between title and year, but authors is
    // merged separately and appended after every other field, so it lands last.
    const result = mergeMetadataSources({
      crossref: { title: 'T', authors: ['Ada Lovelace'], year: 2021 },
    });

    assert.deepStrictEqual(Object.keys(result), ['title', 'year', 'authors']);
    assert.deepStrictEqual(result, { title: 'T', year: 2021, authors: ['Ada Lovelace'] });
  });

  it('keeps authors last when supplied only by a lower-precedence source', () => {
    // title comes from crossref and authors comes from dblp. authors is still
    // appended after the non-author fields, so it remains the final key.
    const result = mergeMetadataSources({
      crossref: { title: 'T' },
      dblp: { authors: ['Bob Lee'] },
    });

    assert.deepStrictEqual(Object.keys(result), ['title', 'authors']);
    assert.deepStrictEqual(result, { title: 'T', authors: ['Bob Lee'] });
  });

  it('keeps a plain object field value', () => {
    // hasValue treats a non-null object as a real value, so an object-valued
    // field is carried into the merged record unchanged.
    const result = mergeMetadataSources({
      crossref: { extra: { nested: 1 } },
    });

    assert.deepStrictEqual(Object.keys(result), ['extra']);
    assert.deepStrictEqual(result, { extra: { nested: 1 } });
  });

  it('fills an object from a lower source through an empty higher-precedence value', () => {
    // crossref supplies meta as an empty string, which hasValue rejects, so the
    // object from the lower-precedence dblp source fills the field instead.
    const result = mergeMetadataSources({
      crossref: { meta: '' },
      dblp: { meta: { a: 1 } },
    });

    assert.deepStrictEqual(Object.keys(result), ['meta']);
    assert.deepStrictEqual(result, { meta: { a: 1 } });
  });
});
