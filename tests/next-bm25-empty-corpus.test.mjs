import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

// research-tools.js is CommonJS; load it exactly the way tests/search-bm25.test.mjs does.
const require = createRequire(import.meta.url);
const researchTools = require('../server/routes/research-tools.js');
const { buildSearchDoc, corpusStats, bm25Score, rankDocuments } = researchTools;

// Characterization tests for the DEFENSIVE empty-corpus arms of the BM25 helpers.
// tests/search-bm25.test.mjs covers the populated corpus thoroughly, but every call
// there passes non-empty documents (N > 0 and avgdl > 0), so the zero-guard arms
// never run. Two of those guards are load-bearing and are pinned below:
//   • corpusStats: `avgdl: N > 0 ? totalLength / N : 0` — without the N > 0 guard,
//     corpusStats([]) would compute 0 / 0 = NaN instead of 0.
//   • bm25Score: `lengthNorm = avgdl > 0 ? doc.length / avgdl : 0` — without the
//     avgdl > 0 guard, scoring a matching document against an empty (avgdl 0) corpus
//     would divide by zero, making lengthNorm Infinity and collapsing the score to 0.
// The expected values were captured from the real exported functions; no source file
// is modified.
describe('BM25 empty-corpus defensive arms', () => {
  it('corpusStats([]) returns N 0, avgdl 0, and an empty df map (N === 0 guard)', () => {
    const stats = corpusStats([]);
    assert.equal(stats.N, 0);
    assert.equal(stats.avgdl, 0); // the `N > 0 ? totalLength / N : 0` guard; 0/0 would be NaN
    assert.ok(stats.df instanceof Map);
    assert.equal(stats.df.size, 0);
  });

  it('buildSearchDoc("") yields length 0 and an empty tf map', () => {
    const doc = buildSearchDoc('');
    assert.equal(doc.length, 0); // a zero-length doc, which produces the avgdl === 0 corpus below
    assert.ok(doc.tf instanceof Map);
    assert.equal(doc.tf.size, 0);
  });

  it('corpusStats over all-empty docs gives N 2 yet avgdl 0 (avgdl 0 while N > 0)', () => {
    const stats = corpusStats([buildSearchDoc(''), buildSearchDoc('')]);
    assert.equal(stats.N, 2);       // N > 0, so the divide branch of the avgdl ternary runs,
    assert.equal(stats.avgdl, 0);   // yet avgdl is 0 because both empty docs contribute length 0.
    assert.equal(stats.df.size, 0);
  });

  it('bm25Score returns 0 when the query term is absent under an empty (avgdl 0) corpus', () => {
    const stats = corpusStats([buildSearchDoc(''), buildSearchDoc('')]);
    assert.equal(stats.avgdl, 0); // the stats sit on the avgdl === 0 arm
    // The empty document has no terms, so the query term is skipped (tf === 0) and the
    // score is 0. This pins the GOAL's empty-corpus case; the lengthNorm guard itself is
    // exercised by the matching-document case below.
    const score = bm25Score(['x'], buildSearchDoc(''), stats);
    assert.equal(typeof score, 'number');
    assert.equal(score, 0);
  });

  it('bm25Score stays finite and positive on the avgdl === 0 guard when the document matches', () => {
    // Deliberately pair a term-bearing document with empty-corpus stats (avgdl 0) so the
    // matched term reaches the lengthNorm computation. The `avgdl > 0 ? ... : 0` guard
    // clamps lengthNorm to 0, so the term still contributes a finite, positive score.
    const stats = corpusStats([buildSearchDoc(''), buildSearchDoc('')]);
    assert.equal(stats.avgdl, 0); // precondition: the guarded avgdl === 0 branch is taken
    const score = bm25Score(['x'], buildSearchDoc('x x x'), stats);
    // Without the guard, lengthNorm would be 3 / 0 = Infinity and the score would collapse
    // to 0; a finite, positive score is exactly what proves the guard fired.
    assert.ok(Number.isFinite(score) && score > 0, 'guarded lengthNorm keeps the score finite and positive');
    assert.equal(score, 3.9816877093956777); // golden captured from the real bm25Score
  });

  it('rankDocuments scores every document 0 over an empty corpus, keeping input order', () => {
    const docs = [
      { name: 'a', ...buildSearchDoc('') },
      { name: 'b', ...buildSearchDoc('') },
    ];
    const ranked = rankDocuments('anything', docs);
    assert.deepEqual(
      ranked.map(d => ({ name: d.name, score: d.score })),
      [{ name: 'a', score: 0 }, { name: 'b', score: 0 }],
    );
  });
});
