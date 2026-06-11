import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

// research-tools.js is CommonJS; load it the way the other server tests do.
const require = createRequire(import.meta.url);
const researchTools = require('../server/routes/research-tools.js');
const {
  tokenizeSearch,
  termFrequencies,
  buildSearchDoc,
  corpusStats,
  bm25Idf,
  bm25Score,
  rankDocuments,
} = researchTools;

describe('BM25 search ranking', () => {
  it('exposes the route handler plus pure ranking helpers on module.exports', () => {
    assert.equal(typeof researchTools, 'function', 'default export is the route handler');
    for (const fn of ['tokenizeSearch', 'termFrequencies', 'buildSearchDoc',
      'corpusStats', 'bm25Idf', 'bm25Score', 'rankDocuments']) {
      assert.equal(typeof researchTools[fn], 'function', `${fn} is exported`);
    }
  });

  it('tokenizes to lowercase terms and counts term frequencies', () => {
    assert.deepEqual(tokenizeSearch('Hello, WORLD hello!'), ['hello', 'world', 'hello']);
    const tf = termFrequencies(tokenizeSearch('a a b'));
    assert.equal(tf.get('a'), 2);
    assert.equal(tf.get('b'), 1);
  });

  it('computes corpus statistics: document count, average length, and document frequency', () => {
    const docs = [buildSearchDoc('a b c'), buildSearchDoc('a b'), buildSearchDoc('a')];
    const { N, avgdl, df } = corpusStats(docs);
    assert.equal(N, 3);
    assert.equal(avgdl, (3 + 2 + 1) / 3);
    assert.equal(df.get('a'), 3); // present in every doc
    assert.equal(df.get('b'), 2);
    assert.equal(df.get('c'), 1);
  });

  it('gives a term in every document near-zero idf, and rare terms much higher idf', () => {
    const N = 10;
    const idfUbiquitous = bm25Idf(N, N); // appears in all N docs
    const idfRare = bm25Idf(1, N);       // appears in a single doc
    assert.ok(idfUbiquitous > 0, 'idf stays non-negative');
    assert.ok(idfUbiquitous < 0.05, `ubiquitous-term idf ${idfUbiquitous} should be near zero`);
    assert.ok(idfRare > 1.5, `rare-term idf ${idfRare} should be large`);
    assert.ok(idfRare > idfUbiquitous * 20, 'rare terms dominate common terms');
  });

  it('scores zero when no query term occurs in the document', () => {
    const doc = buildSearchDoc('completely unrelated content here');
    const stats = corpusStats([doc]);
    assert.equal(bm25Score(['missing'], doc, stats), 0);
    assert.equal(bm25Score([], doc, stats), 0);
  });

  // The headline ordering from the GOAL: a doc with 5 mentions in 200 words
  // outranks 1 mention in a short title, which outranks 1 mention buried in 2000 words.
  it('ranks by term frequency and length normalization (focused > title > buried)', () => {
    const docs = [
      { name: 'buried', ...buildSearchDoc('bm25 ' + 'lorem '.repeat(1999)) },        // tf 1, len 2000
      { name: 'title', ...buildSearchDoc('bm25 short focused note title here') },     // tf 1, len 6
      { name: 'focused', ...buildSearchDoc('bm25 '.repeat(5) + 'lorem '.repeat(195)) }, // tf 5, len 200
    ];
    const ranked = rankDocuments('bm25', docs);
    assert.deepEqual(ranked.map(d => d.name), ['focused', 'title', 'buried']);
    assert.ok(ranked[0].score > ranked[1].score, 'focused outscores title');
    assert.ok(ranked[1].score > ranked[2].score, 'title outscores buried');
    assert.ok(ranked[2].score > 0, 'a real match still scores above zero');
  });

  it('ranks shorter documents higher at equal term frequency (length normalization)', () => {
    const docs = [
      { name: 'long', ...buildSearchDoc('x x ' + 'pad '.repeat(498)) }, // tf 2, len 500
      { name: 'short', ...buildSearchDoc('x x ' + 'pad '.repeat(48)) },  // tf 2, len 50
    ];
    const ranked = rankDocuments('x', docs);
    assert.deepEqual(ranked.map(d => d.name), ['short', 'long']);
    assert.ok(ranked[0].score > ranked[1].score);
  });

  it('raises the score with higher term frequency at equal length', () => {
    const docs = [
      { name: 'few', ...buildSearchDoc('x ' + 'pad '.repeat(99)) },          // tf 1, len 100
      { name: 'many', ...buildSearchDoc('x '.repeat(5) + 'pad '.repeat(95)) }, // tf 5, len 100
    ];
    const ranked = rankDocuments('x', docs);
    assert.deepEqual(ranked.map(d => d.name), ['many', 'few']);
    assert.ok(ranked[0].score > ranked[1].score);
  });

  it('lets a distinctive term outscore a term present in every document (idf effect)', () => {
    const docs = [
      { name: 'a', ...buildSearchDoc('alpha the the the ' + 'x '.repeat(20)) },
      { name: 'b', ...buildSearchDoc('the the ' + 'y '.repeat(20)) },
      { name: 'c', ...buildSearchDoc('the ' + 'z '.repeat(20)) },
    ];
    const topUbiquitous = Math.max(...rankDocuments('the', docs).map(d => d.score)); // df = 3 of 3
    const topDistinctive = Math.max(...rankDocuments('alpha', docs).map(d => d.score)); // df = 1 of 3
    assert.ok(topDistinctive > topUbiquitous, 'rarer term yields a higher top score');
  });

  it('sums BM25 contributions across multiple query terms', () => {
    const docs = [
      { name: 'both', ...buildSearchDoc('alpha beta ' + 'pad '.repeat(30)) },
      { name: 'alphaOnly', ...buildSearchDoc('alpha ' + 'pad '.repeat(31)) },
      { name: 'betaOnly', ...buildSearchDoc('beta ' + 'pad '.repeat(31)) },
      { name: 'neither', ...buildSearchDoc('pad '.repeat(32)) },
    ];
    const ranked = rankDocuments('alpha beta', docs);
    assert.equal(ranked[0].name, 'both', 'matching both terms ranks first');
    const both = ranked.find(d => d.name === 'both');
    const alphaOnly = ranked.find(d => d.name === 'alphaOnly');
    assert.ok(both.score > alphaOnly.score, 'two matched terms beat one');
    assert.equal(ranked[ranked.length - 1].name, 'neither');
    assert.equal(ranked[ranked.length - 1].score, 0, 'a doc with no query term scores zero');
  });

  it('returns results sorted by descending score with a numeric score field', () => {
    const docs = [
      { name: 'low', ...buildSearchDoc('match ' + 'pad '.repeat(500)) },
      { name: 'high', ...buildSearchDoc('match match match ' + 'pad '.repeat(20)) },
    ];
    const ranked = rankDocuments('match', docs);
    for (let i = 1; i < ranked.length; i++) {
      assert.equal(typeof ranked[i].score, 'number');
      assert.ok(ranked[i - 1].score >= ranked[i].score, 'scores are non-increasing');
    }
    assert.equal(ranked[0].name, 'high');
  });
});
