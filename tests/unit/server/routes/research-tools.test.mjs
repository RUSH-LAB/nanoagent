/**
 * server/routes/research-tools.js: BM25 full-text search and search/replace,
 * BibTeX import and export, preprint tracking, paper recommendations, the
 * built-in page templates, and notification counts.
 *
 * Consolidated from the twenty-eight per-branch suites that used to cover this
 * module. The pure helpers (tokenizer, BM25 scorer, BibTeX escaper) are
 * exported, so they are exercised directly rather than through a request.
 */
import {beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {loadRoute, makeCtx, invoke, mockFs, FILES, PROJECT_ROOT} from '../../_harness.mjs';

const require = createRequire(import.meta.url);
const bibliographyProvides = require('../../../../plugins/bibliography/server.js').provides;
const {_resetReferencesCache} = require('../../../../plugins/bibliography/lib/references.js');

const routes = loadRoute('research-tools');
const {COMMENTS_FILE} = FILES;
const at = rel => path.join(PROJECT_ROOT, rel);
const BIB = at('content/bibliography/references.yaml');

/**
 * The bibliography plugin publishes a loader that asks for a reader, because
 * the plugin is not allowed to touch the filesystem itself. The server adapts
 * that reader into the (fs, path, root) call the core handlers make: see
 * referencesForCore in src/server/index.js. This mirrors that adaptation, so
 * GET /api/recommendations runs against the real loader over this suite's
 * fixture fs rather than against a stub of it.
 */
function referencesForCore(provided) {
  const readerFor = (fs, path, root) => {
    const at = relative => path.join(root, 'content', relative);
    return {
      read(relative) {
        try {
          return fs.readFileSync(at(relative), 'utf-8');
        } catch {
          return null;
        }
      },
      stat(relative) {
        try {
          const {mtimeMs, size} = fs.statSync(at(relative));
          return {mtimeMs, size};
        } catch {
          return null;
        }
      },
    };
  };
  return {...provided, load: (fs, path, root) => provided.load(readerFor(fs, path, root))};
}

const {
  tokenizeSearch, termFrequencies, buildSearchDoc, corpusStats,
  bm25Idf, bm25Score, rankDocuments,
  ARXIV_ABS_RE, REC_ARXIV_ID_RE, REC_DOI_RE,
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
  const references = referencesForCore(bibliographyProvides.references);
  return {ctx: makeCtx({fs, references, ...over}), counts, fs};
}

// The loader memoizes on mtime and size, and every fixture starts the mock
// clock at the same instant, so a warm memo would let one test serve the next
// one's parse. Start each test cold, which also makes the memo test below
// prove the memo rather than observe an already-cached parse.
beforeEach(() => _resetReferencesCache());

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

// ── Exported regexes ──────────────────────────────────────────────────────

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
