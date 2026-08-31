'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.

// Shared YAML front-matter matcher for the leading `---` block of a content
// file. It is non-global and used only with String.prototype.match, so it
// holds no lastIndex state and one shared instance is safe across handlers.
const {dataFileSegs} = require('../paths');

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
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, NOTES_FILE, ANALYTICS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, SNAPSHOTS_FILE, SCHEDULE_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, orgSlugFor, contentRootFor, cacheKey, isValidFilePath, isValidDir, resolveContentPath, contentPathToUrl, sanitizeText, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Spaced repetition flashcards ──
  if (req.method === 'POST' && pathname === '/api/flashcards') {
    if (!rateLimit(`flashcards:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {front, back, tags, sourcePath} = body;
      const {userId: uid} = req.auth;
      if (!front || typeof front !== 'string') return json(res, 400, {error: 'Missing or invalid front'});
      if (!back || typeof back !== 'string') return json(res, 400, {error: 'Missing or invalid back'});
      if (front.length > 5000) return json(res, 400, {error: 'front must be 5000 characters or fewer'});
      if (back.length > 5000) return json(res, 400, {error: 'back must be 5000 characters or fewer'});
      if (tags !== undefined && (!Array.isArray(tags) || !tags.every(t => typeof t === 'string'))) return json(res, 400, {error: 'tags must be an array of strings'});
      if (sourcePath !== undefined && typeof sourcePath !== 'string') return json(res, 400, {error: 'sourcePath must be a string'});
      if (sourcePath && sourcePath.length > 500) return json(res, 400, {error: 'sourcePath must be 500 characters or fewer'});
      const data = loadJSON(FLASHCARDS_FILE);
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
    const {userId} = req.auth;
    const data = loadJSON(FLASHCARDS_FILE);
    const cards = Object.hasOwn(data, userId) ? data[userId] : [];
    return json(res, 200, {cards, total: cards.length});
  }

  if (req.method === 'GET' && pathname === '/api/flashcards/due') {
    const {userId} = req.auth;
    const today = new Date().toISOString().slice(0, 10);
    const data = loadJSON(FLASHCARDS_FILE);
    const cards = (Object.hasOwn(data, userId) ? data[userId] : []).filter(c => c.nextReview <= today);
    return json(res, 200, {cards, dueCount: cards.length});
  }

  if (req.method === 'POST' && pathname === '/api/flashcards/review') {
    if (!rateLimit(`fc-review:${req.socket.remoteAddress}`, 120)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {cardId, quality} = body;
      const {userId: uid} = req.auth;
      if (!cardId || typeof cardId !== 'string') return json(res, 400, {error: 'Missing or invalid cardId'});
      if (cardId.length > 200) return json(res, 400, {error: 'cardId must be 200 characters or fewer'});
      if (quality == null || typeof quality !== 'number' || !isFinite(quality)) return json(res, 400, {error: 'Missing or invalid quality'});
      if (quality < 0 || quality > 5) return json(res, 400, {error: 'quality must be between 0 and 5'});
      const q = Math.max(0, Math.min(5, quality));
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
      const {cardId} = body;
      const {userId: uid} = req.auth;
      if (!cardId) return json(res, 400, {error: 'Missing cardId'});
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

  // ── Paper comparison ──
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

  // ── Quick notes / scratchpad ──
  if (req.method === 'GET' && pathname === '/api/quicknotes') {
    const {userId} = req.auth;
    const QUICKNOTES_FILE = path.join(PROJECT_ROOT, ...dataFileSegs('quicknotes'));
    const data = loadJSON(QUICKNOTES_FILE);
    const jsonNotes = (Object.hasOwn(data, userId) ? data[userId] : []).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    // Also include filesystem-based quick notes from content/posts/blog/
    const blogDir = path.join(contentRootFor(req.auth?.orgId), 'posts', 'blog');
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
              path: `posts/blog/${file}`,
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
      const {text, color} = body;
      const {userId: uid} = req.auth;
      if (!text || typeof text !== 'string') return json(res, 400, {error: 'Missing or invalid text'});
      if (text.length > MAX_TEXT_LENGTH) return json(res, 400, {error: 'Text too long'});
      const QUICKNOTES_FILE = path.join(PROJECT_ROOT, ...dataFileSegs('quicknotes'));
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
      const {id} = body;
      const {userId: uid} = req.auth;
      if (!id) return json(res, 400, {error: 'Missing id'});
      const QUICKNOTES_FILE = path.join(PROJECT_ROOT, ...dataFileSegs('quicknotes'));
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

  // ── User preferences ──
  if (req.method === 'GET' && pathname === '/api/preferences') {
    const {userId} = req.auth;
    const PREFS_FILE = path.join(PROJECT_ROOT, ...dataFileSegs('preferences'));
    const prefs = loadJSON(PREFS_FILE);
    return json(res, 200, {preferences: Object.hasOwn(prefs, userId) ? prefs[userId] : {}});
  }

  if (req.method === 'PUT' && pathname === '/api/preferences') {
    if (!rateLimit(`prefs:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {preferences} = body;
      const {userId: safeUserId} = req.auth;
      if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return json(res, 400, {error: 'Missing or invalid preferences'});
      // Preference names are still client-supplied, so their prototype-key
      // guard stays. The store key is the session subject, already checked.
      for (const key of Object.keys(preferences)) {
        if (DANGEROUS_PREFERENCE_KEYS.has(key)) return json(res, 400, {error: `Invalid preference key: ${key}`});
      }
      const PREFS_FILE = path.join(PROJECT_ROOT, ...dataFileSegs('preferences'));
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
