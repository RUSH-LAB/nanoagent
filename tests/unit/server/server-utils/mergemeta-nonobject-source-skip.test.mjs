import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeMetadataSources } = require('../../../../server/server-utils.js');

// Characterization test for the SOURCE-LEVEL non-object skip in
// mergeMetadataSources (server/server-utils.js, the function around line 311).
//
// While building the `present` map (lines 322 to 324) the merge keeps a source
// only when it is a plain object:
//
//   if (src && typeof src === 'object' && !Array.isArray(src)) present[name] = src;
//
// So a source supplied under crossref, dblp, or semanticScholar as an array, a
// string, a number, a boolean, or null is dropped entirely from the merge: it
// contributes no fields and no authors. A plain-object source for a different
// name still merges normally, and the surviving sources keep their usual
// SOURCE_ORDER precedence (crossref, then dblp, then semanticScholar) with the
// doi and venue overrides. When every source is a non-object, the merged result
// is an empty object.
//
// This concern is distinct from the field-level empty fall-through and from the
// Object-member field-name KEEP arms of the same function, which are pinned in
// their own files. Every expected value below was captured by running the real
// module; nothing here is guessed. The function is pure and deterministic, with
// no clock, randomness, network, or filesystem.
describe('mergeMetadataSources skips non-object sources', () => {
  it('skips an array source while a plain-object source still merges', () => {
    // crossref is an array, so it is dropped; only the semanticScholar object
    // contributes its title.
    const merged = mergeMetadataSources({ crossref: ['x'], semanticScholar: { title: 'T' } });
    assert.deepStrictEqual(merged, { title: 'T' });
  });

  it('skips a string source while a plain-object source still merges', () => {
    // crossref is a bare string, so it is dropped and semanticScholar wins.
    const merged = mergeMetadataSources({ crossref: 'hello', semanticScholar: { title: 'S2' } });
    assert.deepStrictEqual(merged, { title: 'S2' });
  });

  it('skips a number source while a plain-object source still merges', () => {
    // crossref is a number, so it is dropped and the dblp venue is kept.
    const merged = mergeMetadataSources({ crossref: 42, dblp: { venue: 'NeurIPS' } });
    assert.deepStrictEqual(merged, { venue: 'NeurIPS' });
  });

  it('skips a boolean source while a plain-object source still merges', () => {
    // dblp is a boolean, so it is dropped and semanticScholar supplies the title.
    const merged = mergeMetadataSources({ dblp: true, semanticScholar: { title: 'B' } });
    assert.deepStrictEqual(merged, { title: 'B' });
  });

  it('skips a null source while a plain-object source still merges', () => {
    // crossref is null (the `src &&` short-circuit drops it), so dblp wins.
    const merged = mergeMetadataSources({ crossref: null, dblp: { venue: 'DBLP Venue' } });
    assert.deepStrictEqual(merged, { venue: 'DBLP Venue' });
  });

  it('composes the skip with normal field precedence across all three names', () => {
    // crossref is an array and is dropped. The two surviving object sources keep
    // their precedence: doi prefers crossref then dblp then semanticScholar (dblp
    // wins here), venue prefers dblp first, title falls to dblp under SOURCE_ORDER
    // once crossref is gone, and the semanticScholar-only citationCount carries
    // through.
    const merged = mergeMetadataSources({
      crossref: ['ignored'],
      dblp: { doi: '10.x/dblp', venue: 'DBLP Venue', title: 'DBLP Title' },
      semanticScholar: { doi: '10.x/s2', title: 'S2 Title', citationCount: 5 },
    });
    assert.deepStrictEqual(merged, {
      doi: '10.x/dblp',
      venue: 'DBLP Venue',
      title: 'DBLP Title',
      citationCount: 5,
    });
  });

  it('drops a non-object source so its would-be authors never merge', () => {
    // The crossref array is dropped before mergeAuthorLists runs, so only the
    // dblp object contributes authors.
    const merged = mergeMetadataSources({
      crossref: ['Ignored Array'],
      dblp: { authors: ['Ada Lovelace', 'Alan Turing'] },
    });
    assert.deepStrictEqual(merged, { authors: ['Ada Lovelace', 'Alan Turing'] });
  });

  it('returns an empty object when every source is a non-object scalar or array', () => {
    // An array, a string, and a number leave nothing to merge.
    const merged = mergeMetadataSources({ crossref: ['x'], dblp: 'str', semanticScholar: 3 });
    assert.deepStrictEqual(merged, {});
  });

  it('returns an empty object when every source is null', () => {
    // All three names are null, so none survives the object guard.
    const merged = mergeMetadataSources({ crossref: null, dblp: null, semanticScholar: null });
    assert.deepStrictEqual(merged, {});
  });
});
