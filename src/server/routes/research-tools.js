'use strict';

// ── BM25 lexical ranking helpers (pure; unit-tested in tests/search-bm25.test.mjs) ──
// Standard Okapi BM25 over the cached search index: term-frequency / inverse-
// document-frequency scoring with document-length normalization. Lexical ranking
// only — no embeddings, vectors, cosine similarity, or semantic retrieval (see
// .claude/CONSTRAINTS.md).

const BM25_K1 = 1.5;  // term-frequency saturation point
const BM25_B = 0.75;  // document-length normalization strength
// A token is a run of ASCII alphanumerics, Latin-1/extended letters, or CJK ideographs.
const SEARCH_TOKEN_RE = /[^a-z0-9À-ɏ一-鿿]+/;

// Split text into lowercase terms. The same tokenizer builds the index and parses
// the query so their terms line up.
function tokenizeSearch(text) {
  return String(text).toLowerCase().split(SEARCH_TOKEN_RE).filter(w => w.length > 0);
}

// term -> occurrence count for one document's token list.
function termFrequencies(tokens) {
  const tf = new Map();
  for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1);
  return tf;
}

// Index entry for a document from raw text: its term-frequency map and length
// (total token count) — the two per-document inputs BM25 needs.
function buildSearchDoc(text) {
  const tokens = tokenizeSearch(text);
  return {tf: termFrequencies(tokens), length: tokens.length};
}

// Corpus-wide BM25 statistics over indexed docs: document count N, average
// document length avgdl, and per-term document frequency df (docs containing it).
function corpusStats(docs) {
  const N = docs.length;
  let totalLength = 0;
  const df = new Map();
  for (const doc of docs) {
    totalLength += doc.length || 0;
    for (const term of doc.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  return {N, avgdl: N > 0 ? totalLength / N : 0, df};
}

// BM25 inverse document frequency: ln(1 + (N - df + 0.5) / (df + 0.5)). The
// leading +1 keeps it non-negative; it falls toward 0 as a term approaches
// appearing in every document and rises as the term grows rarer.
function bm25Idf(df, N) {
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

// BM25 score of one document for the given query terms. doc carries {tf, length};
// stats come from corpusStats(). Terms absent from the document add nothing.
function bm25Score(queryTerms, doc, stats, k1 = BM25_K1, b = BM25_B) {
  const {N, avgdl, df} = stats;
  const lengthNorm = avgdl > 0 ? doc.length / avgdl : 0;
  let score = 0;
  for (const term of queryTerms) {
    const tf = doc.tf.get(term) || 0;
    if (tf === 0) continue;
    const idf = bm25Idf(df.get(term) || 0, N);
    score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * lengthNorm));
  }
  return score;
}

// Rank documents by descending BM25 score for a query string. Returns a new
// array of {...doc, score}; pure and side-effect free, so it can be unit tested
// directly on a fixed corpus.
function rankDocuments(query, docs, k1 = BM25_K1, b = BM25_B) {
  const queryTerms = tokenizeSearch(query);
  const stats = corpusStats(docs);
  return docs
    .map(doc => ({doc, score: bm25Score(queryTerms, doc, stats, k1, b)}))
    .sort((a, b2) => b2.score - a.score)
    .map(({doc, score}) => ({...doc, score}));
}

// ── Recommendation seed ranking: premier publication venues ──
// GET /api/recommendations gives entries from these venues a fixed score boost
// when picking the handful of seed papers it expands into recommendations. The
// set is constant and read only (membership tests inside the sort comparator),
// so it is built once at module load and shared across requests instead of being
// rebuilt on every call.
const REC_TOP_VENUES = new Set([
  'NeurIPS', 'ICML', 'ICLR', 'CVPR', 'ICCV', 'ECCV', 'ACL', 'EMNLP',
  'NAACL', 'AAAI', 'IJCAI', 'Nature', 'Science', 'JMLR',
]);

// ── Preprint tracking: shared arXiv abstract-URL id matcher ──
// The three /api/references/track* handlers each pull an arXiv id out of a
// reference URL with this same pattern (capture group 1 is the id). It is
// non-global and only ever used with String.prototype.match, so it carries no
// lastIndex state and one shared module-scope instance is safe across handlers.
// Kept separate from the stricter id pattern in /api/recommendations below.
const ARXIV_ABS_RE = /arxiv\.org\/abs\/([\d.]+)/;

// ── Recommendations: stricter paper-id matchers ──
// extractRecPaperId in GET /api/recommendations pulls a canonical id from a
// reference URL: an arXiv id (capture group 1, version suffix kept) emitted as
// `ArXiv:<id>`, or a DOI (capture group 1) emitted raw. It runs once per
// bibliography entry, and the handler is not wrapped in cached(), so hoisting
// these avoids re-allocating a RegExp per entry on every request. Both are
// non-global and used only with String.prototype.match (no lastIndex state), so
// one shared instance is safe across entries and requests. Intentionally
// stricter than ARXIV_ABS_RE above, whose looser `([\d.]+)` capture and
// different output shape serve the track* handlers.
const REC_ARXIV_ID_RE = /arxiv\.org\/abs\/(\d+\.\d+(?:v\d+)?)/;
const REC_DOI_RE = /doi\.org\/(10\.\d{4,}\/[^\s]+)/;

// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.
module.exports = async function research_tools_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, NOTES_FILE, READING_LISTS_FILE, SNAPSHOTS_FILE, SCHEDULE_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, orgSlugFor, contentRootFor, cacheKey, isValidFilePath, isValidDir, resolveContentPath, contentPathToUrl, sanitizeText, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, collection, scopeFor, _routeDiagnostics
  } = ctx;

  // ── Preprint tracking: check single reference ──
  // ── Preprint tracking: update single reference ──
  // ── Preprint tracking: batch check all ──
  // ── Recommendations: get paper recommendations based on bibliography ──
  if (req.method === 'GET' && pathname === '/api/recommendations') {
    if (!rateLimit(`recommendations:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const https = require('https');
      // Serve the parsed bibliography from the shared, mtime + size aware memo
      // instead of re-reading and re-parsing references.yaml on every request.
      const refs = ctx.references.load(fs, path, contentRootFor(req.auth?.orgId));
      // ctx.references.load swallows a missing or unparseable bibliography and
      // returns {}. Preserve the original 500-on-failure response by reproducing
      // that read only when the memoized parse is empty; the populated happy path
      // is served entirely from the memo and never re-reads or re-parses.
      if (Object.keys(refs).length === 0) {
        const yaml = require('js-yaml');
        yaml.load(fs.readFileSync(path.join(contentRootFor(req.auth?.orgId), 'bibliography', 'references.yaml'), 'utf8'));
      }

      function extractRecPaperId(entry) {
        if (entry.paperId) return entry.paperId;
        if (entry.url) {
          const arxivMatch = entry.url.match(REC_ARXIV_ID_RE);
          if (arxivMatch) return `ArXiv:${arxivMatch[1]}`;
          const doiMatch = entry.url.match(REC_DOI_RE);
          if (doiMatch) return doiMatch[1];
        }
        if (entry.arxivId) return `ArXiv:${entry.arxivId}`;
        if (entry.doi) return entry.doi;
        return null;
      }

      const papersWithIds = [];
      for (const [key, entry] of Object.entries(refs)) {
        const paperId = extractRecPaperId(entry);
        if (paperId) papersWithIds.push({ key, entry, paperId,
          seedScore: (REC_TOP_VENUES.has(entry.venue) ? 10 : 0) + ((entry.year || 2000) - 2000) });
      }

      if (papersWithIds.length === 0) {
        return json(res, 200, { recommendations: [] });
      }

      papersWithIds.sort((a, b) => b.seedScore - a.seedScore);
      const seeds = papersWithIds.slice(0, 5);

      function fetchS2Recs(fetchUrl) {
        return new Promise((resolve) => {
          const req = https.get(fetchUrl, { headers: { 'User-Agent': 'MochiLab/1.0' }, timeout: 10000 }, (r) => {
            if (r.statusCode !== 200) { r.resume(); resolve(null); return; }
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { resolve(null); }
            });
          });
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.on('error', () => resolve(null));
        });
      }

      const existingTitles = new Set(
        Object.values(refs).map(r => (r.title || '').toLowerCase().trim())
      );
      const recMap = new Map();

      for (const seed of seeds) {
        const s2Url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(seed.paperId)}/references?fields=title,authors,year,venue,externalIds&limit=5`;
        const data = await fetchS2Recs(s2Url);
        if (!data || !data.data) continue;
        const seedTitle = seed.entry.title;

        for (const ref of data.data) {
          const cited = ref.citedPaper;
          if (!cited || !cited.title) continue;
          const citedTitle = cited.title;
          const titleLower = citedTitle.toLowerCase().trim();
          if (existingTitles.has(titleLower)) continue;

          if (recMap.has(titleLower)) {
            const existing = recMap.get(titleLower);
            existing.score += 1;
            if (!existing.recommendedBy.includes(seedTitle)) {
              existing.recommendedBy.push(seedTitle);
            }
          } else {
            recMap.set(titleLower, {
              title: citedTitle,
              authors: (cited.authors || []).map(a => a.name || a),
              year: cited.year,
              venue: cited.venue || '',
              arxivId: cited.externalIds?.ArXiv || null,
              score: 1,
              recommendedBy: [seedTitle],
            });
          }
        }
        await new Promise(r => setTimeout(r, 200));
      }

      const recommendations = [...recMap.values()]
        .sort((a, b) => b.score - a.score || (b.year || 0) - (a.year || 0))
        .slice(0, 20);

      return json(res, 200, { recommendations });
    } catch (err) {
      return json(res, 500, { error: 'Failed to fetch recommendations. Please try again later.' });
    }
  }

  // ── Recommendations: add a recommended paper to bibliography ──
  if (req.method === 'POST' && pathname === '/api/recommendations/add') {
    if (!rateLimit(`add-rec:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody(req);
      const { title, authors, year, venue, url: paperUrl, arxivId } = body;
      if (!title || typeof title !== 'string') return json(res, 400, { error: 'Missing or invalid title' });
      if (title.length > 500) return json(res, 400, { error: 'Title must be 500 characters or fewer' });
      if (authors !== undefined && !Array.isArray(authors)) return json(res, 400, { error: 'authors must be an array' });
      if (Array.isArray(authors) && authors.length > 50) return json(res, 400, { error: 'authors exceeds maximum length of 50' });
      if (year !== undefined && typeof year !== 'number' && typeof year !== 'string') return json(res, 400, { error: 'year must be a number or string' });
      if (venue !== undefined && typeof venue !== 'string') return json(res, 400, { error: 'venue must be a string' });
      if (venue && venue.length > 500) return json(res, 400, { error: 'Venue must be 500 characters or fewer' });
      if (paperUrl !== undefined && typeof paperUrl !== 'string') return json(res, 400, { error: 'url must be a string' });
      if (paperUrl && paperUrl.length > 2000) return json(res, 400, { error: 'URL must be 2000 characters or fewer' });
      if (arxivId !== undefined && typeof arxivId !== 'string') return json(res, 400, { error: 'arxivId must be a string' });
      if (arxivId && arxivId.length > 200) return json(res, 400, { error: 'arxivId must be 200 characters or fewer' });

      const authorList = authors || [];
      const firstAuthor = authorList[0] || 'unknown';
      const lastName = firstAuthor.split(' ').pop().toLowerCase().replace(/[^a-z]/g, '');
      const yearStr = year || 'unknown';
      const baseKey = `${lastName}${yearStr}`;

      const bibPath = path.join(contentRootFor(req.auth?.orgId), 'bibliography', 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};

      // titleSlug depends only on `title` (a guaranteed non-empty string by the
      // L489 guard) and the loop never mutates it, so compute it once before the
      // collision loop instead of recomputing the same value on every iteration.
      const titleSlug = (title || '').split(/\s+/).slice(0, 1).join('').toLowerCase().replace(/[^a-z0-9]/g, '');
      let finalKey = baseKey;
      let suffix = 1;
      while (refs[finalKey]) {
        finalKey = `${baseKey}${titleSlug || suffix}`;
        suffix++;
        if (refs[finalKey]) finalKey = `${baseKey}${suffix}`;
      }

      const entry = {
        type: 'article',
        title: sanitizeText(title),
        author: authorList.slice(0, 50).map(a => sanitizeText(String(a))),
        year: year || null,
        venue: venue ? sanitizeText(venue) : '',
      };
      if (paperUrl) entry.url = sanitizeText(paperUrl);
      else if (arxivId) entry.url = `https://arxiv.org/abs/${sanitizeText(arxivId)}`;
      if (arxivId) entry.arxivId = sanitizeText(arxivId);

      refs[finalKey] = entry;
      fs.writeFileSync(bibPath, yaml.dump(refs, { lineWidth: -1 }), 'utf-8');
      invalidateCache(cacheKey(req.auth?.orgId, 'stats'));

      return json(res, 201, { key: finalKey, success: true });
    } catch (err) {
      return json(res, 400, { error: 'Invalid request: ' + err.message });
    }
  }

  // ── References: import BibTeX ──
  // ── Full-text search across all content files (BM25-ranked) ──
  if (req.method === 'GET' && pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query) return json(res, 400, {error: 'Missing query'});
    try {
      // Cached index: each doc carries its term-frequency map and length, plus
      // corpus-wide BM25 statistics (N, average length, per-term doc frequency).
      const {docs: searchIndex, stats} = cached(cacheKey(req.auth?.orgId, 'search:index'), 60000, () => {
        const contentDir = contentRootFor(req.auth?.orgId);
        const docs = [];
        function indexDir(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              indexDir(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                // Same tokenizer for index and query (see tokenizeSearch). Only
                // the raw text is kept (_content); the lower-cased haystack the
                // snippet needs is recomputed on demand below rather than stored,
                // which would double the index's resident string footprint.
                const tokens = tokenizeSearch(content);
                docs.push({
                  path: path.relative(contentRootFor(req.auth?.orgId), fullPath),
                  name: entry.name,
                  words: new Set(tokens),
                  tf: termFrequencies(tokens),
                  length: tokens.length,
                  firstLines: content.slice(0, 500),
                  _content: content,
                });
              } catch {}
            }
          }
        }
        indexDir(contentDir);
        return {docs, stats: corpusStats(docs)};
      });
      // Tokenize the query the same way the index and BM25 scorer do, so the
      // candidate gate and the scorer share one vocabulary. A query word that
      // carries a splitting character (such as the `-` in `gpt-4`) is broken
      // into the tokens the index actually holds, rather than staying one word
      // that no indexed token could contain.
      const queryTerms = tokenizeSearch(query);
      // A query made up only of splitting characters tokenizes to nothing. An empty
      // term list would make the gate below vacuously match every document, so treat
      // it as no match (the same empty result the old whitespace gate returned).
      if (queryTerms.length === 0) return json(res, 200, {results: []});
      // Select candidates (every query term present as a substring of some token),
      // then score each with BM25 over the corpus statistics.
      const candidates = [];
      for (const file of searchIndex) {
        const allTermsMatch = queryTerms.every(term => {
          for (const w of file.words) {
            if (w.includes(term)) return true;
          }
          return false;
        });
        if (!allTermsMatch) continue;
        candidates.push({file, score: bm25Score(queryTerms, file, stats)});
      }
      // Rank by descending BM25 score BEFORE the 50-result cap, then build snippets.
      candidates.sort((a, b) => b.score - a.score);
      const results = [];
      for (const {file, score} of candidates.slice(0, 50)) {
        const idx = file._content.toLowerCase().indexOf(query);
        let snippet;
        if (idx >= 0) {
          // Confirmed phrase match — snippet centered on the occurrence.
          const start = Math.max(0, idx - 50);
          const end = Math.min(file._content.length, idx + query.length + 50);
          snippet = (start > 0 ? '...' : '') +
            file._content.slice(start, end).replace(/\n/g, ' ') +
            (end < file._content.length ? '...' : '');
        } else {
          // Words matched individually but not as an exact phrase — show the opening.
          snippet = file.firstLines.replace(/\n/g, ' ').slice(0, 100) +
            (file.firstLines.length > 100 ? '...' : '');
        }
        results.push({path: file.path, name: file.name, snippet, score});
      }
      return json(res, 200, {results});
    } catch {
      return json(res, 500, {error: 'Search failed'});
    }
  }

  // ── Export all references as BibTeX ──

};

// Pure BM25 ranking helpers, exposed for direct unit testing (see
// tests/search-bm25.test.mjs). They power the /api/search ranking above.
module.exports.tokenizeSearch = tokenizeSearch;
module.exports.termFrequencies = termFrequencies;
module.exports.buildSearchDoc = buildSearchDoc;
module.exports.corpusStats = corpusStats;
module.exports.bm25Idf = bm25Idf;
module.exports.bm25Score = bm25Score;
module.exports.rankDocuments = rankDocuments;

// Pure BibTeX field-value escaper, exposed for direct unit testing (see
// tests/bibtex-clean.test.mjs). It cleans the values emitted by /api/references/export.

// Shared arXiv abstract-URL id matcher, exposed for direct unit testing (see
// tests/next-researchtools-dedup-arxivre.test.mjs). The three preprint-tracking
// handlers extract an arXiv id from a reference URL with it.
module.exports.ARXIV_ABS_RE = ARXIV_ABS_RE;

// Stricter recommendations paper-id matchers, exposed for direct unit testing
// (see tests/next-recommend-paperid-re-hoist.test.mjs). extractRecPaperId in
// GET /api/recommendations uses them to pull a canonical id from a reference URL.
module.exports.REC_ARXIV_ID_RE = REC_ARXIV_ID_RE;
module.exports.REC_DOI_RE = REC_DOI_RE;
