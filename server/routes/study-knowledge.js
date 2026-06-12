'use strict';
// Route module organized from server.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server.js detects a sent response via res.writableEnded.

// Shared YAML front-matter matcher for the leading `---` block of a content
// file. It is non-global and used only with String.prototype.match, so it
// holds no lastIndex state and one shared instance is safe across handlers.
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

// Shared front-matter title matcher. After FRONTMATTER_RE isolates the leading
// `---` block, three content-scan handlers (GET /api/content-clusters,
// /api/file/link-suggestions, and /api/search/suggest) pull the `title:` field
// out of that block with this pattern. It accepts an optional single or double
// quote around the value, which keeps it distinct from QUICKNOTES_TITLE_RE below
// (that one allows a double quote only). It is non-global and non-sticky and is
// read only through String.prototype.match, so it holds no lastIndex state and
// one shared module-scope instance is safe across requests.
const FRONTMATTER_TITLE_RE = /^title:\s*["']?(.+?)["']?\s*$/m;

// Wiki-link matcher for GET /api/file/link-suggestions, collecting the set of
// page names a file already links to. Unlike FRONTMATTER_RE this regex is global
// (/g), so it carries lastIndex state between exec() calls; the handler resets
// lastIndex to 0 before its loop, so one shared module-scope instance stays safe
// across requests and the per-request allocation is removed.
const LINKSUGGEST_WIKI_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

// Per-file parser regexes for GET /api/quicknotes, which scans the blog post
// directory and, for each file, matches the title front matter, the date prefix
// of the filename, and the body that follows the front matter. That handler is
// not wrapped in cached(), so its loop runs per request over up to ~50 files;
// one shared instance each is built once at module load instead of re-allocating
// the literals every iteration. All three are non-global and non-sticky and are
// read only through String.prototype.match, so they hold no lastIndex state and
// stay safe to share across requests.
const QUICKNOTES_TITLE_RE = /^title:\s*"?(.+?)"?\s*$/m;
const QUICKNOTES_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
const QUICKNOTES_BODY_RE = /---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)/;

// Prototype-pollution guard for PUT /api/preferences. These keys would corrupt
// Object.prototype if accepted as a userId or preference key. The Set is never
// mutated and is read only through .has(), so one shared module-scope instance
// is safe across requests and is built once at module load.
const DANGEROUS_PREFERENCE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

module.exports = async function study_knowledge_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, collectFeedItems, parseFeedItem, cached, invalidateCache, cleanStalePresence, rateLimit, formatAuthorAPA, formatAuthorMLA, formatAuthorIEEE, formatCitation, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Spaced repetition flashcards ──
  if (req.method === 'POST' && pathname === '/api/flashcards') {
    if (!rateLimit(`flashcards:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {userId, front, back, tags, sourcePath} = body;
      if (!front || typeof front !== 'string') return json(res, 400, {error: 'Missing or invalid front'});
      if (!back || typeof back !== 'string') return json(res, 400, {error: 'Missing or invalid back'});
      if (front.length > 5000) return json(res, 400, {error: 'front must be 5000 characters or fewer'});
      if (back.length > 5000) return json(res, 400, {error: 'back must be 5000 characters or fewer'});
      if (userId !== undefined && typeof userId !== 'string') return json(res, 400, {error: 'userId must be a string'});
      if (userId && userId.length > 200) return json(res, 400, {error: 'userId must be 200 characters or fewer'});
      if (tags !== undefined && (!Array.isArray(tags) || !tags.every(t => typeof t === 'string'))) return json(res, 400, {error: 'tags must be an array of strings'});
      if (sourcePath !== undefined && typeof sourcePath !== 'string') return json(res, 400, {error: 'sourcePath must be a string'});
      if (sourcePath && sourcePath.length > 500) return json(res, 400, {error: 'sourcePath must be 500 characters or fewer'});
      const data = loadJSON(FLASHCARDS_FILE);
      const uid = userId || 'default';
      if (!Object.hasOwn(data, uid)) data[uid] = [];
      const card = {
        id: `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        front: sanitizeText(front),
        back: sanitizeText(back),
        tags: Array.isArray(tags) ? tags.slice(0, 10).map(t => sanitizeText(t)) : [],
        sourcePath: sourcePath ? sanitizeText(sourcePath).slice(0, 500) : null,
        interval: 1,
        easeFactor: 2.5,
        repetitions: 0,
        nextReview: new Date().toISOString().slice(0, 10),
        createdAt: new Date().toISOString(),
      };
      data[uid].push(card);
      saveJSON(FLASHCARDS_FILE, data);
      return json(res, 200, {success: true, card});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/flashcards') {
    const userId = url.searchParams.get('userId') || 'default';
    const data = loadJSON(FLASHCARDS_FILE);
    const cards = Object.hasOwn(data, userId) ? data[userId] : [];
    return json(res, 200, {cards, total: cards.length});
  }

  if (req.method === 'GET' && pathname === '/api/flashcards/due') {
    const userId = url.searchParams.get('userId') || 'default';
    const today = new Date().toISOString().slice(0, 10);
    const data = loadJSON(FLASHCARDS_FILE);
    const cards = (Object.hasOwn(data, userId) ? data[userId] : []).filter(c => c.nextReview <= today);
    return json(res, 200, {cards, dueCount: cards.length});
  }

  if (req.method === 'POST' && pathname === '/api/flashcards/review') {
    if (!rateLimit(`fc-review:${req.socket.remoteAddress}`, 120)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {userId, cardId, quality} = body;
      if (!cardId || typeof cardId !== 'string') return json(res, 400, {error: 'Missing or invalid cardId'});
      if (cardId.length > 200) return json(res, 400, {error: 'cardId must be 200 characters or fewer'});
      if (quality == null || typeof quality !== 'number' || !isFinite(quality)) return json(res, 400, {error: 'Missing or invalid quality'});
      if (quality < 0 || quality > 5) return json(res, 400, {error: 'quality must be between 0 and 5'});
      if (userId !== undefined && typeof userId !== 'string') return json(res, 400, {error: 'userId must be a string'});
      if (userId && userId.length > 200) return json(res, 400, {error: 'userId must be 200 characters or fewer'});
      const q = Math.max(0, Math.min(5, quality));
      const uid = userId || 'default';
      const data = loadJSON(FLASHCARDS_FILE);
      const card = (Object.hasOwn(data, uid) ? data[uid] : []).find(c => c.id === cardId);
      if (!card) return json(res, 404, {error: 'Card not found'});
      if (q >= 3) {
        if (card.repetitions === 0) card.interval = 1;
        else if (card.repetitions === 1) card.interval = 6;
        else card.interval = Math.round(card.interval * card.easeFactor);
        card.repetitions++;
      } else {
        card.repetitions = 0;
        card.interval = 1;
      }
      card.easeFactor = Math.max(1.3, card.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
      const next = new Date();
      next.setDate(next.getDate() + card.interval);
      card.nextReview = next.toISOString().slice(0, 10);
      card.lastReviewed = new Date().toISOString();
      saveJSON(FLASHCARDS_FILE, data);
      return json(res, 200, {success: true, card});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'DELETE' && pathname === '/api/flashcards') {
    try {
      const body = await readBody(req);
      const {userId, cardId} = body;
      if (!cardId) return json(res, 400, {error: 'Missing cardId'});
      const uid = userId || 'default';
      const data = loadJSON(FLASHCARDS_FILE);
      if (!Object.hasOwn(data, uid)) return json(res, 404, {error: 'Card not found'});
      const idx = data[uid].findIndex(c => c.id === cardId);
      if (idx === -1) return json(res, 404, {error: 'Card not found'});
      data[uid].splice(idx, 1);
      saveJSON(FLASHCARDS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Citation context extraction ──
  if (req.method === 'GET' && pathname === '/api/references/context') {
    const key = url.searchParams.get('key');
    if (!key) return json(res, 400, {error: 'Missing key'});
    try {
      // Serve the parsed bibliography from the shared, mtime + size aware memo
      // instead of re-reading and re-parsing references.yaml on every request.
      // This read sits OUTSIDE the content-scan cache below (it feeds the 404
      // guard), so it previously ran on every request, including cache hits.
      const {loadReferencesCached} = require('./references');
      const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
      // loadReferencesCached swallows a missing or unparseable bibliography and
      // returns {}. Preserve the original 500-on-failure response by reproducing
      // that read only when the memoized parse is empty: a genuinely broken or
      // missing file still throws to the catch, while a legitimately empty file
      // re-reads cleanly and falls through to the unchanged 404 below.
      if (Object.keys(refs).length === 0) {
        const yaml = require('js-yaml');
        yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8'));
      }
      if (!refs[key]) return json(res, 404, {error: 'Reference not found'});
      // Cache the per-key content scan so repeated requests for the same citation
      // key skip the recursive walk that reads and regex-scans every content file.
      // The cache key includes `key`, so each citation key is its own entry. The
      // references.yaml read, the missing-key 400, and the not-found 404 all stay
      // OUTSIDE the cache, so only a successful 200 scan is memoized; the per-key
      // CITE_PATTERN is built inside the closure from the captured `key`. Mirrors
      // the sibling cached('linksuggest:' + filePath, ...) in this file.
      const contexts = cached('refcontext:' + key, 30000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const contexts = [];
        const CITE_PATTERN = new RegExp(`\\[@[^\\]]*\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^\\]]*\\]`, 'g');
        function scanContexts(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanContexts(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              CITE_PATTERN.lastIndex = 0;
              let m;
              while ((m = CITE_PATTERN.exec(content)) !== null) {
                const start = Math.max(0, m.index - 100);
                const end = Math.min(content.length, m.index + m[0].length + 100);
                const context = content.slice(start, end).replace(/\n/g, ' ').trim();
                contexts.push({
                  file: path.relative(PROJECT_ROOT, fp),
                  context: (start > 0 ? '...' : '') + context + (end < content.length ? '...' : ''),
                  position: m.index,
                });
              }
            } catch {}
          }
        }
        scanContexts(contentDir);
        return contexts;
      });
      return json(res, 200, {key, title: refs[key].title, contexts, totalCitations: contexts.length});
    } catch {
      return json(res, 500, {error: 'Context extraction failed'});
    }
  }

  // ── Topic clustering: group pages by shared themes ──
  if (req.method === 'GET' && pathname === '/api/content-clusters') {
    try {
      const clusters = cached('content-clusters', 120000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const pages = [];
        function scanPages(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanPages(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const tags = [];
              if (fmMatch) {
                const tm = fmMatch[1].match(FRONTMATTER_TITLE_RE);
                if (tm) title = tm[1];
                const tgm = fmMatch[1].match(/^tags:\s*\[([^\]]*)\]/m);
                if (tgm) tgm[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(t => tags.push(t));
              }
              pages.push({path: path.relative(PROJECT_ROOT, fp), title, tags});
            } catch {}
          }
        }
        scanPages(contentDir);
        const tagGroups = {};
        for (const page of pages) {
          for (const tag of page.tags) {
            if (!tagGroups[tag]) tagGroups[tag] = [];
            tagGroups[tag].push({path: page.path, title: page.title});
          }
        }
        const clusters = Object.entries(tagGroups)
          .filter(([, pages]) => pages.length >= 2)
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 20)
          .map(([tag, pages]) => ({theme: tag, pageCount: pages.length, pages: pages.slice(0, 10)}));
        return clusters;
      });
      return json(res, 200, {clusters, total: clusters.length});
    } catch {
      return json(res, 500, {error: 'Clustering failed'});
    }
  }

  // ── Link suggestions: suggest pages to link from a file ──
  if (req.method === 'GET' && pathname === '/api/file/link-suggestions') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // Cache the per-path link-suggestions result so repeated requests for the
      // same file skip the recursive scanLinks walk that reads and word-scores
      // every content candidate. The source readFileSync and the
      // LINKSUGGEST_WIKI_RE.lastIndex reset stay inside the closure, so a missing
      // source still throws to the outer catch (the 404 is never cached) and the
      // shared module-scope regex stays safe. Mirrors the /api/file/related cache.
      const result = cached('linksuggest:' + filePath, 30000, () => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
        const existingLinks = new Set();
        let m;
        LINKSUGGEST_WIKI_RE.lastIndex = 0;
        while ((m = LINKSUGGEST_WIKI_RE.exec(content)) !== null) existingLinks.add(m[1].trim().toLowerCase());
        const contentWords = new Set(content.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4));
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const suggestions = [];
        function scanLinks(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanLinks(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            const rel = path.relative(PROJECT_ROOT, fp);
            if (rel === filePath) continue;
            const pageName = entry.name.replace(/\.(mdx?|md)$/, '').toLowerCase();
            if (existingLinks.has(pageName)) continue;
            if (contentWords.has(pageName) || pageName.split('-').some(w => w.length > 4 && contentWords.has(w))) {
              try {
                const c = fs.readFileSync(fp, 'utf-8');
                const fm = c.match(FRONTMATTER_RE);
                let title = entry.name.replace(/\.(mdx?|md)$/, '');
                if (fm) {
                  const tm = fm[1].match(FRONTMATTER_TITLE_RE);
                  if (tm) title = tm[1];
                }
                suggestions.push({path: rel, title, pageName});
              } catch {}
            }
          }
        }
        scanLinks(contentDir);
        return {suggestions: suggestions.slice(0, 15), total: suggestions.length};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Paper comparison ──
  if (req.method === 'GET' && pathname === '/api/references/compare') {
    const key1 = url.searchParams.get('key1');
    const key2 = url.searchParams.get('key2');
    if (!key1 || !key2) return json(res, 400, {error: 'Missing key1 or key2'});
    try {
      // Serve the parsed bibliography from the shared, mtime + size aware memo
      // instead of re-reading and re-parsing references.yaml on every request.
      const {loadReferencesCached} = require('./references');
      const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
      // loadReferencesCached swallows a missing or unparseable bibliography and
      // returns {}. Preserve the original 500-on-failure response by reproducing
      // that read only when the memoized parse is empty: a genuinely broken or
      // missing file still throws to the catch, while a legitimately empty file
      // re-reads cleanly and falls through to the unchanged 404 below.
      if (Object.keys(refs).length === 0) {
        const yaml = require('js-yaml');
        yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8'));
      }
      const paper1 = refs[key1];
      const paper2 = refs[key2];
      if (!paper1 || !paper2) return json(res, 404, {error: 'One or both references not found'});
      const authors1 = new Set((paper1.author || []).map(a => a.toLowerCase()));
      const authors2 = new Set((paper2.author || []).map(a => a.toLowerCase()));
      const sharedAuthors = [...authors1].filter(a => authors2.has(a));
      const sameVenue = paper1.venue && paper2.venue && paper1.venue === paper2.venue;
      const yearDiff = Math.abs((paper1.year || 0) - (paper2.year || 0));
      const words1 = new Set((paper1.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const words2 = new Set((paper2.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const sharedTitleWords = [...words2].filter(w => words1.has(w));
      return json(res, 200, {
        paper1: {key: key1, title: paper1.title, year: paper1.year, venue: paper1.venue, authors: paper1.author},
        paper2: {key: key2, title: paper2.title, year: paper2.year, venue: paper2.venue, authors: paper2.author},
        comparison: {
          sharedAuthors,
          sameVenue,
          yearDifference: yearDiff,
          sharedTitleWords,
        },
      });
    } catch {
      return json(res, 500, {error: 'Comparison failed'});
    }
  }

  // ── Concept glossary ──
  if (req.method === 'GET' && pathname === '/api/glossary') {
    const data = loadJSON(GLOSSARY_FILE);
    const query = (url.searchParams.get('q') || '').toLowerCase();
    let terms = data.terms || [];
    if (query) terms = terms.filter(t => t.term.toLowerCase().includes(query) || t.definition.toLowerCase().includes(query));
    terms.sort((a, b) => a.term.localeCompare(b.term));
    return json(res, 200, {terms, total: terms.length});
  }

  if (req.method === 'POST' && pathname === '/api/glossary') {
    if (!rateLimit(`glossary:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {term, definition, relatedTerms, references} = body;
      if (!term || typeof term !== 'string') return json(res, 400, {error: 'Missing or invalid term'});
      if (term.length > 200) return json(res, 400, {error: 'Term must be 200 characters or fewer'});
      if (!definition || typeof definition !== 'string') return json(res, 400, {error: 'Missing or invalid definition'});
      if (definition.length > 5000) return json(res, 400, {error: 'Definition must be 5000 characters or fewer'});
      const data = loadJSON(GLOSSARY_FILE);
      if (!data.terms) data.terms = [];
      // term is invariant across the scan, so lowercase it once instead of per entry.
      const termLower = term.toLowerCase();
      if (data.terms.some(t => t.term.toLowerCase() === termLower)) {
        return json(res, 409, {error: 'Term already exists'});
      }
      const entry = {
        id: `gl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        term: sanitizeText(term),
        definition: sanitizeText(definition),
        relatedTerms: Array.isArray(relatedTerms) ? relatedTerms.slice(0, 10).map(t => sanitizeText(t)) : [],
        references: Array.isArray(references) ? references.slice(0, 10).map(r => sanitizeText(String(r))) : [],
        createdAt: new Date().toISOString(),
      };
      data.terms.push(entry);
      saveJSON(GLOSSARY_FILE, data);
      return json(res, 200, {success: true, entry});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'DELETE' && pathname === '/api/glossary') {
    try {
      const body = await readBody(req);
      const {id} = body;
      if (!id) return json(res, 400, {error: 'Missing id'});
      const data = loadJSON(GLOSSARY_FILE);
      if (!data.terms) return json(res, 404, {error: 'Term not found'});
      const idx = data.terms.findIndex(t => t.id === id);
      if (idx === -1) return json(res, 404, {error: 'Term not found'});
      data.terms.splice(idx, 1);
      saveJSON(GLOSSARY_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Study plan generation from reading list ──
  if (req.method === 'POST' && pathname === '/api/study-plan') {
    if (!rateLimit(`study-plan:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {listId, hoursPerWeek} = body;
      if (!listId || typeof listId !== 'string') return json(res, 400, {error: 'Missing or invalid listId'});
      const data = loadJSON(READING_LISTS_FILE);
      const list = (data.lists || []).find(l => l.id === listId);
      if (!list) return json(res, 404, {error: 'Reading list not found'});
      const hpw = hoursPerWeek || 10;
      const items = (list.items || []).map((item, i) => {
        let wordCount = 0;
        if (item.type === 'doc' && isValidFilePath(item.path)) {
          try { wordCount = fs.readFileSync(path.join(PROJECT_ROOT, item.path), 'utf-8').split(/\s+/).filter(Boolean).length; } catch {}
        }
        const readingTimeMin = Math.max(5, Math.ceil(wordCount / 200));
        return {...item, order: i, readingTimeMin, wordCount};
      });
      const minutesPerWeek = hpw * 60;
      const weeks = [];
      let totalMinutes = 0;
      let currentWeek = {week: 1, items: [], totalMinutes: 0};
      for (const item of items) {
        if (currentWeek.totalMinutes + item.readingTimeMin > minutesPerWeek && currentWeek.items.length > 0) {
          weeks.push(currentWeek);
          currentWeek = {week: weeks.length + 1, items: [], totalMinutes: 0};
        }
        currentWeek.items.push(item);
        currentWeek.totalMinutes += item.readingTimeMin;
        totalMinutes += item.readingTimeMin;
      }
      if (currentWeek.items.length > 0) weeks.push(currentWeek);
      return json(res, 200, {
        plan: {
          listName: list.name,
          totalItems: items.length,
          totalReadingMinutes: totalMinutes,
          hoursPerWeek: hpw,
          estimatedWeeks: weeks.length,
          weeks,
        },
      });
    } catch {
      return json(res, 400, {error: 'Study plan generation failed'});
    }
  }

  // ── Research question tracking ──
  if (req.method === 'GET' && pathname === '/api/research-questions') {
    const RQ_FILE = path.join(PROJECT_ROOT, 'data', 'research-questions.json');
    const data = loadJSON(RQ_FILE);
    const status = url.searchParams.get('status');
    let questions = data.questions || [];
    if (status) questions = questions.filter(q => q.status === status);
    return json(res, 200, {questions, total: questions.length});
  }

  if (req.method === 'POST' && pathname === '/api/research-questions') {
    if (!rateLimit(`rq:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {question, context, relatedPapers, tags} = body;
      if (!question || typeof question !== 'string') return json(res, 400, {error: 'Missing or invalid question'});
      if (question.length > 5000) return json(res, 400, {error: 'Question must be 5000 characters or fewer'});
      if (context !== undefined && typeof context === 'string' && context.length > 5000) return json(res, 400, {error: 'Context must be 5000 characters or fewer'});
      const RQ_FILE = path.join(PROJECT_ROOT, 'data', 'research-questions.json');
      const data = loadJSON(RQ_FILE);
      if (!data.questions) data.questions = [];
      const rq = {
        id: `rq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        question: sanitizeText(question),
        context: context ? sanitizeText(String(context)) : '',
        relatedPapers: Array.isArray(relatedPapers) ? relatedPapers.slice(0, 20).map(p => sanitizeText(String(p))) : [],
        tags: Array.isArray(tags) ? tags.slice(0, 10).map(t => sanitizeText(String(t))) : [],
        status: 'open',
        createdAt: new Date().toISOString(),
      };
      data.questions.push(rq);
      saveJSON(RQ_FILE, data);
      return json(res, 200, {success: true, question: rq});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'PUT' && pathname === '/api/research-questions') {
    if (!rateLimit(`rq-update:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {id, status: newStatus, answer} = body;
      if (!id || typeof id !== 'string') return json(res, 400, {error: 'Missing or invalid id'});
      if (answer !== undefined && typeof answer === 'string' && answer.length > 5000) return json(res, 400, {error: 'Answer must be 5000 characters or fewer'});
      const RQ_FILE = path.join(PROJECT_ROOT, 'data', 'research-questions.json');
      const data = loadJSON(RQ_FILE);
      const q = (data.questions || []).find(q => q.id === id);
      if (!q) return json(res, 404, {error: 'Question not found'});
      if (newStatus) q.status = ['open', 'in-progress', 'resolved'].includes(newStatus) ? newStatus : q.status;
      if (answer) q.answer = sanitizeText(answer);
      q.updatedAt = new Date().toISOString();
      saveJSON(RQ_FILE, data);
      return json(res, 200, {success: true, question: q});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'DELETE' && pathname === '/api/research-questions') {
    try {
      const body = await readBody(req);
      const {id} = body;
      if (!id) return json(res, 400, {error: 'Missing id'});
      const RQ_FILE = path.join(PROJECT_ROOT, 'data', 'research-questions.json');
      const data = loadJSON(RQ_FILE);
      if (!data.questions) return json(res, 404, {error: 'Not found'});
      const idx = data.questions.findIndex(q => q.id === id);
      if (idx === -1) return json(res, 404, {error: 'Question not found'});
      data.questions.splice(idx, 1);
      saveJSON(RQ_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Search suggestions / autocomplete ──
  if (req.method === 'GET' && pathname === '/api/search/suggest') {
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query || query.length < 2) return json(res, 200, {suggestions: []});
    try {
      // Cache the per-query autocomplete scan so a repeat request for the same
      // term skips the recursive scanTitles walk over content/ and the
      // references.yaml read. The cache key carries `query`, so each term is its
      // own entry; the short-query early return above never reaches the cache.
      // The outer try/catch is preserved: a scan error throws out of the closure
      // before cached() records anything, so the {suggestions: []} fallback stays
      // uncached. Mirrors the sibling cached('linksuggest:' + filePath, ...).
      const result = cached('suggest:' + query, 30000, () => {
        const suggestions = [];
        const contentDir = path.join(PROJECT_ROOT, 'content');
        function scanTitles(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanTitles(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            const name = entry.name.replace(/\.(mdx?|md)$/, '');
            if (name.toLowerCase().includes(query)) {
              try {
                const content = fs.readFileSync(fp, 'utf-8');
                const fmMatch = content.match(FRONTMATTER_RE);
                let title = name;
                if (fmMatch) {
                  const tm = fmMatch[1].match(FRONTMATTER_TITLE_RE);
                  if (tm) title = tm[1];
                }
                suggestions.push({type: 'page', text: title, path: path.relative(PROJECT_ROOT, fp)});
              } catch {}
            }
          }
        }
        scanTitles(contentDir);
        try {
          const yaml = require('js-yaml');
          const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
          for (const [key, entry] of Object.entries(refs)) {
            if (key.toLowerCase().includes(query) || (entry.title || '').toLowerCase().includes(query)) {
              suggestions.push({type: 'reference', text: entry.title || key, key});
            }
            if (suggestions.length >= 15) break;
          }
        } catch {}
        return {suggestions: suggestions.slice(0, 10)};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 200, {suggestions: []});
    }
  }

  // ── Quick notes / scratchpad ──
  if (req.method === 'GET' && pathname === '/api/quicknotes') {
    const userId = url.searchParams.get('userId') || 'default';
    const QUICKNOTES_FILE = path.join(PROJECT_ROOT, 'data', 'quicknotes.json');
    const data = loadJSON(QUICKNOTES_FILE);
    const jsonNotes = (Object.hasOwn(data, userId) ? data[userId] : []).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    // Also include filesystem-based quick notes from content/posts/blog/
    const blogDir = path.join(PROJECT_ROOT, 'content', 'posts', 'blog');
    let blogNotes = [];
    try {
      if (fs.existsSync(blogDir)) {
        const files = fs.readdirSync(blogDir)
          .filter(f => f.endsWith('.md'))
          .sort((a, b) => b.localeCompare(a));
        for (const file of files) {
          if (blogNotes.length >= 50) break;
          try {
            const raw = fs.readFileSync(path.join(blogDir, file), 'utf-8');
            if (!raw.includes('quick-note')) continue;
            const titleMatch = raw.match(QUICKNOTES_TITLE_RE);
            const dateMatch = file.match(QUICKNOTES_DATE_RE);
            const bodyMatch = raw.match(QUICKNOTES_BODY_RE);
            blogNotes.push({
              id: file,
              text: bodyMatch ? bodyMatch[1].trim().slice(0, 200) : '',
              title: titleMatch ? titleMatch[1] : file,
              date: dateMatch ? dateMatch[1] : null,
              path: `content/posts/blog/${file}`,
              source: 'blog',
            });
          } catch {}
        }
      }
    } catch {}

    const allNotes = [...jsonNotes, ...blogNotes];
    return json(res, 200, allNotes);
  }

  if (req.method === 'POST' && pathname === '/api/quicknotes') {
    if (!rateLimit(`quicknotes:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {userId, text, color} = body;
      if (!text || typeof text !== 'string') return json(res, 400, {error: 'Missing or invalid text'});
      if (text.length > MAX_TEXT_LENGTH) return json(res, 400, {error: 'Text too long'});
      if (userId !== undefined && typeof userId !== 'string') return json(res, 400, {error: 'userId must be a string'});
      if (userId && userId.length > 200) return json(res, 400, {error: 'userId must be 200 characters or fewer'});
      const uid = userId || 'default';
      const QUICKNOTES_FILE = path.join(PROJECT_ROOT, 'data', 'quicknotes.json');
      const data = loadJSON(QUICKNOTES_FILE);
      if (!Object.hasOwn(data, uid)) data[uid] = [];
      const note = {
        id: `qn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        text: sanitizeText(text),
        color: /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#fef3c7',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      data[uid].push(note);
      if (data[uid].length > 200) data[uid] = data[uid].slice(-200);
      saveJSON(QUICKNOTES_FILE, data);
      return json(res, 200, {success: true, note});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'DELETE' && pathname === '/api/quicknotes') {
    try {
      const body = await readBody(req);
      const {userId, id} = body;
      if (!id) return json(res, 400, {error: 'Missing id'});
      const uid = userId || 'default';
      const QUICKNOTES_FILE = path.join(PROJECT_ROOT, 'data', 'quicknotes.json');
      const data = loadJSON(QUICKNOTES_FILE);
      if (!Object.hasOwn(data, uid)) return json(res, 404, {error: 'Note not found'});
      const idx = data[uid].findIndex(n => n.id === id);
      if (idx === -1) return json(res, 404, {error: 'Note not found'});
      data[uid].splice(idx, 1);
      saveJSON(QUICKNOTES_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Content pins (starred pages) ──
  if (req.method === 'GET' && pathname === '/api/pins') {
    const PINS_FILE = path.join(PROJECT_ROOT, 'data', 'pins.json');
    const data = loadJSON(PINS_FILE);
    return json(res, 200, {pins: data.pins || []});
  }

  if (req.method === 'POST' && pathname === '/api/pins') {
    if (!rateLimit(`pins:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: pagePath, title} = body;
      if (!pagePath || typeof pagePath !== 'string') return json(res, 400, {error: 'Missing or invalid path'});
      if (pagePath.length > 500) return json(res, 400, {error: 'Path must be 500 characters or fewer'});
      if (title !== undefined && typeof title === 'string' && title.length > 500) return json(res, 400, {error: 'Title must be 500 characters or fewer'});
      const PINS_FILE = path.join(PROJECT_ROOT, 'data', 'pins.json');
      const data = loadJSON(PINS_FILE);
      if (!data.pins) data.pins = [];
      if (data.pins.some(p => p.path === pagePath)) return json(res, 200, {success: true, message: 'Already pinned'});
      data.pins.push({path: sanitizeText(pagePath), title: sanitizeText(title || pagePath), pinnedAt: new Date().toISOString()});
      saveJSON(PINS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'DELETE' && pathname === '/api/pins') {
    try {
      const body = await readBody(req);
      const {path: pagePath} = body;
      if (!pagePath) return json(res, 400, {error: 'Missing path'});
      const PINS_FILE = path.join(PROJECT_ROOT, 'data', 'pins.json');
      const data = loadJSON(PINS_FILE);
      if (!data.pins) return json(res, 404, {error: 'Not pinned'});
      const idx = data.pins.findIndex(p => p.path === pagePath);
      if (idx === -1) return json(res, 404, {error: 'Not pinned'});
      data.pins.splice(idx, 1);
      saveJSON(PINS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── User preferences ──
  if (req.method === 'GET' && pathname === '/api/preferences') {
    const userId = url.searchParams.get('userId');
    if (!userId) return json(res, 400, {error: 'Missing userId'});
    const PREFS_FILE = path.join(PROJECT_ROOT, 'data', 'preferences.json');
    const prefs = loadJSON(PREFS_FILE);
    return json(res, 200, {preferences: Object.hasOwn(prefs, userId) ? prefs[userId] : {}});
  }

  if (req.method === 'PUT' && pathname === '/api/preferences') {
    if (!rateLimit(`prefs:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {userId, preferences} = body;
      if (!userId || typeof userId !== 'string') return json(res, 400, {error: 'Missing or invalid userId'});
      if (userId.length > 200) return json(res, 400, {error: 'userId must be 200 characters or fewer'});
      if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return json(res, 400, {error: 'Missing or invalid preferences'});
      // Guard against prototype pollution: reject dangerous keys
      if (DANGEROUS_PREFERENCE_KEYS.has(userId)) return json(res, 400, {error: 'Invalid userId'});
      for (const key of Object.keys(preferences)) {
        if (DANGEROUS_PREFERENCE_KEYS.has(key)) return json(res, 400, {error: `Invalid preference key: ${key}`});
      }
      const safeUserId = sanitizeText(userId);
      const PREFS_FILE = path.join(PROJECT_ROOT, 'data', 'preferences.json');
      const prefs = loadJSON(PREFS_FILE);
      if (!Object.hasOwn(prefs, safeUserId)) prefs[safeUserId] = {};
      for (const [key, value] of Object.entries(preferences)) {
        if (!DANGEROUS_PREFERENCE_KEYS.has(key)) {
          prefs[safeUserId][key] = typeof value === 'string' ? sanitizeText(value).slice(0, 5000) : value;
        }
      }
      prefs[safeUserId].updatedAt = new Date().toISOString();
      saveJSON(PREFS_FILE, prefs);
      return json(res, 200, {success: true, preferences: prefs[safeUserId]});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Bookmark folders ──
  if (req.method === 'GET' && pathname === '/api/bookmarks/folders') {
    const data = loadJSON(BOOKMARKS_FILE);
    return json(res, 200, {folders: data.folders || []});
  }

  if (req.method === 'POST' && pathname === '/api/bookmarks/folders') {
    if (!rateLimit(`bm-folders:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {name} = body;
      if (!name || typeof name !== 'string') return json(res, 400, {error: 'Missing name'});
      if (name.length > 200) return json(res, 400, {error: 'Name must be 200 characters or fewer'});
      const data = loadJSON(BOOKMARKS_FILE);
      if (!data.folders) data.folders = [];
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (data.folders.some(f => f.id === id)) return json(res, 409, {error: 'Folder already exists'});
      const folder = {id, name: sanitizeText(name), createdAt: new Date().toISOString()};
      data.folders.push(folder);
      saveJSON(BOOKMARKS_FILE, data);
      return json(res, 200, {success: true, folder});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Content review workflow ──
  if (req.method === 'POST' && pathname === '/api/reviews') {
    if (!rateLimit(`reviews:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: pagePath, requestedBy, note} = body;
      if (!pagePath || typeof pagePath !== 'string') return json(res, 400, {error: 'Missing or invalid path'});
      if (pagePath.length > 500) return json(res, 400, {error: 'Path must be 500 characters or fewer'});
      if (requestedBy !== undefined && typeof requestedBy === 'string' && requestedBy.length > 100) return json(res, 400, {error: 'requestedBy must be 100 characters or fewer'});
      if (note !== undefined && typeof note === 'string' && note.length > 5000) return json(res, 400, {error: 'Note must be 5000 characters or fewer'});
      const REVIEWS_FILE = path.join(PROJECT_ROOT, 'data', 'reviews.json');
      const data = loadJSON(REVIEWS_FILE);
      if (!data.reviews) data.reviews = [];
      const review = {
        id: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        path: sanitizeText(pagePath),
        requestedBy: sanitizeText(requestedBy || 'Anonymous'),
        note: note ? sanitizeText(note) : '',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      data.reviews.push(review);
      saveJSON(REVIEWS_FILE, data);
      return json(res, 200, {success: true, review});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/reviews') {
    const REVIEWS_FILE = path.join(PROJECT_ROOT, 'data', 'reviews.json');
    const data = loadJSON(REVIEWS_FILE);
    const status = url.searchParams.get('status');
    let reviews = data.reviews || [];
    if (status) reviews = reviews.filter(r => r.status === status);
    return json(res, 200, {reviews, total: reviews.length});
  }

  if (req.method === 'PUT' && pathname === '/api/reviews') {
    if (!rateLimit(`reviews-update:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {id, status: newStatus, reviewedBy, feedback} = body;
      if (!id || typeof id !== 'string') return json(res, 400, {error: 'Missing or invalid id'});
      if (!newStatus || typeof newStatus !== 'string') return json(res, 400, {error: 'Missing or invalid status'});
      if (!['approved', 'rejected', 'pending'].includes(newStatus)) return json(res, 400, {error: 'Invalid status'});
      if (reviewedBy !== undefined && typeof reviewedBy === 'string' && reviewedBy.length > 100) return json(res, 400, {error: 'reviewedBy must be 100 characters or fewer'});
      if (feedback !== undefined && typeof feedback === 'string' && feedback.length > 5000) return json(res, 400, {error: 'Feedback must be 5000 characters or fewer'});
      const REVIEWS_FILE = path.join(PROJECT_ROOT, 'data', 'reviews.json');
      const data = loadJSON(REVIEWS_FILE);
      const review = (data.reviews || []).find(r => r.id === id);
      if (!review) return json(res, 404, {error: 'Review not found'});
      review.status = newStatus;
      review.reviewedBy = reviewedBy ? sanitizeText(reviewedBy) : null;
      review.feedback = feedback ? sanitizeText(feedback) : null;
      review.reviewedAt = new Date().toISOString();
      saveJSON(REVIEWS_FILE, data);
      return json(res, 200, {success: true, review});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Custom template management ──
  if (req.method === 'POST' && pathname === '/api/templates/custom') {
    if (!rateLimit(`templates:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {name, content} = body;
      if (!name || typeof name !== 'string') return json(res, 400, {error: 'Missing or invalid name'});
      if (name.length > 200) return json(res, 400, {error: 'Name must be 200 characters or fewer'});
      if (!content || typeof content !== 'string') return json(res, 400, {error: 'Missing or invalid content'});
      if (content.length > 50000) return json(res, 400, {error: 'Content must be 50000 characters or fewer'});
      const TEMPLATES_FILE = path.join(PROJECT_ROOT, 'data', 'custom-templates.json');
      const templates = loadJSON(TEMPLATES_FILE);
      if (!templates.items) templates.items = [];
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (templates.items.some(t => t.id === id)) return json(res, 409, {error: 'Template with this name already exists'});
      const template = {id, name: sanitizeText(name), content: sanitizeText(content), createdAt: new Date().toISOString()};
      templates.items.push(template);
      saveJSON(TEMPLATES_FILE, templates);
      return json(res, 200, {success: true, template});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'DELETE' && pathname === '/api/templates/custom') {
    try {
      const body = await readBody(req);
      const {id} = body;
      if (!id) return json(res, 400, {error: 'Missing id'});
      const TEMPLATES_FILE = path.join(PROJECT_ROOT, 'data', 'custom-templates.json');
      const templates = loadJSON(TEMPLATES_FILE);
      if (!templates.items) return json(res, 404, {error: 'Template not found'});
      const idx = templates.items.findIndex(t => t.id === id);
      if (idx === -1) return json(res, 404, {error: 'Template not found'});
      templates.items.splice(idx, 1);
      saveJSON(TEMPLATES_FILE, templates);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Per-page analytics ──
  if (req.method === 'GET' && pathname === '/api/analytics/page') {
    const pagePath = url.searchParams.get('path');
    if (!pagePath) return json(res, 400, {error: 'Missing path'});
    const analytics = loadJSON(ANALYTICS_FILE);
    const counts = analytics.counts || {};
    const views = Object.hasOwn(counts, pagePath) ? counts[pagePath] : 0;
    const comments = loadJSON(COMMENTS_FILE);
    const commentCount = (Object.hasOwn(comments, pagePath) ? comments[pagePath] : []).length;
    const bookmarks = loadJSON(BOOKMARKS_FILE);
    const isBookmarked = (bookmarks.bookmarks || []).some(b => b.path === pagePath);
    const readingLists = loadJSON(READING_LISTS_FILE);
    let inReadingLists = 0;
    for (const list of (readingLists.lists || [])) {
      if ((list.items || []).some(item => item.path === pagePath)) inReadingLists++;
    }
    return json(res, 200, {
      path: pagePath,
      views,
      comments: commentCount,
      isBookmarked,
      inReadingLists,
    });
  }

  // ── Knowledge base summary report ──
  if (req.method === 'GET' && pathname === '/api/report/knowledge-base') {
    try {
      // The recursive content scan is deterministic, so memoize the derived
      // report under a short TTL, mirroring the sibling content-clusters
      // endpoint. Only the scan-derived data is cached; generatedAt is computed
      // OUTSIDE the cache so every response carries a fresh per-request
      // timestamp, and the try/catch stays outside so the 500 path is never
      // cached.
      const report = cached('kb-report', 60000, () => {
        const yaml = require('js-yaml');
        const contentDir = path.join(PROJECT_ROOT, 'content');
        let totalFiles = 0, totalWords = 0;
        const byDir = {};
        const tagCounts = {};
        function scan(dir, dirName) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp, dirName || entry.name); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            totalFiles++;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const words = content.split(/\s+/).filter(Boolean).length;
              totalWords += words;
              const dn = dirName || 'root';
              if (!byDir[dn]) byDir[dn] = {files: 0, words: 0};
              byDir[dn].files++;
              byDir[dn].words += words;
              const fmMatch = content.match(FRONTMATTER_RE);
              if (fmMatch) {
                const tgm = fmMatch[1].match(/^tags:\s*\[([^\]]*)\]/m);
                if (tgm) tgm[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
              }
            } catch {}
          }
        }
        scan(contentDir, null);
        let refCount = 0;
        try {
          const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
          refCount = Object.keys(refs).length;
        } catch {}
        const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const sections = Object.entries(byDir).sort((a, b) => b[1].words - a[1].words).map(([name, info]) => ({name, ...info}));
        return {
          overview: {totalFiles, totalWords, references: refCount, avgWordsPerFile: totalFiles > 0 ? Math.round(totalWords / totalFiles) : 0},
          sections,
          topTags: topTags.map(([tag, count]) => ({tag, count})),
        };
      });
      return json(res, 200, {...report, generatedAt: new Date().toISOString()});
    } catch {
      return json(res, 500, {error: 'Report generation failed'});
    }
  }

};

// Exported for the link-suggestions regression test, which pre-seeds a stale
// lastIndex to prove the per-request `LINKSUGGEST_WIKI_RE.lastIndex = 0` reset is
// load-bearing. Not part of the route contract.
module.exports.LINKSUGGEST_WIKI_RE = LINKSUGGEST_WIKI_RE;

// Exported for the quicknotes parser regex-hoist regression test, which pins the
// .source/.flags and referential stability of the three shared instances and
// drives GET /api/quicknotes to confirm parsing is unchanged. Not part of the
// route contract.
module.exports.QUICKNOTES_TITLE_RE = QUICKNOTES_TITLE_RE;
module.exports.QUICKNOTES_DATE_RE = QUICKNOTES_DATE_RE;
module.exports.QUICKNOTES_BODY_RE = QUICKNOTES_BODY_RE;

// Exported for the front-matter title regex-hoist regression test, which pins
// the .source/.flags and referential stability of the one shared instance and
// drives the three content-scan handlers to confirm title extraction is
// unchanged for double-quoted, single-quoted, and unquoted front-matter titles.
// Not part of the route contract.
module.exports.FRONTMATTER_TITLE_RE = FRONTMATTER_TITLE_RE;
