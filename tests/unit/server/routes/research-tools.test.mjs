/**
 * server/routes/research-tools.js: BM25 full-text search and search/replace,
 * BibTeX import and export, preprint tracking, paper recommendations, the
 * built-in page templates, and notification counts.
 *
 * Consolidated from the twenty-eight per-branch suites that used to cover this
 * module. The pure helpers (tokenizer, BM25 scorer, BibTeX escaper) are
 * exported, so they are exercised directly rather than through a request.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {loadRoute, makeCtx, invoke, mockFs, FILES, PROJECT_ROOT} from '../../_harness.mjs';

const routes = loadRoute('research-tools');
const {COMMENTS_FILE, DISCUSSIONS_FILE} = FILES;
const at = rel => path.join(PROJECT_ROOT, rel);
const BIB = at('content/bibliography/references.yaml');

const {
  tokenizeSearch, termFrequencies, buildSearchDoc, corpusStats,
  bm25Idf, bm25Score, rankDocuments, cleanBibtexValue,
  ARXIV_ABS_RE, REC_ARXIV_ID_RE, REC_DOI_RE, BUILTIN_TEMPLATES,
} = routes;

function fsCtx(files, over = {}) {
  const base = mockFs(files);
  const counts = {read: 0, readdir: 0, write: 0};
  const fs = {
    ...base,
    readFileSync: p => { counts.read++; return base.readFileSync(p); },
    readdirSync: (p, o) => { counts.readdir++; return base.readdirSync(p, o); },
    writeFileSync: (p, d) => { counts.write++; return base.writeFileSync(p, d); },
  };
  return {ctx: makeCtx({fs, ...over}), counts, fs};
}

function bib(entries) {
  return Object.entries(entries).map(([key, e]) => {
    const lines = [`${key}:`];
    for (const [k, v] of Object.entries(e)) {
      if (Array.isArray(v)) { lines.push(`  ${k}:`); for (const item of v) lines.push(`    - ${item}`); }
      else lines.push(`  ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
    }
    return lines.join('\n');
  }).join('\n') + '\n';
}

// ── Pure BM25 helpers ─────────────────────────────────────────────────────

describe('BM25 helpers', () => {
  it('exposes the pure ranking helpers alongside the route handler', () => {
    assert.equal(typeof routes, 'function');
    for (const fn of [tokenizeSearch, termFrequencies, buildSearchDoc, corpusStats, bm25Idf, bm25Score, rankDocuments]) {
      assert.equal(typeof fn, 'function');
    }
  });

  const TOKENS = [
    {name: 'lowercases and splits on punctuation', input: 'Hello, World! GPT-4', want: ['hello', 'world', 'gpt', '4']},
    {name: 'keeps Latin-1 and extended letters', input: 'café naïve', want: ['café', 'naïve']},
    {name: 'keeps CJK ideographs', input: '量子 计算', want: ['量子', '计算']},
    {name: 'drops an all-punctuation string', input: '--- !!! ...', want: []},
  ];
  for (const {name, input, want} of TOKENS) {
    it(`tokenizeSearch ${name}`, () => assert.deepEqual(tokenizeSearch(input), want));
  }

  it('termFrequencies counts each term', () => {
    assert.deepEqual([...termFrequencies(['a', 'b', 'a']).entries()], [['a', 2], ['b', 1]]);
  });

  it('buildSearchDoc pairs the frequency map with the token count', () => {
    const doc = buildSearchDoc('alpha beta alpha');
    assert.equal(doc.length, 3);
    assert.equal(doc.tf.get('alpha'), 2);
  });

  it('corpusStats reports the document count, average length and document frequency', () => {
    const docs = [buildSearchDoc('alpha beta'), buildSearchDoc('alpha gamma delta')];
    const stats = corpusStats(docs);
    assert.equal(stats.N, 2);
    assert.equal(stats.avgdl, 2.5);
    assert.equal(stats.df.get('alpha'), 2);
    assert.equal(stats.df.get('beta'), 1);
  });

  it('bm25Idf falls toward zero for a ubiquitous term and rises for a rare one', () => {
    const common = bm25Idf(100, 100);
    const rare = bm25Idf(1, 100);
    assert.ok(common >= 0 && common < 0.1);
    assert.ok(rare > common * 10);
  });

  // The defensive arms: an empty corpus, an all-empty corpus, and a query term
  // the document does not carry.
  it('handles an empty corpus without dividing by zero', () => {
    const stats = corpusStats([]);
    assert.deepEqual([stats.N, stats.avgdl, stats.df.size], [0, 0, 0]);
    const empty = buildSearchDoc('');
    assert.deepEqual([empty.length, empty.tf.size], [0, 0]);
    assert.equal(bm25Score(['missing'], empty, stats), 0);
  });

  it('stays finite when every document is empty, so avgdl is zero with N above zero', () => {
    const docs = [buildSearchDoc(''), buildSearchDoc('')];
    const stats = corpusStats(docs);
    assert.deepEqual([stats.N, stats.avgdl], [2, 0]);
    // The lengthNorm guard yields 0, so a matching document still scores finite
    // and positive rather than collapsing to Infinity or NaN.
    const match = buildSearchDoc('alpha');
    const score = bm25Score(['alpha'], match, {N: 2, avgdl: 0, df: new Map([['alpha', 1]])});
    assert.ok(Number.isFinite(score) && score > 0);
  });

  it('rankDocuments scores every document zero over an empty corpus, keeping input order', () => {
    const docs = [{...buildSearchDoc(''), id: 'a'}, {...buildSearchDoc(''), id: 'b'}];
    const ranked = rankDocuments('anything', docs);
    assert.deepEqual(ranked.map(d => [d.id, d.score]), [['a', 0], ['b', 0]]);
  });

  it('scores zero when no query term occurs in the document', () => {
    const docs = [buildSearchDoc('alpha beta')];
    assert.equal(bm25Score(['gamma'], docs[0], corpusStats(docs)), 0);
  });

  it('ranks by term frequency, then by length normalisation', () => {
    const focused = {...buildSearchDoc('quantum quantum quantum'), id: 'focused'};
    const buried = {...buildSearchDoc(`quantum ${'filler '.repeat(50)}`), id: 'buried'};
    const ranked = rankDocuments('quantum', [buried, focused]);
    assert.deepEqual(ranked.map(d => d.id), ['focused', 'buried']);
  });

  it('ranks a shorter document higher at equal term frequency', () => {
    const short = {...buildSearchDoc('quantum alpha'), id: 'short'};
    const long = {...buildSearchDoc(`quantum ${'alpha '.repeat(30)}`), id: 'long'};
    const ranked = rankDocuments('quantum', [long, short]);
    assert.deepEqual(ranked.map(d => d.id), ['short', 'long']);
  });

  it('lets a distinctive term outscore one present in every document', () => {
    const docs = [
      {...buildSearchDoc('common rare'), id: 'hasRare'},
      {...buildSearchDoc('common filler'), id: 'noRare'},
      {...buildSearchDoc('common filler'), id: 'alsoNoRare'},
    ];
    const ranked = rankDocuments('rare', docs);
    assert.equal(ranked[0].id, 'hasRare');
    assert.ok(ranked[0].score > ranked[1].score);
  });

  // Relative ordering alone leaves k1 and b free, so pin one absolute score
  // computed from the documented constants (k1 1.5, b 0.75).
  it('scores a known corpus to the exact BM25 value', () => {
    const docs = [buildSearchDoc('alpha beta'), buildSearchDoc('alpha gamma delta')];
    const stats = corpusStats(docs);
    assert.equal(bm25Score(['alpha'], docs[0], stats), 0.20035335911423577);
    assert.equal(bm25Score(['beta'], docs[0], stats), 0.7617001984175222);
  });

  it('sums contributions across multiple query terms', () => {
    const docs = [buildSearchDoc('alpha beta gamma')];
    const stats = corpusStats(docs);
    const one = bm25Score(['alpha'], docs[0], stats);
    const two = bm25Score(['alpha', 'beta'], docs[0], stats);
    assert.ok(two > one);
  });

  it('returns results sorted by descending numeric score', () => {
    const docs = [buildSearchDoc('a'), buildSearchDoc('a a'), buildSearchDoc('b')];
    const ranked = rankDocuments('a', docs);
    const scores = ranked.map(d => d.score);
    assert.deepEqual(scores, [...scores].sort((x, y) => y - x));
    for (const s of scores) assert.equal(typeof s, 'number');
  });
});

// ── cleanBibtexValue ──────────────────────────────────────────────────────

describe('cleanBibtexValue', () => {
  const CASES = [
    {name: 'ampersand, underscore and percent', input: 'A & B_c 50%', want: 'A \\& B\\_c 50\\%'},
    {name: 'dollar, hash and braces', input: '$5 #1 {x}', want: '\\$5 \\#1 \\{x\\}'},
    // Tilde and caret are accent commands on their own, so they take the
    // explicit text forms rather than a bare backslash.
    {name: 'tilde and caret as text commands', input: 'a~b c^d', want: 'a\\textasciitilde{}b c\\textasciicircum{}d'},
    {name: 'a literal backslash', input: 'a\\b', want: 'a\\textbackslash{}b'},
    // One regex pass over the original means an introduced backslash is never
    // re-escaped by a later replacement.
    {name: 'without double-escaping what it introduces', input: '&', want: '\\&'},
    {name: 'several specials together', input: 'A&B_C%D$E#F{G}H~I^J', want: 'A\\&B\\_C\\%D\\$E\\#F\\{G\\}H\\textasciitilde{}I\\textasciicircum{}J'},
    {name: 'collapsing whitespace runs and trimming', input: '  a   b\n\tc  ', want: 'a b c'},
    {name: 'ordinary text untouched', input: 'Plain title here', want: 'Plain title here'},
    {name: 'null coerced to empty', input: null, want: ''},
    {name: 'undefined coerced to empty', input: undefined, want: ''},
    {name: 'a number coerced to its digits', input: 2024, want: '2024'},
  ];
  for (const {name, input, want} of CASES) {
    it(`escapes ${name}`, () => assert.equal(cleanBibtexValue(input), want));
  }

  it('produces a compile-safe field line for a messy value', () => {
    // The braces in \\textasciitilde{} and friends are part of the escape, so
    // this pins the whole output rather than scanning for bare specials.
    const out = cleanBibtexValue('Cost & benefit: 50% of x_1 {sic} ~approx ^2 \\path');
    assert.equal(out, 'Cost \\& benefit: 50\\% of x\\_1 \\{sic\\} \\textasciitilde{}approx \\textasciicircum{}2 \\textbackslash{}path');
  });
});

// ── Exported regexes and templates ────────────────────────────────────────

describe('exported matchers', () => {
  it('ARXIV_ABS_RE is non-global and captures a loose id', () => {
    assert.equal(ARXIV_ABS_RE.global, false);
    assert.equal('https://arxiv.org/abs/2301.12345'.match(ARXIV_ABS_RE)[1], '2301.12345');
    // The loose [\d.]+ capture stops at the first non-digit, dropping a version.
    assert.equal('https://arxiv.org/abs/2301.12345v2'.match(ARXIV_ABS_RE)[1], '2301.12345');
    assert.equal('https://example.com/paper'.match(ARXIV_ABS_RE), null);
  });

  it('REC_ARXIV_ID_RE is non-global and keeps the version suffix', () => {
    assert.equal(REC_ARXIV_ID_RE.global, false);
    assert.equal('https://arxiv.org/abs/2301.12345'.match(REC_ARXIV_ID_RE)[1], '2301.12345');
    assert.equal('https://arxiv.org/abs/2301.12345v2'.match(REC_ARXIV_ID_RE)[1], '2301.12345v2');
    assert.equal('https://example.com/paper'.match(REC_ARXIV_ID_RE), null);
  });

  it('REC_DOI_RE is non-global and captures the DOI', () => {
    assert.equal(REC_DOI_RE.global, false);
    assert.equal('https://doi.org/10.1000/xyz123'.match(REC_DOI_RE)[1], '10.1000/xyz123');
    assert.equal('https://example.com/paper'.match(REC_DOI_RE), null);
  });

  it('BUILTIN_TEMPLATES is a frozen, stable five-entry array', () => {
    assert.equal(Object.isFrozen(BUILTIN_TEMPLATES), true);
    assert.equal(BUILTIN_TEMPLATES.length, 5);
    assert.deepEqual(BUILTIN_TEMPLATES.map(t => t.id), ['blank', 'blog', 'research', 'math', 'tutorial']);
    assert.strictEqual(loadRoute('research-tools').BUILTIN_TEMPLATES, BUILTIN_TEMPLATES);
  });
});

describe('GET /api/templates', () => {
  it('serves the shared instance with a one-hour cacheControl', async () => {
    const r = await invoke(routes, {path: '/api/templates'});
    assert.equal(r.status, 200);
    assert.strictEqual(r.payload.templates, BUILTIN_TEMPLATES);
    assert.deepEqual(r.replies[0].opts, {cacheControl: 'public, max-age=3600'});
  });

  it('returns the same reference on a back-to-back request', async () => {
    const a = await invoke(routes, {path: '/api/templates'});
    const b = await invoke(routes, {path: '/api/templates'});
    assert.strictEqual(b.payload.templates, a.payload.templates);
  });
});

// ── Preprint tracking ─────────────────────────────────────────────────────

describe('GET /api/references/track', () => {
  const REFS = {plain: {title: 'Plain', venue: 'V'}, withUrl: {title: 'WithUrl', url: 'https://arxiv.org/abs/2301.12345'}};

  for (const [label, query] of [['an omitted key', {}], ['an empty key', {key: ''}]]) {
    it(`returns 400 for ${label}, touching no files`, async () => {
      const {ctx, counts} = fsCtx({[BIB]: bib(REFS)});
      const r = await invoke(routes, {path: '/api/references/track', query, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Missing key param'}]);
      assert.equal(counts.read, 0);
    });
  }

  it('returns 404 for a key absent from the bibliography', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {path: '/api/references/track', query: {key: 'nope'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reference not found'}]);
  });

  it('reports no arXiv id for an entry with neither an id nor an arXiv url', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {path: '/api/references/track', query: {key: 'plain'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {published: false, error: 'No arXiv ID found for this reference'}]);
  });

  it('memoizes the bibliography parse across two requests', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib(REFS)});
    await invoke(routes, {path: '/api/references/track', query: {key: 'plain'}, ctx});
    const after = counts.read;
    await invoke(routes, {path: '/api/references/track', query: {key: 'plain'}, ctx});
    assert.equal(counts.read, after, 'the second lookup reuses the shared memo');
  });

  // The memo swallows a broken bibliography and returns {}, so the handler
  // re-reads on an empty result to preserve the original 500.
  const FALLBACKS = [
    {name: 'a broken parse', files: {[BIB]: '\tnot: [valid'}, status: 500, error: 'Track check failed. Please try again later.'},
    {name: 'a missing file', files: {}, status: 500, error: 'Track check failed. Please try again later.'},
    {name: 'an empty but valid bibliography', files: {[BIB]: ''}, status: 404, error: 'Reference not found'},
  ];
  for (const {name, files, status, error} of FALLBACKS) {
    it(`returns ${status} for ${name}`, async () => {
      const {ctx} = fsCtx(files);
      const r = await invoke(routes, {path: '/api/references/track', query: {key: 'plain'}, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
    });
  }
});

describe('POST /api/references/track', () => {
  const REFS = {plain: {title: 'Plain', venue: 'V'}};

  it('returns 429 with the track-ref key, never reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/references/track', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'track-ref:127.0.0.1', maxPerMinute: 10}]);
    assert.equal(reads, 0);
  });

  const GUARDS = [
    {name: 'an omitted key', body: {}, status: 400, error: 'Missing or invalid key'},
    {name: 'a non-string key', body: {key: 7}, status: 400, error: 'Missing or invalid key'},
    {name: 'a key absent from the bibliography', body: {key: 'nope'}, status: 404, error: 'Reference not found'},
    {name: 'an entry with no arXiv id', body: {key: 'plain'}, status: 400, error: 'No arXiv ID found for this reference'},
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`rejects ${name} without writing`, async () => {
      const {ctx, counts} = fsCtx({[BIB]: bib(REFS)});
      const r = await invoke(routes, {method: 'POST', path: '/api/references/track', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.equal(counts.write, 0);
    });
  }

  it('returns 500 when the bibliography read throws, before any write', async () => {
    const base = mockFs({[BIB]: bib(REFS)});
    let writes = 0;
    const fs = {...base, readFileSync() { throw new Error('unreadable'); }, writeFileSync() { writes++; }};
    const r = await invoke(routes, {method: 'POST', path: '/api/references/track', body: {key: 'plain'}, ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Track update failed. Please try again later.'}]);
    assert.equal(writes, 0);
  });
});

describe('POST /api/references/track-all', () => {
  it('returns 429 with the track-all key at limit 2, before any IO', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib({a: {title: 'A'}})}, {rateLimitAllow: false});
    const r = await invoke(routes, {method: 'POST', path: '/api/references/track-all', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'track-all:127.0.0.1', maxPerMinute: 2}]);
    assert.equal(counts.read, 0);
  });

  it('returns 500 when the bibliography read throws, before any write or network call', async () => {
    const base = mockFs({[BIB]: bib({a: {title: 'A'}})});
    let writes = 0;
    const fs = {...base, readFileSync() { throw new Error('unreadable'); }, writeFileSync() { writes++; }};
    const r = await invoke(routes, {method: 'POST', path: '/api/references/track-all', ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Batch track failed. Please try again later.'}]);
    assert.equal(writes, 0);
  });

  it('reports nothing checked when no entry carries an arXiv id', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib({a: {title: 'A', venue: 'V'}})});
    const r = await invoke(routes, {method: 'POST', path: '/api/references/track-all', ctx});
    assert.deepEqual([r.status, r.payload], [200, {checked: 0, updated: 0, results: []}]);
    assert.equal(counts.write, 0);
  });
});

// ── Recommendations ───────────────────────────────────────────────────────

describe('GET /api/recommendations', () => {
  it('returns 429 with the recommendations key, before any IO', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib({a: {title: 'A'}})}, {rateLimitAllow: false});
    const r = await invoke(routes, {method: 'GET', path: '/api/recommendations', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'recommendations:127.0.0.1', maxPerMinute: 10}]);
    assert.equal(counts.read, 0);
  });

  it('returns an empty list without a network call when no entry resolves to a paper id', async () => {
    const {ctx} = fsCtx({[BIB]: bib({a: {title: 'A', venue: 'V'}, b: {title: 'B', url: 'https://example.com/p'}})});
    const r = await invoke(routes, {method: 'GET', path: '/api/recommendations', ctx});
    assert.deepEqual([r.status, r.payload], [200, {recommendations: []}]);
  });

  it('memoizes the bibliography parse across two requests', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib({a: {title: 'A', venue: 'V'}})});
    await invoke(routes, {method: 'GET', path: '/api/recommendations', ctx});
    const after = counts.read;
    await invoke(routes, {method: 'GET', path: '/api/recommendations', ctx});
    assert.equal(counts.read, after);
  });

  const FALLBACKS = [
    {name: 'a broken parse', files: {[BIB]: '\tnot: [valid'}, status: 500},
    {name: 'a missing file', files: {}, status: 500},
    {name: 'an empty but valid bibliography', files: {[BIB]: ''}, status: 200},
  ];
  for (const {name, files, status} of FALLBACKS) {
    it(`returns ${status} for ${name}`, async () => {
      const {ctx} = fsCtx(files);
      const r = await invoke(routes, {method: 'GET', path: '/api/recommendations', ctx});
      assert.equal(r.status, status);
      if (status === 500) assert.deepEqual(r.payload, {error: 'Failed to fetch recommendations. Please try again later.'});
      else assert.deepEqual(r.payload, {recommendations: []});
    });
  }

  // Once any entry resolves to a paper id the handler proceeds to Semantic
  // Scholar, which a unit test must not reach, so the id-resolution rules are
  // pinned through the exported matchers above and the handler is driven only
  // on the no-ids early return.
  it('treats an entry with no resolvable id as unseedable', async () => {
    const refs = {
      noUrl: {title: 'NoUrl', venue: 'V'},
      badUrl: {title: 'BadUrl', url: 'https://example.com/paper'},
    };
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {method: 'GET', path: '/api/recommendations', ctx});
    assert.deepEqual([r.status, r.payload], [200, {recommendations: []}]);
  });

  it('exposes the route as the module default export', () => {
    assert.equal(typeof routes, 'function');
    assert.equal(routes.length, 5);
  });
});

describe('POST /api/recommendations/add', () => {
  const OK = {title: 'A New Paper', authors: ['Ada Lovelace'], year: 2024};
  const empty = () => fsCtx({[BIB]: ''});

  it('returns 429 with the add-rec key, never reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/recommendations/add', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'add-rec:127.0.0.1', maxPerMinute: 20}]);
    assert.equal(reads, 0);
  });

  const GUARDS = [
    {name: 'an omitted title', body: {}, error: 'Missing or invalid title'},
    {name: 'a non-string title', body: {title: 7}, error: 'Missing or invalid title'},
    {name: 'a title over 500 characters', body: {title: 't'.repeat(501)}, error: 'Title must be 500 characters or fewer'},
    {name: 'a non-array authors', body: {...OK, authors: 'Ada'}, error: 'authors must be an array'},
    {name: 'an authors array over 50 entries', body: {...OK, authors: new Array(51).fill('A')}, error: 'authors exceeds maximum length of 50'},
    {name: 'a year that is neither number nor string', body: {...OK, year: {}}, error: 'year must be a number or string'},
    {name: 'a non-string venue', body: {...OK, venue: 7}, error: 'venue must be a string'},
    {name: 'a venue over 500 characters', body: {...OK, venue: 'v'.repeat(501)}, error: 'Venue must be 500 characters or fewer'},
    {name: 'a non-string url', body: {...OK, url: 7}, error: 'url must be a string'},
    {name: 'a url over 2000 characters', body: {...OK, url: 'u'.repeat(2001)}, error: 'URL must be 2000 characters or fewer'},
    {name: 'a non-string arxivId', body: {...OK, arxivId: 7}, error: 'arxivId must be a string'},
    {name: 'an arxivId over 200 characters', body: {...OK, arxivId: 'a'.repeat(201)}, error: 'arxivId must be 200 characters or fewer'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without writing or invalidating`, async () => {
      const {ctx, counts} = empty();
      const r = await invoke(routes, {method: 'POST', path: '/api/recommendations/add', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.equal(counts.write, 0);
      assert.deepEqual(ctx.calls.invalidateCache, []);
    });
  }

  it('writes the entry, invalidates stats and returns the key', async () => {
    const {ctx, counts, fs} = empty();
    const r = await invoke(routes, {method: 'POST', path: '/api/recommendations/add', body: OK, ctx});
    assert.deepEqual([r.status, r.payload], [201, {key: 'lovelace2024', success: true}]);
    assert.equal(counts.write, 1);
    assert.deepEqual(ctx.calls.invalidateCache, ['stats']);
    assert.ok(fs.readFileSync(BIB).includes('lovelace2024'));
  });

  it('derives the url from an arxivId when no url is given', async () => {
    const {ctx, fs} = empty();
    await invoke(routes, {method: 'POST', path: '/api/recommendations/add', body: {...OK, arxivId: '2301.12345'}, ctx});
    const written = fs.readFileSync(BIB);
    assert.ok(written.includes('https://arxiv.org/abs/2301.12345'));
  });

  // The key is firstAuthorLastName + year, then the title slug, then a counter.
  const COLLISIONS = [
    {name: 'no collision uses the plain base key', existing: {}, want: 'lovelace2024'},
    {name: 'a collision appends the title slug', existing: {lovelace2024: {title: 'Old'}}, want: 'lovelace2024a'},
    {name: 'both taken falls back to a numeric suffix', existing: {lovelace2024: {title: 'Old'}, lovelace2024a: {title: 'Older'}}, want: 'lovelace20242'},
  ];
  for (const {name, existing, want} of COLLISIONS) {
    it(`resolves the key: ${name}`, async () => {
      const {ctx} = fsCtx({[BIB]: Object.keys(existing).length ? bib(existing) : ''});
      const r = await invoke(routes, {method: 'POST', path: '/api/recommendations/add', body: OK, ctx});
      assert.equal(r.payload.key, want);
    });
  }

  it('falls back to a numeric suffix when the title slugifies to empty', async () => {
    const {ctx} = fsCtx({[BIB]: bib({lovelace2024: {title: 'Old'}})});
    const r = await invoke(routes, {method: 'POST', path: '/api/recommendations/add', body: {...OK, title: '!!!'}, ctx});
    assert.equal(r.payload.key, 'lovelace20241');
  });

  it('uses "unknown" for a missing author and year', async () => {
    const {ctx} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {method: 'POST', path: '/api/recommendations/add', body: {title: 'Solo'}, ctx});
    assert.equal(r.payload.key, 'unknownunknown');
  });

  it('returns a prefixed 400 when the stored bibliography cannot be parsed', async () => {
    const base = mockFs({[BIB]: bib({})});
    const fs = {...base, readFileSync() { throw new Error('disk on fire'); }};
    const ctx = makeCtx({fs});
    const r = await invoke(routes, {method: 'POST', path: '/api/recommendations/add', body: OK, ctx});
    assert.equal(r.status, 400);
    assert.ok(r.payload.error.startsWith('Invalid request: '));
    assert.deepEqual(ctx.calls.invalidateCache, []);
  });
});

// ── BibTeX import ─────────────────────────────────────────────────────────

describe('POST /api/references/import-bibtex', () => {
  const ARTICLE = '@article{smith2020,\n  title = {A Paper},\n  author = {Ada Lovelace},\n  year = {2020},\n  journal = {Nature},\n  url = {http://x},\n  doi = {10.1/x},\n  pages = {1-10},\n  volume = {5}\n}';
  const PROCEEDINGS = '@inproceedings{jones2021,\n  title = {Another},\n  booktitle = {NeurIPS},\n  year = {2021}\n}';

  it('returns 429 without touching anything', async () => {
    const {ctx, counts} = fsCtx({[BIB]: ''}, {rateLimitAllow: false});
    const r = await invoke(routes, {method: 'POST', path: '/api/references/import-bibtex', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual([counts.read, counts.write], [0, 0]);
  });

  const GUARDS = [
    {name: 'an omitted bibtex field', body: {}, error: 'Missing bibtex string'},
    {name: 'a non-string bibtex field', body: {bibtex: 7}, error: 'Missing bibtex string'},
    {name: 'input larger than 500KB', body: {bibtex: 'x'.repeat(500001)}, error: 'BibTeX input too large (max 500KB)'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name}`, async () => {
      const {ctx, counts} = fsCtx({[BIB]: ''});
      const r = await invoke(routes, {method: 'POST', path: '/api/references/import-bibtex', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.equal(counts.write, 0);
    });
  }

  it('adds an article, writing once and invalidating stats', async () => {
    const {ctx, counts, fs} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: ARTICLE}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {added: 1, skipped: 0, errors: []}]);
    assert.equal(counts.write, 1);
    assert.deepEqual(ctx.calls.invalidateCache, ['stats']);
    const written = fs.readFileSync(BIB);
    for (const token of ['smith2020', 'A Paper', 'Nature', '10.1/x', '1-10']) assert.ok(written.includes(token), token);
  });

  it('maps the entry type and takes the venue from booktitle', async () => {
    const {ctx, fs} = fsCtx({[BIB]: ''});
    await invoke(routes, {method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: PROCEEDINGS}, ctx});
    const written = fs.readFileSync(BIB);
    assert.ok(written.includes('inproceedings'));
    assert.ok(written.includes('NeurIPS'));
  });

  it('prefers journal over booktitle when an entry carries both', async () => {
    const both = '@article{both2022,\n  title = {Both},\n  journal = {Nature},\n  booktitle = {NeurIPS}\n}';
    const {ctx, fs} = fsCtx({[BIB]: ''});
    await invoke(routes, {method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: both}, ctx});
    const written = fs.readFileSync(BIB);
    assert.ok(written.includes('Nature'));
    assert.equal(written.includes('NeurIPS'), false);
  });

  it('skips an entry whose key already exists while still adding the new one', async () => {
    const {ctx} = fsCtx({[BIB]: bib({smith2020: {title: 'Existing'}})});
    const r = await invoke(routes, {method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: `${ARTICLE}\n\n${PROCEEDINGS}`}, ctx});
    assert.deepEqual(r.payload, {added: 1, skipped: 1, errors: []});
  });

  it('writes nothing when every entry is a duplicate', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib({smith2020: {title: 'Existing'}})});
    const r = await invoke(routes, {method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: ARTICLE}, ctx});
    assert.deepEqual(r.payload, {added: 0, skipped: 1, errors: []});
    assert.equal(counts.write, 0);
    assert.deepEqual(ctx.calls.invalidateCache, []);
  });

  it('still imports when the existing bibliography is malformed YAML', async () => {
    const {ctx} = fsCtx({[BIB]: '\tnot: [valid'});
    const r = await invoke(routes, {method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: ARTICLE}, ctx});
    assert.deepEqual(r.payload, {added: 1, skipped: 0, errors: []});
  });

  it('returns a prefixed 400 when the parser throws', async () => {
    const {ctx} = fsCtx({[BIB]: ''}, {parseBibtex() { throw new Error('bad bibtex'); }});
    const r = await invoke(routes, {method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: ARTICLE}, ctx});
    assert.equal(r.status, 400);
    assert.ok(r.payload.error.startsWith('BibTeX import failed: '));
  });
});

// ── BibTeX export ─────────────────────────────────────────────────────────

describe('GET /api/references/export', () => {
  const REFS = {
    art: {type: 'article', title: 'An Article', author: ['Ada Lovelace', 'Grace Hopper'], year: 2020, venue: 'Nature', doi: '10.1/x', volume: '5', pages: '1-10'},
    proc: {type: 'inproceedings', title: 'A Paper', venue: 'NeurIPS', url: 'http://x'},
    book: {type: 'book', title: 'A Book', venue: 'Some Press'},
    typeless: {title: 'No Type', venue: 'Somewhere'},
    weird: {type: 'phdthesis', title: 'A Thesis', venue: 'A University'},
  };

  it('emits one entry per reference, mapping the venue field by type', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {path: '/api/references/export', ctx});
    const body = r.written.body;
    assert.ok(body.includes('@article{art,'));
    assert.ok(body.includes('  journal = {Nature}'));
    assert.ok(body.includes('  author = {Ada Lovelace and Grace Hopper}'));
    assert.ok(body.includes('  volume = {5}'));
    assert.ok(body.includes('  pages = {1-10}'));
    assert.ok(body.includes('@inproceedings{proc,'));
    assert.ok(body.includes('  booktitle = {NeurIPS}'));
    assert.ok(body.includes('  howpublished = {Some Press}'), 'a book uses howpublished');
    // An unknown type passes through verbatim; a missing one defaults to misc.
    assert.ok(body.includes('@phdthesis{weird,'));
    assert.ok(body.includes('@misc{typeless,'));
  });

  it('sends the BibTeX content type and attachment headers', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {path: '/api/references/export', ctx});
    assert.deepEqual(r.written.headers, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="references.bib"',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
  });

  it('escapes LaTeX specials in every field', async () => {
    const {ctx} = fsCtx({[BIB]: bib({k: {type: 'misc', title: 'Cost & 50% of x_1'}})});
    const r = await invoke(routes, {path: '/api/references/export', ctx});
    assert.ok(r.written.body.includes('title = {Cost \\& 50\\% of x\\_1}'));
  });

  it('memoizes the parse across two exports', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib(REFS)});
    await invoke(routes, {path: '/api/references/export', ctx});
    const after = counts.read;
    await invoke(routes, {path: '/api/references/export', ctx});
    assert.equal(counts.read, after);
  });

  it('returns an empty bib for an empty but valid bibliography', async () => {
    const {ctx} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {path: '/api/references/export', ctx});
    assert.equal(r.written.status, 200);
    assert.equal(r.written.body, '\n');
  });

  // The catch composes err.message into the reply, so both failure shapes are
  // the same prefixed 500.
  for (const [label, files] of [['a broken parse', {[BIB]: '\tnot: [valid'}], ['a missing file', {}]]) {
    it(`returns a prefixed 500 for ${label}`, async () => {
      const {ctx} = fsCtx(files);
      const r = await invoke(routes, {path: '/api/references/export', ctx});
      assert.equal(r.status, 500);
      assert.ok(r.payload.error.startsWith('Export failed: '));
      assert.equal(r.written, null);
    });
  }
});

// ── Search ────────────────────────────────────────────────────────────────

describe('GET /api/search', () => {
  // Declared worst-first so the walk order is the reverse of the score order,
  // which makes the ranking sort observable.
  const TREE = {
    [at('content/buried.md')]: `${'filler '.repeat(200)} quantum ${'filler '.repeat(200)} entanglement`,
    [at('content/split.md')]: `quantum ${'filler '.repeat(20)}entanglement`,
    [at('content/focused.md')]: 'quantum quantum quantum entanglement',
    [at('content/other.md')]: 'gardening horticulture botany',
    [at('content/.hidden.md')]: 'quantum entanglement',
    // Carries only the first term of a two-term query.
    [at('content/half.md')]: 'quantum alone',
  };

  for (const [label, query] of [['no q param', {}], ['an empty q', {q: ''}], ['a whitespace-only q', {q: '   '}]]) {
    it(`returns 400 for ${label} before building the index`, async () => {
      const {ctx, counts} = fsCtx(TREE);
      const r = await invoke(routes, {path: '/api/search', query, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Missing query'}]);
      assert.equal(counts.readdir, 0);
    });
  }

  it('ranks matches by descending BM25 score', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/search', query: {q: 'quantum'}, ctx});
    assert.equal(r.status, 200);
    const paths = r.payload.results.map(x => x.path);
    // half.md carries the single query term too, so it ranks with the rest.
    assert.deepEqual(paths, ['content/focused.md', 'content/half.md', 'content/split.md', 'content/buried.md']);
    const scores = r.payload.results.map(x => x.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    assert.equal(paths.includes('content/.hidden.md'), false, 'dot files are not indexed');
  });

  it('requires every query term to match, excluding a partial match', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/search', query: {q: 'quantum entanglement'}, ctx});
    const paths = r.payload.results.map(x => x.path);
    assert.equal(paths.includes('content/half.md'), false, 'one of two terms is not enough');
    assert.ok(paths.includes('content/focused.md'));
  });

  it('tokenizes a hyphenated query into the terms the index holds', async () => {
    const files = {[at('content/gpt.md')]: 'the gpt 4 model', [at('content/plain.md')]: 'nothing relevant'};
    const {ctx} = fsCtx(files);
    // The old whitespace gate kept "gpt-4" as one word, which no indexed token
    // could contain; tokenizing the query splits it into terms the index holds.
    const r = await invoke(routes, {path: '/api/search', query: {q: 'gpt-4'}, ctx});
    assert.deepEqual(r.payload.results.map(x => x.path), ['content/gpt.md']);
  });

  it('returns no results for an all-punctuation query rather than everything', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/search', query: {q: '---'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {results: []}]);
  });

  it('returns an empty list when nothing matches', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/search', query: {q: 'nonexistentterm'}, ctx});
    assert.deepEqual(r.payload.results, []);
  });

  it('centres the snippet on an exact phrase match, else shows the opening', async () => {
    const files = {
      [at('content/phrase.md')]: `${'lead '.repeat(30)}exact phrase here${' tail'.repeat(30)}`,
      [at('content/apart.md')]: `${'exact '.repeat(2)}${'filler '.repeat(60)}phrase`,
    };
    const {ctx} = fsCtx(files);
    const phrase = await invoke(routes, {path: '/api/search', query: {q: 'exact phrase'}, ctx});
    const byPath = Object.fromEntries(phrase.payload.results.map(x => [x.path, x.snippet]));
    // The window is 50 characters either side, which is ten "lead " repeats.
    assert.ok(byPath['content/phrase.md'].includes(`${'lead '.repeat(10)}exact phrase here`));
    assert.ok(byPath['content/phrase.md'].startsWith('...'), 'a mid-document match is elided on both sides');
    // The words match individually but not as a phrase, so the opening is shown.
    assert.ok(byPath['content/apart.md'].startsWith('exact exact filler'));
    assert.ok(byPath['content/apart.md'].endsWith('...'));
  });

  it('caps the result list at fifty', async () => {
    const files = Object.fromEntries(Array.from({length: 60}, (_, i) => [at(`content/p${i}.md`), 'quantum']));
    const {ctx} = fsCtx(files);
    const r = await invoke(routes, {path: '/api/search', query: {q: 'quantum'}, ctx});
    assert.equal(r.payload.results.length, 50);
  });

  it('caches the index under "search:index" with a 60000 ms TTL', async () => {
    let seen;
    const {ctx, counts} = fsCtx(TREE, {cached: (k, t, fn) => { seen = [k, t]; return ctx.cache[k] ?? (ctx.cache[k] = fn()); }});
    await invoke(routes, {path: '/api/search', query: {q: 'quantum'}, ctx});
    assert.deepEqual(seen, ['search:index', 60000]);
    const after = counts.readdir;
    await invoke(routes, {path: '/api/search', query: {q: 'entanglement'}, ctx});
    assert.equal(counts.readdir, after, 'the second query reuses the index');
  });

  it('indexes each document with its frequency map, length and raw content only', async () => {
    let indexed;
    const {ctx} = fsCtx(TREE, {cached: (k, t, fn) => { indexed = fn(); return indexed; }});
    await invoke(routes, {path: '/api/search', query: {q: 'quantum'}, ctx});
    const [doc] = indexed.docs;
    assert.deepEqual(Object.keys(doc).sort(), ['_content', 'firstLines', 'length', 'name', 'path', 'tf', 'words']);
    // No duplicate lower-cased copy is kept; the snippet recomputes it on demand.
    assert.equal('_lower' in doc, false);
  });

  it('returns 500 when the index walk throws', async () => {
    const ctx = makeCtx({fs: {readdirSync() { throw new Error('unreadable'); }}});
    const r = await invoke(routes, {path: '/api/search', query: {q: 'quantum'}, ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Search failed'}]);
  });
});

// ── Search and replace ────────────────────────────────────────────────────

describe('POST /api/search/replace', () => {
  const TREE = {
    [at('content/a.md')]: 'foo bar foo',
    [at('content/sub/b.md')]: 'foo once',
    [at('content/c.md')]: 'nothing here',
    [at('content/_skip.md')]: 'foo skipped',
    [at('content/notes.txt')]: 'foo skipped',
  };

  it('returns 429 without touching the filesystem', async () => {
    const {ctx, counts} = fsCtx(TREE, {rateLimitAllow: false});
    const r = await invoke(routes, {method: 'POST', path: '/api/search/replace', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual([counts.readdir, counts.write], [0, 0]);
  });

  const GUARDS = [
    {name: 'an omitted search', body: {replace: 'x'}, error: 'Missing search string'},
    {name: 'an empty search', body: {search: '', replace: 'x'}, error: 'Missing search string'},
    {name: 'a non-string search', body: {search: 7, replace: 'x'}, error: 'Missing search string'},
    {name: 'a search one over the text cap', body: {search: 's'.repeat(10001), replace: 'x'}, error: 'Search string too long'},
    {name: 'an omitted replace', body: {search: 'foo'}, error: 'Missing replace string'},
    {name: 'a non-string replace', body: {search: 'foo', replace: 7}, error: 'Missing replace string'},
    {name: 'a replace one over the text cap', body: {search: 'foo', replace: 'r'.repeat(10001)}, error: 'Replace string too long'},
    {name: 'a non-boolean dryRun', body: {search: 'foo', replace: 'x', dryRun: 'yes'}, error: 'dryRun must be a boolean'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without touching the filesystem`, async () => {
      const {ctx, counts} = fsCtx(TREE);
      const r = await invoke(routes, {method: 'POST', path: '/api/search/replace', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual([counts.readdir, counts.write], [0, 0]);
    });
  }

  // The caps are exclusive, so a string of exactly MAX_TEXT_LENGTH passes.
  it('accepts a search and replace of exactly the text cap', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {method: 'POST', path: '/api/search/replace', body: {search: 's'.repeat(10000), replace: 'r'.repeat(10000), dryRun: true}, ctx});
    assert.equal(r.status, 200);
  });

  it('reports occurrences without writing on a dry run', async () => {
    const {ctx, counts, fs} = fsCtx(TREE);
    const r = await invoke(routes, {method: 'POST', path: '/api/search/replace', body: {search: 'foo', replace: 'baz', dryRun: true}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.dryRun, true);
    assert.equal(r.payload.filesChanged, 2);
    assert.equal(r.payload.totalOccurrences, 3);
    assert.equal(r.payload.totalOccurrences, r.payload.changes.reduce((s, c) => s + c.occurrences, 0));
    assert.equal(counts.write, 0);
    assert.equal(fs.readFileSync(at('content/a.md')), 'foo bar foo');
  });

  it('rewrites each matching file on a real run', async () => {
    const {ctx, counts, fs} = fsCtx(TREE);
    const r = await invoke(routes, {method: 'POST', path: '/api/search/replace', body: {search: 'foo', replace: 'baz'}, ctx});
    assert.equal(r.payload.dryRun, false);
    assert.equal(r.payload.totalOccurrences, 3);
    assert.equal(counts.write, 2, 'only the matching files are written');
    assert.equal(fs.readFileSync(at('content/a.md')), 'baz bar baz');
    assert.equal(fs.readFileSync(at('content/sub/b.md')), 'baz once');
    // Underscore files and other extensions are skipped by the walk.
    assert.equal(fs.readFileSync(at('content/_skip.md')), 'foo skipped');
    assert.deepEqual(ctx.calls.invalidateCache, ['search']);
  });

  it('reports a zero total when nothing matches', async () => {
    const {ctx, counts} = fsCtx(TREE);
    const r = await invoke(routes, {method: 'POST', path: '/api/search/replace', body: {search: 'nomatch', replace: 'x'}, ctx});
    assert.deepEqual([r.payload.filesChanged, r.payload.totalOccurrences, r.payload.changes], [0, 0, []]);
    assert.equal(counts.write, 0);
  });

  it('returns 400 when the body cannot be read, with no filesystem IO', async () => {
    const {ctx, counts} = fsCtx(TREE, {readBody: async () => { throw new Error('bad json'); }});
    const r = await invoke(routes, {method: 'POST', path: '/api/search/replace', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid request'}]);
    assert.deepEqual([counts.readdir, counts.write], [0, 0]);
  });
});

// ── Notification counts ───────────────────────────────────────────────────

describe('GET /api/notifications/counts', () => {
  const STORE = {
    [COMMENTS_FILE]: {
      '/p': [{createdAt: '2026-01-02T00:00:00.000Z'}, {createdAt: '2026-01-01T00:00:00.000Z'}, {}],
      bad: 'not-an-array',
    },
    [DISCUSSIONS_FILE]: {
      messages: {
        general: [{createdAt: '2026-01-02T00:00:00.000Z'}, {createdAt: '2026-01-01T00:00:00.000Z'}, {}],
        bad: 'not-an-array',
      },
    },
  };

  it('counts entries created strictly after the given since', async () => {
    const r = await invoke(routes, {path: '/api/notifications/counts', query: {since: '2026-01-01T00:00:00.000Z'}, ctx: makeCtx({store: STORE})});
    // The boundary is exclusive on both counters, so the comment and the
    // message equal to `since` are not counted, and entries without a
    // createdAt are ignored.
    assert.deepEqual([r.status, r.payload], [200, {comments: 1, discussions: 1}]);
  });

  it('defaults since to the Unix epoch, counting even a pre-2000 entry', async () => {
    const store = {
      [COMMENTS_FILE]: {'/p': [{createdAt: '1985-01-01T00:00:00.000Z'}]},
      [DISCUSSIONS_FILE]: {messages: {general: [{createdAt: '1985-01-01T00:00:00.000Z'}]}},
    };
    const r = await invoke(routes, {path: '/api/notifications/counts', ctx: makeCtx({store})});
    assert.deepEqual(r.payload, {comments: 1, discussions: 1});
  });

  it('counts every timestamped entry when no since is given', async () => {
    const r = await invoke(routes, {path: '/api/notifications/counts', ctx: makeCtx({store: STORE})});
    assert.deepEqual(r.payload, {comments: 2, discussions: 2});
  });

  it('returns zeroes when the discussions document has no messages map', async () => {
    const store = {[COMMENTS_FILE]: {}, [DISCUSSIONS_FILE]: {}};
    const r = await invoke(routes, {path: '/api/notifications/counts', ctx: makeCtx({store})});
    assert.deepEqual(r.payload, {comments: 0, discussions: 0});
  });
});
