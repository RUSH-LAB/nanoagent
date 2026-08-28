import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeMetadataSources } = require('../../../../src/server/server-utils.js');

// Characterization test for the empty-value fall-through in mergeMetadataSources
// (server/server-utils.js). The internal `hasValue` helper treats null/undefined,
// an empty or whitespace-only string, and an empty array as "absent", so the
// field-precedence loop skips that source and fills the field from the next source
// that holds a real value. When every source is empty for a field, the field is
// omitted from the merged output entirely. Boolean false, the number 0, and a
// non-empty array are all "present" and are kept.
//
// Source precedence (highest first) is CrossRef, then DBLP, then Semantic Scholar
// for every field except `doi` (CrossRef, DBLP, Semantic Scholar) and `venue`
// (DBLP, CrossRef, Semantic Scholar). Each expected value below was confirmed by
// running the real module; nothing here is guessed.
describe('mergeMetadataSources empty-value fall-through', () => {
  it('falls through an empty string to the next source with a real value', () => {
    // crossref.title is '' (hasValue false on the trim check), so DBLP wins.
    const merged = mergeMetadataSources({
      crossref: { title: '' },
      dblp: { title: 'Real Title' },
    });
    assert.deepEqual(merged, { title: 'Real Title' });
  });

  it('falls through a whitespace-only string (the trim branch)', () => {
    // '   ' trims to '' so it counts as absent and DBLP fills the field.
    const merged = mergeMetadataSources({
      crossref: { publisher: '   ' },
      dblp: { publisher: 'ACM' },
    });
    assert.deepEqual(merged, { publisher: 'ACM' });
  });

  it('falls through an empty array for a non-author field (the Array.isArray branch)', () => {
    // An empty array has length 0, so hasValue reports it absent and DBLP wins.
    const merged = mergeMetadataSources({
      crossref: { keywords: [] },
      dblp: { keywords: ['ml', 'nlp'] },
    });
    assert.deepEqual(merged, { keywords: ['ml', 'nlp'] });
  });

  it('falls through a null field value', () => {
    // null is absent, so the lower-precedence DBLP year fills the field.
    const merged = mergeMetadataSources({
      crossref: { year: null },
      dblp: { year: 2020 },
    });
    assert.deepEqual(merged, { year: 2020 });
  });

  it('omits a field for which every source is empty', () => {
    // title is empty in all three sources (empty, whitespace, null), so it is
    // dropped from the output; the unrelated `year` from CrossRef still survives.
    const merged = mergeMetadataSources({
      crossref: { title: '', year: 2019 },
      dblp: { title: '   ' },
      semanticScholar: { title: null },
    });
    assert.deepEqual(merged, { year: 2019 });
    assert.equal(Object.prototype.hasOwnProperty.call(merged, 'title'), false);
  });

  it('keeps a non-empty array as a real value', () => {
    // A single-element array is present, so it is carried into the merged record.
    const merged = mergeMetadataSources({
      crossref: { keywords: ['transformer'] },
    });
    assert.deepEqual(merged, { keywords: ['transformer'] });
  });

  it('keeps boolean false as a real value (not skipped as empty)', () => {
    // false is "present", so the higher-precedence CrossRef false wins over the
    // lower-precedence DBLP true; it must not fall through as if absent.
    const merged = mergeMetadataSources({
      crossref: { openAccess: false },
      dblp: { openAccess: true },
    });
    assert.deepEqual(merged, { openAccess: false });
  });

  it('resolves a realistic merge where several empty fields fall through together', () => {
    // title: empty then whitespace then a real Semantic Scholar value.
    // doi: only CrossRef supplies it, so it is carried through.
    // venue: CrossRef is empty but DBLP leads the venue order anyway.
    // tags: CrossRef empty array, DBLP absent, Semantic Scholar has the value.
    // openAccess false and citationCount 0 are real values and are kept.
    const merged = mergeMetadataSources({
      crossref: { title: '', doi: '10.1/cr', venue: '', tags: [], openAccess: false },
      dblp: { title: '  ', venue: 'NeurIPS', year: 2021 },
      semanticScholar: { title: 'S2 Title', tags: ['a'], citationCount: 0 },
    });
    assert.deepEqual(merged, {
      title: 'S2 Title',
      doi: '10.1/cr',
      venue: 'NeurIPS',
      tags: ['a'],
      openAccess: false,
      year: 2021,
      citationCount: 0,
    });
  });
});
