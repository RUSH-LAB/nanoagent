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

// ── Clean BibTeX field-value escaping (pure; unit-tested in tests/bibtex-clean.test.mjs) ──
// LaTeX reserves a handful of characters; emitted unescaped inside a BibTeX field
// value they break compilation or mis-render. Map each special character to the
// escape that yields the literal glyph. `~` and `^` are accent commands on their
// own, so they take the explicit \textasciitilde{} / \textasciicircum{} forms
// rather than a bare backslash, and `\` becomes \textbackslash{}.
const BIBTEX_LATEX_ESCAPES = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  '$': '\\$',
  '#': '\\#',
  '_': '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

// Escape LaTeX special characters in a BibTeX field VALUE and collapse internal
// runs of whitespace to single spaces (trimming the ends) for clean output. One
// regex pass over the original string rewrites every special character at once,
// so a backslash introduced by one escape is never re-escaped by another.
function cleanBibtexValue(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\&%$#_{}~^]/g, ch => BIBTEX_LATEX_ESCAPES[ch]);
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

// ── Page templates: built-in scaffolds served by GET /api/templates ──
// The five built-in page templates (blank, blog, research, math, tutorial) are
// invariant string literals: `{{date}}` and `{{title}}` are client-side
// placeholders, never server-interpolated, and the handler is not wrapped in
// cached(), so the array was genuinely rebuilt on every request. It is pure
// constant data, so it is built once at module load and frozen (matching the
// repo's Object.freeze convention for shared read-only data); the handler serves
// this shared instance and JSON.stringify yields byte-identical output.
const BUILTIN_TEMPLATES = Object.freeze([
  {id: 'blank', name: 'Blank Page', content: '---\ntitle: "Untitled"\ndate: {{date}}\n---\n\n# Untitled\n\n'},
  {id: 'blog', name: 'Blog Post', content: '---\ntitle: "{{title}}"\ndate: {{date}}\nauthors: [zeyu]\ntags: []\n---\n\n# {{title}}\n\n## Introduction\n\n## Main Content\n\n## Conclusion\n'},
  {id: 'research', name: 'Research Paper Summary', content: '---\ntitle: "{{title}}"\ndate: {{date}}\nauthors: [zeyu]\ntags: [research]\n---\n\n# {{title}}\n\n## Summary\n\n## Key Contributions\n\n## Method\n\n## Results\n\n## Discussion\n\n## References\n'},
  {id: 'math', name: 'Math Chapter', content: '---\ntitle: "{{title}}"\n---\n\nimport {Theorem, Definition, Proof, Remark} from \'@site/src/components/Math\';\n\n# {{title}}\n\n<Definition id="def-1" name="Definition Name">\nDefinition content.\n</Definition>\n\n<Theorem id="thm-1" name="Theorem Name">\nTheorem statement.\n</Theorem>\n\n<Proof>\nProof content.\n</Proof>\n'},
  {id: 'tutorial', name: 'Tutorial', content: '---\ntitle: "{{title}}"\nsidebar_position: 1\n---\n\n# {{title}}\n\n## Prerequisites\n\n## Step 1\n\n## Step 2\n\n## Step 3\n\n## Summary\n'},
]);

// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.

const {REFERENCES_SEGS} = require('../paths');
module.exports = async function research_tools_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Preprint tracking: check single reference ──
  if (req.method === 'GET' && pathname === '/api/references/track') {
    const key = url.searchParams.get('key');
    if (!key) return json(res, 400, {error: 'Missing key param'});
    try {
      // Serve the parsed bibliography from the shared, mtime + size aware memo
      // instead of re-reading and re-parsing references.yaml on every request.
      const {loadReferencesCached} = require('./references');
      const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
      // loadReferencesCached swallows a missing or unparseable bibliography and
      // returns {}. Preserve the original 500-on-failure response by reproducing
      // that read only when the memoized parse is empty; the populated happy path
      // is served entirely from the memo and never re-reads or re-parses.
      if (Object.keys(refs).length === 0) {
        const yaml = require('js-yaml');
        yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, ...REFERENCES_SEGS), 'utf8'));
      }
      const entry = refs[key];
      if (!entry) return json(res, 404, {error: 'Reference not found'});

      // Extract arXiv ID from URL or explicit field
      const arxivId = entry.arxivId || (entry.url && entry.url.match(ARXIV_ABS_RE)?.[1]) || null;
      if (!arxivId) return json(res, 200, {published: false, error: 'No arXiv ID found for this reference'});

      const https = require('https');
      const s2Url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=venue,year,externalIds,journal`;
      const data = await new Promise((resolve) => {
        const req = https.get(s2Url, {headers: {'User-Agent': 'MochiLab/1.0'}, timeout: 10000}, (r) => {
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

      if (!data) return json(res, 502, {error: 'Failed to reach Semantic Scholar API'});

      const venue = data.venue || '';
      const isArxiv = !venue || venue === 'ArXiv' || venue === 'arXiv';
      const published = !isArxiv;
      const result = {
        published,
        venue: published ? venue : null,
        doi: data.externalIds?.DOI || null,
        journal: data.journal || null,
        year: data.year || null,
        currentVenue: entry.venue || null,
        tracked: entry.tracked || false,
        publishedVenue: entry.publishedVenue || null,
      };
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, {error: 'Track check failed. Please try again later.'});
    }
  }

  // ── Preprint tracking: update single reference ──
  if (req.method === 'POST' && pathname === '/api/references/track') {
    if (!rateLimit(`track-ref:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody(req);
      const {key} = body;
      if (!key || typeof key !== 'string') return json(res, 400, {error: 'Missing or invalid key'});

      const bibPath = path.join(PROJECT_ROOT, ...REFERENCES_SEGS);
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      const entry = refs[key];
      if (!entry) return json(res, 404, {error: 'Reference not found'});

      const arxivId = entry.arxivId || (entry.url && entry.url.match(ARXIV_ABS_RE)?.[1]) || null;
      if (!arxivId) return json(res, 400, {error: 'No arXiv ID found for this reference'});

      const https = require('https');
      const s2Url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=venue,year,externalIds,journal`;
      const data = await new Promise((resolve) => {
        const req = https.get(s2Url, {headers: {'User-Agent': 'MochiLab/1.0'}, timeout: 10000}, (r) => {
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

      if (!data) return json(res, 502, {error: 'Failed to reach Semantic Scholar API'});

      const venue = data.venue || '';
      const isArxiv = !venue || venue === 'ArXiv' || venue === 'arXiv';

      entry.tracked = true;
      if (!isArxiv) {
        entry.publishedVenue = venue;
        if (data.externalIds?.DOI && !entry.doi) {
          entry.doi = data.externalIds.DOI;
        }
        if (data.journal) {
          entry.journal = data.journal;
        }
      }

      fs.writeFileSync(bibPath, yaml.dump(refs, {lineWidth: -1}), 'utf-8');
      return json(res, 200, {
        success: true,
        published: !isArxiv,
        venue: !isArxiv ? venue : null,
        tracked: true,
        publishedVenue: entry.publishedVenue || null,
      });
    } catch (err) {
      return json(res, 500, {error: 'Track update failed. Please try again later.'});
    }
  }

  // ── Preprint tracking: batch check all ──
  if (req.method === 'POST' && pathname === '/api/references/track-all') {
    if (!rateLimit(`track-all:${req.socket.remoteAddress}`, 2)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const https = require('https');
      const bibPath = path.join(PROJECT_ROOT, ...REFERENCES_SEGS);
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};

      function fetchS2(arxivId) {
        return new Promise((resolve) => {
          const s2Url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=venue,year,externalIds,journal`;
          const req = https.get(s2Url, {headers: {'User-Agent': 'MochiLab/1.0'}, timeout: 10000}, (r) => {
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

      function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

      // Find all entries with arXiv IDs that don't have publishedVenue yet
      const toCheck = [];
      for (const [key, entry] of Object.entries(refs)) {
        const arxivId = entry.arxivId || (entry.url && entry.url.match(ARXIV_ABS_RE)?.[1]) || null;
        if (arxivId && !entry.publishedVenue) {
          toCheck.push({key, entry, arxivId});
        }
      }

      const results = [];
      let updatedCount = 0;

      for (let i = 0; i < toCheck.length; i++) {
        const {key, entry, arxivId} = toCheck[i];
        const data = await fetchS2(arxivId);

        if (data) {
          const venue = data.venue || '';
          const isArxiv = !venue || venue === 'ArXiv' || venue === 'arXiv';
          const published = !isArxiv;

          entry.tracked = true;
          if (published) {
            entry.publishedVenue = venue;
            if (data.externalIds?.DOI && !entry.doi) {
              entry.doi = data.externalIds.DOI;
            }
            if (data.journal) {
              entry.journal = data.journal;
            }
            updatedCount++;
          }

          results.push({key, published, venue: published ? venue : null});
        } else {
          results.push({key, published: false, venue: null, error: 'API request failed'});
        }

        // Rate limiting: 1 request per second
        if (i < toCheck.length - 1) {
          await sleep(1000);
        }
      }

      // Save updated references
      if (updatedCount > 0) {
        fs.writeFileSync(bibPath, yaml.dump(refs, {lineWidth: -1}), 'utf-8');
      }

      return json(res, 200, {checked: toCheck.length, updated: updatedCount, results});
    } catch (err) {
      return json(res, 500, {error: 'Batch track failed. Please try again later.'});
    }
  }

  // ── Recommendations: get paper recommendations based on bibliography ──
  if (req.method === 'GET' && pathname === '/api/recommendations') {
    if (!rateLimit(`recommendations:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const https = require('https');
      // Serve the parsed bibliography from the shared, mtime + size aware memo
      // instead of re-reading and re-parsing references.yaml on every request.
      const {loadReferencesCached} = require('./references');
      const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
      // loadReferencesCached swallows a missing or unparseable bibliography and
      // returns {}. Preserve the original 500-on-failure response by reproducing
      // that read only when the memoized parse is empty; the populated happy path
      // is served entirely from the memo and never re-reads or re-parses.
      if (Object.keys(refs).length === 0) {
        const yaml = require('js-yaml');
        yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, ...REFERENCES_SEGS), 'utf8'));
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

      const bibPath = path.join(PROJECT_ROOT, ...REFERENCES_SEGS);
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
      invalidateCache('stats');

      return json(res, 201, { key: finalKey, success: true });
    } catch (err) {
      return json(res, 400, { error: 'Invalid request: ' + err.message });
    }
  }

  // ── References: import BibTeX ──
  if (req.method === 'POST' && pathname === '/api/references/import-bibtex') {
    if (!rateLimit(`import-bibtex:${req.socket.remoteAddress}`, 5)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody(req);
      const {bibtex} = body;
      if (!bibtex || typeof bibtex !== 'string') return json(res, 400, {error: 'Missing bibtex string'});
      if (bibtex.length > 500000) return json(res, 400, {error: 'BibTeX input too large (max 500KB)'});

      const parsed = parseBibtex(bibtex);
      const bibPath = path.join(PROJECT_ROOT, ...REFERENCES_SEGS);
      let refs;
      try {
        refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      } catch {
        refs = {};
      }

      let added = 0;
      let skipped = 0;
      const errors = [];

      for (const {entryType, citationKey, fields} of parsed) {
        try {
          if (refs[citationKey]) {
            skipped++;
            continue;
          }

          const entry = {
            type: mapBibtexEntryType(entryType),
            title: sanitizeText(fields.title || ''),
            author: parseBibtexAuthors(fields.author),
            year: fields.year ? parseInt(fields.year, 10) || null : null,
          };

          // Venue: journal for articles, booktitle for proceedings
          const venue = fields.journal || fields.booktitle || '';
          if (venue) entry.venue = sanitizeText(venue);

          if (fields.url) entry.url = fields.url;
          if (fields.doi) entry.doi = fields.doi;
          if (fields.pages) entry.pages = fields.pages;
          if (fields.volume) entry.volume = fields.volume;

          refs[citationKey] = entry;
          added++;
        } catch (err) {
          errors.push({key: citationKey, error: err.message});
        }
      }

      if (added > 0) {
        fs.writeFileSync(bibPath, yaml.dump(refs, {lineWidth: -1}), 'utf-8');
        invalidateCache('stats');
      }

      return json(res, 200, {added, skipped, errors});
    } catch (err) {
      return json(res, 400, {error: 'BibTeX import failed: ' + err.message});
    }
  }

  // ── Templates: list available templates ──
  if (req.method === 'GET' && pathname === '/api/templates') {
    try {
      return json(res, 200, {templates: BUILTIN_TEMPLATES}, {cacheControl: 'public, max-age=3600'});
    } catch {
      return json(res, 500, {error: 'Failed to load templates'});
    }
  }

  // ── Full-text search across all content files (BM25-ranked) ──
  if (req.method === 'GET' && pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query) return json(res, 400, {error: 'Missing query'});
    try {
      // Cached index: each doc carries its term-frequency map and length, plus
      // corpus-wide BM25 statistics (N, average length, per-term doc frequency).
      const {docs: searchIndex, stats} = cached('search:index', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
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
                  path: path.relative(PROJECT_ROOT, fullPath),
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

  // ── Multi-file search and replace ──
  if (req.method === 'POST' && pathname === '/api/search/replace') {
    if (!rateLimit(`search-replace:${req.socket.remoteAddress}`, 5)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {search, replace, dryRun} = body;
      if (!search || typeof search !== 'string') return json(res, 400, {error: 'Missing search string'});
      if (search.length > MAX_TEXT_LENGTH) return json(res, 400, {error: 'Search string too long'});
      if (typeof replace !== 'string') return json(res, 400, {error: 'Missing replace string'});
      if (replace.length > MAX_TEXT_LENGTH) return json(res, 400, {error: 'Replace string too long'});
      if (dryRun !== undefined && typeof dryRun !== 'boolean') return json(res, 400, {error: 'dryRun must be a boolean'});
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const changes = [];
      // Accumulate the occurrence total during the walk instead of re-reducing
      // `changes` afterward. The total is a sum of per-file integer counts and
      // integer addition is order independent, so it stays identical to the old
      // second pass.
      let totalOccurrences = 0;
      function scanReplace(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) { scanReplace(fullPath); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            // Split each file once and reuse the array: parts.length - 1 is the
            // occurrence count and parts.join(replace) is the replacement, so a
            // matching file is split a single time instead of twice. String split
            // is pure for a fixed content and needle, so reusing parts stays
            // byte-identical to splitting twice.
            const parts = content.split(search);
            const occurrences = parts.length - 1;
            if (occurrences > 0) {
              const relPath = path.relative(PROJECT_ROOT, fullPath);
              if (!dryRun) {
                const newContent = parts.join(replace);
                fs.writeFileSync(fullPath, newContent, 'utf-8');
              }
              changes.push({path: relPath, occurrences});
              totalOccurrences += occurrences;
            }
          } catch {}
        }
      }
      scanReplace(contentDir);
      invalidateCache('search');
      return json(res, 200, {
        dryRun: !!dryRun,
        filesChanged: changes.length,
        totalOccurrences,
        changes,
      });
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Export all references as BibTeX ──
  if (req.method === 'GET' && pathname === '/api/references/export') {
    try {
      // Serve the parsed bibliography from the shared, mtime + size aware memo
      // instead of re-reading and re-parsing references.yaml on every request.
      const {loadReferencesCached} = require('./references');
      const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
      // loadReferencesCached swallows a missing or unparseable bibliography and
      // returns {}. Preserve the original 500-on-failure response by reproducing
      // that read only when the memoized parse is empty; the populated happy path
      // is served entirely from the memo and never re-reads or re-parses.
      if (Object.keys(refs).length === 0) {
        const yaml = require('js-yaml');
        yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, ...REFERENCES_SEGS), 'utf8'));
      }
      const lines = [];
      for (const [key, entry] of Object.entries(refs)) {
        const authors = (entry.author || []).join(' and ');
        // The BibTeX entry type is the reference type verbatim; recognized types
        // (article, inproceedings, book) and unknown ones alike pass through, and
        // a missing type defaults to 'misc'.
        const bibtexType = entry.type || 'misc';
        const fields = [];
        fields.push(`  title = {${cleanBibtexValue(entry.title || '')}}`);
        if (authors) fields.push(`  author = {${cleanBibtexValue(authors)}}`);
        if (entry.year) fields.push(`  year = {${cleanBibtexValue(entry.year)}}`);
        if (entry.venue) {
          if (bibtexType === 'inproceedings') fields.push(`  booktitle = {${cleanBibtexValue(entry.venue)}}`);
          else if (bibtexType === 'article') fields.push(`  journal = {${cleanBibtexValue(entry.venue)}}`);
          else fields.push(`  howpublished = {${cleanBibtexValue(entry.venue)}}`);
        }
        if (entry.url) fields.push(`  url = {${cleanBibtexValue(entry.url)}}`);
        if (entry.doi) fields.push(`  doi = {${cleanBibtexValue(entry.doi)}}`);
        if (entry.volume) fields.push(`  volume = {${cleanBibtexValue(entry.volume)}}`);
        if (entry.pages) fields.push(`  pages = {${cleanBibtexValue(entry.pages)}}`);
        lines.push(`@${bibtexType}{${key},\n${fields.join(',\n')}\n}`);
      }
      const bibtex = lines.join('\n\n') + '\n';
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="references.bib"',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      return res.end(bibtex);
    } catch (err) {
      return json(res, 500, {error: 'Export failed: ' + err.message});
    }
  }

  // ── Notification counts ──
  if (req.method === 'GET' && pathname === '/api/notifications/counts') {
    const since = url.searchParams.get('since') || '1970-01-01T00:00:00.000Z';

    // Count comments created after `since` across all pages
    const comments = loadJSON(COMMENTS_FILE);
    let commentCount = 0;
    for (const page of Object.keys(comments)) {
      const pageComments = comments[page];
      if (Array.isArray(pageComments)) {
        for (const c of pageComments) {
          if (c.createdAt && c.createdAt > since) commentCount++;
        }
      }
    }

    // Count discussion messages created after `since` across all channels
    const discData = loadJSON(DISCUSSIONS_FILE);
    let discussionCount = 0;
    const messages = discData.messages || {};
    for (const channelId of Object.keys(messages)) {
      const channelMessages = messages[channelId];
      if (Array.isArray(channelMessages)) {
        for (const m of channelMessages) {
          if (m.createdAt && m.createdAt > since) discussionCount++;
        }
      }
    }

    return json(res, 200, {comments: commentCount, discussions: discussionCount});
  }

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
module.exports.cleanBibtexValue = cleanBibtexValue;

// Shared arXiv abstract-URL id matcher, exposed for direct unit testing (see
// tests/next-researchtools-dedup-arxivre.test.mjs). The three preprint-tracking
// handlers extract an arXiv id from a reference URL with it.
module.exports.ARXIV_ABS_RE = ARXIV_ABS_RE;

// Stricter recommendations paper-id matchers, exposed for direct unit testing
// (see tests/next-recommend-paperid-re-hoist.test.mjs). extractRecPaperId in
// GET /api/recommendations uses them to pull a canonical id from a reference URL.
module.exports.REC_ARXIV_ID_RE = REC_ARXIV_ID_RE;
module.exports.REC_DOI_RE = REC_DOI_RE;

// Built-in page templates, exposed for direct unit testing (see
// tests/next-researchtools-templates-hoist.test.mjs). GET /api/templates serves
// this frozen, shared instance instead of rebuilding the array per request.
module.exports.BUILTIN_TEMPLATES = BUILTIN_TEMPLATES;
