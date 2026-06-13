'use strict';
// Route module organized from server.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server.js detects a sent response via res.writableEnded.

// Parse a numeric query parameter, clamping to `max` and falling back to `def`
// when the value is absent or non-numeric. Without the fallback a stray
// `?limit=abc` or `?depth=abc` parses to NaN: the activity feed then slices to
// `events.slice(0, NaN)` and collapses to empty, and the reading-path BFS never
// trips its `depth > maxDepth` cutoff, so it traverses the whole reachable
// graph. Absent and valid numeric values keep their previous behavior.
function numericParam(raw, def, max) {
  const n = parseInt(raw, 10);
  return Math.min(Number.isNaN(n) ? def : n, max);
}

// Stop-word sets for the keyword filtering in GET /api/file/similarity, GET
// /api/content-recommend-v2, and GET /api/stats/word-frequency, built once at
// module load instead of rebuilt on every request. Each set is read only
// (`.has` membership tests), so hoisting leaves the similarity, recommendation,
// and word-frequency outputs identical. The three lists intentionally differ in
// length, so they stay as three distinct constants, mirroring
// RECOMMEND_STOP_WORDS and SIMILAR_STOP_WORDS in
// server/routes/content-analysis-b.js.
const SIMILARITY_STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not']);
const RECOMMEND_STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not','can','all','each','some','more','most','other']);
const WORD_FREQ_STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not','can','all','each','some','more','most','other','also','than','very','just','such','only']);

// Citation-key regex for GET /api/content-recommend-v2, hoisted to module scope
// so it is built once instead of on every request. Because the /g flag makes the
// regex carry `lastIndex` as shared mutable state, the handler resets
// `RECOMMEND_CITE_RE.lastIndex = 0` immediately before each `.exec` loop, so there
// is no carryover within or across requests. This is the simple `[@key` form; the
// distinct `[@a; @b]` pattern in the cached('ref-pagerank') closure stays local there.
const RECOMMEND_CITE_RE = /\[@([\w-]+)/g;

// Wiki-link regex for GET /api/content-reading-path, hoisted to module scope so it
// is built once per process instead of on every request. The /g flag makes the
// regex carry `lastIndex` as shared mutable state, so the handler resets it to 0
// immediately before each file's exec loop, leaving no carryover within or across
// requests. It captures the link target and drops any trailing `|alias`.
const READING_PATH_WIKI_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

// Reuse the shared, mtime-and-size-memoized bibliography/references.yaml loader
// from the sibling references route instead of re-implementing it here. The
// loader never throws: a read or parse failure (including a missing file, whose
// stat and read both throw) yields {}, so every call site's `... || {}` fallback
// and the 200-empty-on-broken-yaml behavior are preserved.
const { loadReferencesCached } = require('./references');

module.exports = async function content_analysis_a_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, collectFeedItems, parseFeedItem, cached, invalidateCache, cleanStalePresence, rateLimit, formatAuthorAPA, formatAuthorMLA, formatAuthorIEEE, formatCitation, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Productivity report ──
  if (req.method === 'GET' && pathname === '/api/productivity-report') {
    try {
      const userId = url.searchParams.get('userId') || 'default';
      const streakData = loadJSON(STREAKS_FILE);
      const userLog = (streakData[userId] && streakData[userId].dailyLog) || [];
      const sorted = [...userLog].sort((a, b) => a.date.localeCompare(b.date));
      const today = new Date().toISOString().slice(0, 10);
      // Fold the 7 and 30 day windows into a single pass over `sorted`. The two
      // cutoff date strings are computed once here, where the old `.filter`
      // callbacks rebuilt them per element. Each entry updates whichever windows
      // it falls in, accumulating the entry count, the word sum, and the
      // active-day count (entries with `e.words >= 50`), collapsing the former
      // six passes (two filters, two reduces, two active-day re-walks) into one.
      // `e.words` is read directly, with no `|| 0`, so NaN and undefined totals
      // stay identical to the original reduce; iterating `sorted` keeps the
      // result order independent.
      const cutoff7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      let count7 = 0, totalWordsLast7 = 0, activeDaysLast7 = 0;
      let count30 = 0, totalWordsLast30 = 0, activeDaysLast30 = 0;
      for (const e of sorted) {
        if (e.date >= cutoff7) {
          count7++;
          totalWordsLast7 += e.words;
          if (e.words >= 50) activeDaysLast7++;
        }
        if (e.date >= cutoff30) {
          count30++;
          totalWordsLast30 += e.words;
          if (e.words >= 50) activeDaysLast30++;
        }
      }
      const avgWordsPerDay7 = count7 > 0 ? Math.round(totalWordsLast7 / 7) : 0;
      const avgWordsPerDay30 = count30 > 0 ? Math.round(totalWordsLast30 / 30) : 0;
      const analytics = loadJSON(ANALYTICS_FILE);
      const totalPageviews = Object.values(analytics.counts || {}).reduce((s, c) => s + c, 0);
      const recentPageviews = (analytics.recent || []).filter(r => r.timestamp >= new Date(Date.now() - 7 * 86400000).toISOString()).length;
      let refCount = 0;
      try { refCount = Object.keys(loadReferencesCached(fs, path, PROJECT_ROOT)).length; } catch {}
      const stats = cached('content-stats', 30000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        let totalFiles = 0, totalWords = 0;
        function count(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            if (entry.isDirectory()) { count(path.join(dir, entry.name)); continue; }
            if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              totalFiles++;
              totalWords += fs.readFileSync(path.join(dir, entry.name), 'utf-8').split(/\s+/).filter(Boolean).length;
            }
          }
        }
        count(contentDir);
        return {totalFiles, totalWords};
      });
      return json(res, 200, {
        streak: {
          activeDaysLast7,
          activeDaysLast30,
          totalWordsLast7,
          totalWordsLast30,
          avgWordsPerDay7,
          avgWordsPerDay30,
        },
        content: {
          totalFiles: stats.totalFiles,
          totalWords: stats.totalWords,
          references: refCount,
        },
        traffic: {
          totalPageviews,
          pageviewsLast7Days: recentPageviews,
        },
        generatedAt: new Date().toISOString(),
      });
    } catch {
      return json(res, 500, {error: 'Productivity report failed'});
    }
  }

  // ── File similarity comparison ──
  if (req.method === 'GET' && pathname === '/api/file/similarity') {
    const path1 = url.searchParams.get('path1');
    const path2 = url.searchParams.get('path2');
    if (!isValidFilePath(path1) || !isValidFilePath(path2)) return json(res, 400, {error: 'Invalid paths'});
    try {
      // Memoize the two file reads and the Jaccard computation for 30s, mirroring
      // the sibling cached('filestyle:' + path) and cached('filecomplexity:' + path)
      // per-file caches in content-analysis-b.js. The payload is a pure function of
      // the two content files, so the key carries both paths: each (path1, path2)
      // pair gets its own entry and a 30s snapshot stays byte identical while
      // skipping the repeat reads. The isValidFilePath 400 guard stays above this
      // try, and the try/catch stays outside the closure, so an invalid path never
      // reads and a missing file returns a 404 that is never cached (the cached
      // helper stores nothing when fn throws).
      const result = cached('similarity:' + path1 + ':' + path2, 30000, () => {
        function extractWords(filePath) {
          let text = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
          text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/[^a-zA-Z\s]/g, ' ');
          return text.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !SIMILARITY_STOP_WORDS.has(w));
        }
        const words1 = extractWords(path1);
        const words2 = extractWords(path2);
        const set1 = new Set(words1);
        const set2 = new Set(words2);
        let intersection = 0;
        // Collect the shared words during the intersection count so set1 is walked
        // once. Pushing inside the existing `set2.has(w)` branch preserves set1's
        // insertion order, the same order the former spread-then-filter pass used,
        // so `sharedAll.slice(0, 20)` stays byte identical to the old `sharedWords`.
        const sharedAll = [];
        for (const w of set1) if (set2.has(w)) { intersection++; sharedAll.push(w); }
        // |A ∪ B| = |A| + |B| - |A ∩ B|. The intersection is already counted above,
        // so derive the union by set algebra instead of materializing a merged Set.
        const union = set1.size + set2.size - intersection;
        const jaccard = union > 0 ? Math.round((intersection / union) * 1000) / 1000 : 0;
        const sharedWords = sharedAll.slice(0, 20);
        return {
          similarity: jaccard,
          sharedWords,
          uniqueToFile1: set1.size - intersection,
          uniqueToFile2: set2.size - intersection,
          sharedCount: intersection,
        };
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Batch metadata update ──
  if (req.method === 'POST' && pathname === '/api/files/batch-metadata') {
    if (!rateLimit(`batch-meta:${req.socket.remoteAddress}`, 5)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {paths, addTags, removeTags, setDraft} = body;
      if (!Array.isArray(paths) || paths.length === 0) return json(res, 400, {error: 'Missing paths array'});
      if (addTags !== undefined && (!Array.isArray(addTags) || !addTags.every(t => typeof t === 'string'))) return json(res, 400, {error: 'addTags must be an array of strings'});
      if (removeTags !== undefined && (!Array.isArray(removeTags) || !removeTags.every(t => typeof t === 'string'))) return json(res, 400, {error: 'removeTags must be an array of strings'});
      if (addTags && addTags.some(t => t.length > 100)) return json(res, 400, {error: 'Tag names must be 100 characters or fewer'});
      if (removeTags && removeTags.some(t => t.length > 100)) return json(res, 400, {error: 'Tag names must be 100 characters or fewer'});
      if (setDraft !== undefined && typeof setDraft !== 'boolean') return json(res, 400, {error: 'setDraft must be a boolean'});
      let updated = 0;
      const errors = [];
      for (const filePath of paths.slice(0, 50)) {
        if (!isValidFilePath(filePath)) { errors.push({path: filePath, error: 'Invalid path'}); continue; }
        try {
          const fullPath = path.join(PROJECT_ROOT, filePath);
          let content = fs.readFileSync(fullPath, 'utf-8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
          if (!fmMatch) { errors.push({path: filePath, error: 'No frontmatter'}); continue; }
          let fm = fmMatch[1];
          if (Array.isArray(addTags) && addTags.length > 0) {
            const tagsMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
            if (tagsMatch) {
              const existing = tagsMatch[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
              const merged = [...new Set([...existing, ...addTags])];
              fm = fm.replace(/^tags:\s*\[([^\]]*)\]/m, `tags: [${merged.join(', ')}]`);
            } else {
              fm += `\ntags: [${addTags.join(', ')}]`;
            }
          }
          if (Array.isArray(removeTags) && removeTags.length > 0) {
            const tagsMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
            if (tagsMatch) {
              const existing = tagsMatch[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
              const filtered = existing.filter(t => !removeTags.includes(t));
              fm = fm.replace(/^tags:\s*\[([^\]]*)\]/m, `tags: [${filtered.join(', ')}]`);
            }
          }
          if (setDraft !== undefined) {
            if (/^draft:\s*.*/m.test(fm)) fm = fm.replace(/^draft:\s*.*/m, `draft: ${setDraft}`);
            else fm += `\ndraft: ${setDraft}`;
          }
          content = `---\n${fm}\n---\n` + content.slice(fmMatch[0].length);
          fs.writeFileSync(fullPath, content, 'utf-8');
          updated++;
        } catch { errors.push({path: filePath, error: 'Update failed'}); }
      }
      invalidateCache('search');
      invalidateCache('tags');
      return json(res, 200, {success: true, updated, errors: errors.length > 0 ? errors : undefined});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Content statistics overview (all-in-one) ──
  if (req.method === 'GET' && pathname === '/api/stats/overview') {
    try {
      // Memoize the whole recursive content scan and assembled result for 30s,
      // mirroring the sibling cached('content-stats'), cached('link-density'),
      // and cached('kb-outline') handlers in this file. The aggregate is
      // deterministic for a given content state, so serving a 30s snapshot is
      // behavior preserving while skipping the readdirSync/readFileSync walk on
      // repeat requests. The try/catch stays outside the closure so a failed
      // scan returns a 500 that is never cached.
      const overview = cached('stats-overview', 30000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        let files = 0, words = 0, headings = 0, citations = 0, links = 0;
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              files++;
              try {
                const c = fs.readFileSync(fp, 'utf-8');
                words += c.split(/\s+/).filter(Boolean).length;
                headings += (c.match(/^#{1,6}\s+/gm) || []).length;
                citations += (c.match(/\[@/g) || []).length;
                links += (c.match(/\[\[/g) || []).length + (c.match(/\]\(/g) || []).length;
              } catch {}
            }
          }
        }
        scan(contentDir);
        let refs = 0;
        try { refs = Object.keys(loadReferencesCached(fs, path, PROJECT_ROOT)).length; } catch {}
        return {
          files, words, headings, citations, links, references: refs,
          avgWordsPerFile: files > 0 ? Math.round(words / files) : 0,
          avgHeadingsPerFile: files > 0 ? Math.round(headings / files * 10) / 10 : 0,
          avgCitationsPerFile: files > 0 ? Math.round(citations / files * 10) / 10 : 0,
          readingTimeHours: Math.round(words / 200 / 60 * 10) / 10,
        };
      });
      return json(res, 200, overview);
    } catch {
      return json(res, 500, {error: 'Overview failed'});
    }
  }

  // ── Link density analysis ──
  if (req.method === 'GET' && pathname === '/api/stats/link-density') {
    try {
      const density = cached('link-density', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const pages = [];
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const words = content.split(/\s+/).filter(Boolean).length;
              const wikiLinks = (content.match(/\[\[/g) || []).length;
              const mdLinks = (content.match(/\]\(/g) || []).length;
              const citations = (content.match(/\[@/g) || []).length;
              const totalLinks = wikiLinks + mdLinks + citations;
              const density = words > 0 ? Math.round((totalLinks / words) * 1000 * 10) / 10 : 0;
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              pages.push({path: path.relative(PROJECT_ROOT, fp), title, words, totalLinks, wikiLinks, mdLinks, citations, linksPerKWords: density});
            } catch {}
          }
        }
        scan(contentDir);
        pages.sort((a, b) => b.linksPerKWords - a.linksPerKWords);
        return pages;
      });
      const avgDensity = density.length > 0 ? Math.round(density.reduce((s, p) => s + p.linksPerKWords, 0) / density.length * 10) / 10 : 0;
      return json(res, 200, {
        avgLinksPerKWords: avgDensity,
        mostLinked: density.slice(0, 10),
        leastLinked: density.filter(p => p.totalLinks === 0).slice(0, 10),
        total: density.length,
      });
    } catch {
      return json(res, 500, {error: 'Link density analysis failed'});
    }
  }

  // ── Full knowledge base outline ──
  if (req.method === 'GET' && pathname === '/api/content-outline') {
    try {
      const outline = cached('kb-outline', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const result = [];
        function scan(dir, depth) {
          const entries = fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              result.push({type: 'directory', name: entry.name, depth});
              scan(fp, depth + 1);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                const content = fs.readFileSync(fp, 'utf-8');
                let title = entry.name.replace(/\.(mdx?|md)$/, '');
                const fm = content.match(/^---\n([\s\S]*?)\n---/);
                if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
                const headings = [];
                for (const line of content.split('\n')) {
                  const m = line.match(/^(#{1,4})\s+(.+)$/);
                  if (m) headings.push({level: m[1].length, text: m[2].trim()});
                }
                result.push({type: 'file', title, path: path.relative(PROJECT_ROOT, fp), depth, headingCount: headings.length, topHeadings: headings.slice(0, 5)});
              } catch {}
            }
          }
        }
        scan(contentDir, 0);
        return result;
      });
      return json(res, 200, {outline, totalEntries: outline.length});
    } catch {
      return json(res, 500, {error: 'Outline failed'});
    }
  }

  // ── Health score history ──
  if (req.method === 'POST' && pathname === '/api/health-history') {
    if (!rateLimit(`health-history:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {score, details} = body;
      if (typeof score !== 'number' || !isFinite(score)) return json(res, 400, {error: 'Missing or invalid score'});
      if (score < 0 || score > 100) return json(res, 400, {error: 'Score must be between 0 and 100'});
      if (details !== undefined && (typeof details !== 'object' || details === null || Array.isArray(details))) return json(res, 400, {error: 'details must be an object'});
      const HISTORY_FILE = path.join(PROJECT_ROOT, 'data', 'health-history.json');
      const data = loadJSON(HISTORY_FILE);
      if (!data.entries) data.entries = [];
      data.entries.push({score, details: details || {}, date: new Date().toISOString()});
      if (data.entries.length > 365) data.entries = data.entries.slice(-365);
      saveJSON(HISTORY_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/health-history') {
    const HISTORY_FILE = path.join(PROJECT_ROOT, 'data', 'health-history.json');
    const data = loadJSON(HISTORY_FILE);
    const entries = (data.entries || []).slice(-90);
    const trend = entries.length >= 2 ? (entries[entries.length - 1].score - entries[0].score) : 0;
    return json(res, 200, {entries, total: entries.length, trend: trend > 0 ? 'improving' : trend < 0 ? 'declining' : 'stable'});
  }

  // ── Unified activity feed ──
  if (req.method === 'GET' && pathname === '/api/activity-feed') {
    const limit = Math.max(numericParam(url.searchParams.get('limit'), 30, 100), 0);
    try {
      const events = [];
      const comments = loadJSON(COMMENTS_FILE);
      for (const [page, pageComments] of Object.entries(comments)) {
        if (Array.isArray(pageComments)) {
          for (const c of pageComments) {
            events.push({type: 'comment', page, author: c.author, preview: (c.text || '').slice(0, 80), timestamp: c.createdAt});
          }
        }
      }
      const discData = loadJSON(DISCUSSIONS_FILE);
      for (const [channelId, msgs] of Object.entries(discData.messages || {})) {
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            events.push({type: 'message', channel: channelId, author: m.author, preview: (m.text || '').slice(0, 80), timestamp: m.createdAt});
          }
        }
      }
      const annotations = loadJSON(ANNOTATIONS_FILE);
      for (const [page, anns] of Object.entries(annotations)) {
        if (Array.isArray(anns)) {
          for (const a of anns) {
            events.push({type: 'annotation', page, author: a.author, preview: (a.text || '').slice(0, 80), timestamp: a.createdAt});
          }
        }
      }
      const REVIEWS_FILE = path.join(PROJECT_ROOT, 'data', 'reviews.json');
      const reviewData = loadJSON(REVIEWS_FILE);
      for (const r of (reviewData.reviews || [])) {
        events.push({type: 'review', path: r.path, author: r.requestedBy, status: r.status, timestamp: r.createdAt});
      }
      events.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      return json(res, 200, {events: events.slice(0, limit), total: events.length});
    } catch {
      return json(res, 500, {error: 'Activity feed failed'});
    }
  }

  // ── Enhanced content recommendations v2 ──
  if (req.method === 'GET' && pathname === '/api/content-recommend-v2') {
    const sourcePath = url.searchParams.get('path');
    if (!isValidFilePath(sourcePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // Memoize the per-source-path computation (source read, tag/keyword/citation
      // extraction, the recursive content-tree scan, and the sort) for 60s, mirroring
      // the sibling cached('word-frequency:' + dir) and cached('trajectory:' + key)
      // handlers in this module family. The handler reads a `path` query parameter, so
      // the key carries `sourcePath`: every source path gets its own cache entry and the
      // recommendation set is deterministic for that path's content state. Serving a 60s
      // snapshot skips the readdirSync/readFileSync walk on repeat requests while leaving
      // the payload byte identical. The isValidFilePath 400 guard stays above this try,
      // and the try/catch stays outside the closure, so an invalid path never scans and a
      // missing source file returns a 404 that is never cached.
      const result = cached('recommendv2:' + sourcePath, 60000, () => {
        const sourceContent = fs.readFileSync(path.join(PROJECT_ROOT, sourcePath), 'utf-8');
        const sourceFm = sourceContent.match(/^---\n([\s\S]*?)\n---/);
        const sourceTags = new Set();
        if (sourceFm) {
          const tgm = sourceFm[1].match(/^tags:\s*\[([^\]]*)\]/m);
          if (tgm) tgm[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(t => sourceTags.add(t));
        }
        const sourceWords = new Set(sourceContent.replace(/^---[\s\S]*?---/, '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4 && !RECOMMEND_STOP_WORDS.has(w)));
        const sourceCites = new Set();
        let m;
        RECOMMEND_CITE_RE.lastIndex = 0;
        while ((m = RECOMMEND_CITE_RE.exec(sourceContent)) !== null) sourceCites.add(m[1]);
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const candidates = [];
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            const rel = path.relative(PROJECT_ROOT, fp);
            if (rel === sourcePath) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              let score = 0;
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const pageTags = new Set();
              if (fm) {
                const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                if (tm) title = tm[1];
                const tgm = fm[1].match(/^tags:\s*\[([^\]]*)\]/m);
                if (tgm) tgm[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(t => pageTags.add(t));
              }
              for (const t of pageTags) { if (sourceTags.has(t)) score += 5; }
              const pageWords = content.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4 && !RECOMMEND_STOP_WORDS.has(w));
              let wordOverlap = 0;
              for (const w of pageWords) { if (sourceWords.has(w)) wordOverlap++; }
              score += Math.min(wordOverlap / Math.max(pageWords.length, 1) * 10, 5);
              RECOMMEND_CITE_RE.lastIndex = 0;
              const pageCites = new Set();
              while ((m = RECOMMEND_CITE_RE.exec(content)) !== null) pageCites.add(m[1]);
              let citeOverlap = 0;
              for (const c of pageCites) { if (sourceCites.has(c)) citeOverlap++; }
              score += citeOverlap * 3;
              if (score > 1) candidates.push({path: rel, title, score: Math.round(score * 10) / 10, sharedTags: [...pageTags].filter(t => sourceTags.has(t)), sharedCitations: citeOverlap});
            } catch {}
          }
        }
        scan(contentDir);
        candidates.sort((a, b) => b.score - a.score);
        return {recommendations: candidates.slice(0, 10), sourcePath, basedOn: {tags: sourceTags.size, keywords: sourceWords.size, citations: sourceCites.size}};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Search analytics ──
  if (req.method === 'GET' && pathname === '/api/search/analytics') {
    try {
      const HISTORY_FILE = path.join(PROJECT_ROOT, 'data', 'search-history.json');
      const data = loadJSON(HISTORY_FILE);
      const searches = data.searches || [];
      const queryCounts = {};
      let zeroResults = 0;
      // Collect the zero-result queries during this pass rather than re-filtering
      // `searches` afterward. Pushing inside the existing `resultCount === 0` branch
      // preserves source order, so the Set dedup and slice below stay byte identical.
      const zeroResultQueries = [];
      const byDay = {};
      for (const s of searches) {
        queryCounts[s.query] = (queryCounts[s.query] || 0) + 1;
        if (s.resultCount === 0) {
          zeroResults++;
          zeroResultQueries.push(s.query);
        }
        if (s.timestamp) {
          const day = s.timestamp.slice(0, 10);
          byDay[day] = (byDay[day] || 0) + 1;
        }
      }
      const topQueries = Object.entries(queryCounts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([q, c]) => ({query: q, count: c}));
      const uniqueZero = [...new Set(zeroResultQueries)].slice(0, 10);
      const dailyVolume = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({day, count}));
      return json(res, 200, {
        totalSearches: searches.length,
        uniqueQueries: Object.keys(queryCounts).length,
        zeroResultCount: zeroResults,
        topQueries,
        zeroResultQueries: uniqueZero,
        dailyVolume: dailyVolume.slice(-30),
      });
    } catch {
      return json(res, 500, {error: 'Search analytics failed'});
    }
  }

  // ── Individual file health score ──
  if (req.method === 'GET' && pathname === '/api/file/health') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // Memoize the single file read and health scoring for 30s, mirroring the
      // sibling cached('filestyle:' + path) and cached('filecomplexity:' + path)
      // per-file caches in content-analysis-b.js. The score is a pure function of
      // the file bytes, so the key carries filePath: each path gets its own entry
      // and a 30s snapshot stays byte identical while skipping the repeat read. The
      // isValidFilePath 400 guard stays above this try, and the try/catch stays
      // outside the closure, so an invalid path never reads and a missing file
      // returns a 404 that is never cached (the cached helper stores nothing when fn
      // throws).
      const result = cached('filehealth:' + filePath, 30000, () => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
        const fm = content.match(/^---\n([\s\S]*?)\n---/);
        let score = 0;
        const checks = {};
        checks.hasFrontmatter = !!fm;
        if (fm) { const fmBody = fm[1]; score += 10; checks.hasTitle = /^title:/m.test(fmBody); if (checks.hasTitle) score += 10; checks.hasTags = /^tags:/m.test(fmBody); if (checks.hasTags) score += 5; checks.hasDate = /^date:/m.test(fmBody); if (checks.hasDate) score += 5; }
        const words = content.split(/\s+/).filter(Boolean).length;
        checks.wordCount = words;
        score += Math.min(20, Math.round(words / 50));
        const headings = (content.match(/^#{1,6}\s+.+$/gm) || []).length;
        checks.headings = headings;
        score += Math.min(15, headings * 3);
        const citations = (content.match(/\[@/g) || []).length;
        checks.citations = citations;
        score += Math.min(10, citations * 2);
        const links = (content.match(/\[\[/g) || []).length + (content.match(/\]\(/g) || []).length;
        checks.links = links;
        score += Math.min(10, links * 2);
        const images = (content.match(/!\[/g) || []).length;
        checks.images = images;
        score += Math.min(5, images * 3);
        const imgNoAlt = (content.match(/!\[\]\(/g) || []).length;
        if (imgNoAlt > 0) { score -= 5; checks.imagesWithoutAlt = imgNoAlt; }
        score = Math.max(0, Math.min(100, score));
        const level = score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'adequate' : score >= 20 ? 'needs-improvement' : 'minimal';
        return {path: filePath, healthScore: score, level, checks};
      });
      return json(res, 200, result);
    } catch { return json(res, 404, {error: 'File not found'}); }
  }

  // ── Content reading path generator ──
  if (req.method === 'GET' && pathname === '/api/content-reading-path') {
    const startPath = url.searchParams.get('start');
    const maxDepth = numericParam(url.searchParams.get('depth'), 3, 5);
    if (!isValidFilePath(startPath)) return json(res, 400, {error: 'Invalid start path'});
    try {
      // Memoize the full content/ walk and depth-bounded BFS for 60s, mirroring the
      // sibling cached('word-frequency:' + dir), cached('content-summary'), and
      // cached('stats-overview') handlers in this file. The reading path is a pure
      // function of the content/ files plus startPath and maxDepth, so the key carries
      // both: each (start, depth) pair gets its own entry and a 60s snapshot stays byte
      // identical while skipping the repeat readdirSync/readFileSync walk. The
      // isValidFilePath 400 guard and the maxDepth parse stay above this try, and the
      // try/catch stays outside the closure, so an invalid start never scans and a
      // failed scan returns a 404 that is never cached (the cached helper stores
      // nothing when fn throws).
      const result = cached('readingpath:' + startPath + ':' + maxDepth, 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const pageLinks = {};
        const pageTitles = {};
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            const rel = path.relative(PROJECT_ROOT, fp);
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              pageTitles[rel] = title;
              READING_PATH_WIKI_RE.lastIndex = 0;
              const links = [];
              let m;
              while ((m = READING_PATH_WIKI_RE.exec(content)) !== null) links.push(m[1].trim());
              pageLinks[rel] = links;
            } catch {}
          }
        }
        scan(contentDir);
        // pageTitles is fully populated by scan() above and is never mutated inside
        // walk(), so its key list is loop-invariant. Compute it once here instead of
        // rebuilding Object.keys(pageTitles) on every link resolution. The key order
        // is unchanged, so .find() returns the same first match for every link.
        const pageTitleKeys = Object.keys(pageTitles);
        const visited = new Set();
        const readingPath = [];
        function walk(filePath, depth) {
          if (depth > maxDepth || visited.has(filePath)) return;
          visited.add(filePath);
          readingPath.push({path: filePath, title: pageTitles[filePath] || filePath, depth});
          for (const link of (pageLinks[filePath] || [])) {
            const resolved = pageTitleKeys.find(p => p.endsWith(link + '.md') || p.endsWith(link + '.mdx') || p.includes('/' + link + '.'));
            if (resolved && !visited.has(resolved)) {
              walk(resolved, depth + 1);
            }
          }
        }
        walk(startPath, 0);
        return {startPath, readingPath, totalPages: readingPath.length, maxDepthReached: Math.max(0, ...readingPath.map(p => p.depth))};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'Start path not found'});
    }
  }

  // ── Bibliography JSON export ──
  if (req.method === 'GET' && pathname === '/api/references/export-json') {
    try {
      const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
      const jsonStr = JSON.stringify(refs, null, 2);
      res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="references.json"', 'Access-Control-Allow-Origin': CORS_ORIGIN});
      return res.end(jsonStr);
    } catch {
      return json(res, 500, {error: 'JSON export failed'});
    }
  }

  // ── Word frequency by directory ──
  if (req.method === 'GET' && pathname === '/api/stats/word-frequency') {
    const dir = url.searchParams.get('dir');
    if (!isValidDir(dir)) return json(res, 400, {error: 'Invalid directory'});
    try {
      // Memoize the recursive directory scan and assembled frequency table for 60s,
      // mirroring the sibling cached('stats-overview'), cached('content-summary'),
      // and cached('citations-per-page') handlers in this file. Unlike those, this
      // handler reads a `dir` query parameter, so the key carries `dir`: every
      // validated directory gets its own cache entry and the table is deterministic
      // for that directory's content state. Serving a 60s snapshot skips the
      // readdirSync/readFileSync walk on repeat requests while leaving the payload
      // byte identical. The isValidDir 400 guard stays above this try, and the
      // try/catch stays outside the closure, so an invalid directory never scans and
      // a failed scan returns a 500 that is never cached.
      const result = cached('word-frequency:' + dir, 60000, () => {
        const fullDir = path.join(PROJECT_ROOT, dir);
        const freq = {};
        function scan(d) {
          for (const entry of fs.readdirSync(d, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(d, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                let text = fs.readFileSync(fp, 'utf-8');
                text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/[^a-zA-Z\s]/g, ' ');
                text.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !WORD_FREQ_STOP_WORDS.has(w)).forEach(w => { freq[w] = (freq[w] || 0) + 1; });
              } catch {}
            }
          }
        }
        scan(fullDir);
        const words = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([word, count]) => ({word, count}));
        return {directory: dir, words, totalUniqueWords: Object.keys(freq).length};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 500, {error: 'Word frequency failed'});
    }
  }

  // ── Analytics CSV export ──
  if (req.method === 'GET' && pathname === '/api/analytics/export') {
    const format = url.searchParams.get('format') || 'csv';
    if (format !== 'csv') return json(res, 400, {error: 'Only CSV format supported'});
    try {
      const analytics = loadJSON(ANALYTICS_FILE);
      const counts = analytics.counts || {};
      let csv = 'Page,Views\n';
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      for (const [page, views] of sorted) {
        csv += `"${page.replace(/"/g, '""')}",${views}\n`;
      }
      res.writeHead(200, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="analytics.csv"', 'Access-Control-Allow-Origin': CORS_ORIGIN});
      return res.end(csv);
    } catch {
      return json(res, 500, {error: 'CSV export failed'});
    }
  }

  // ── Semantic search with relevance scoring ──
  if (req.method === 'GET' && pathname === '/api/search/semantic') {
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query) return json(res, 400, {error: 'Missing query'});
    try {
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const results = [];
      function scan(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scan(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          try {
            const content = fs.readFileSync(fp, 'utf-8');
            const lower = content.toLowerCase();
            if (!lower.includes(query)) continue;
            let score = 0;
            const fm = content.match(/^---\n([\s\S]*?)\n---/);
            let title = entry.name.replace(/\.(mdx?|md)$/, '');
            if (fm) {
              const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
              if (tm) title = tm[1];
              if (tm && tm[1].toLowerCase().includes(query)) score += 10;
            }
            const headings = content.match(/^#{1,6}\s+.+$/gm) || [];
            for (const h of headings) { if (h.toLowerCase().includes(query)) score += 5; }
            const bodyOccurrences = lower.split(query).length - 1;
            score += Math.min(bodyOccurrences, 20);
            const idx = lower.indexOf(query);
            const start = Math.max(0, idx - 50);
            const end = Math.min(content.length, idx + query.length + 100);
            const snippet = content.slice(start, end).replace(/\n/g, ' ').trim();
            results.push({path: path.relative(PROJECT_ROOT, fp), title, score, snippet: (start > 0 ? '...' : '') + snippet + (end < content.length ? '...' : ''), occurrences: bodyOccurrences});
          } catch {}
        }
      }
      scan(contentDir);
      results.sort((a, b) => b.score - a.score);
      return json(res, 200, {results: results.slice(0, 20), total: results.length, query});
    } catch {
      return json(res, 500, {error: 'Semantic search failed'});
    }
  }

  // ── Reference field auto-fill ──
  if (req.method === 'GET' && pathname === '/api/references/autofill') {
    const key = url.searchParams.get('key');
    if (!key) return json(res, 400, {error: 'Missing key'});
    try {
      const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
      const entry = refs[key];
      if (!entry) return json(res, 404, {error: 'Reference not found'});
      const suggestions = {};
      const FIELDS = ['type', 'venue', 'doi', 'url'];
      // Lowercase the source entry's authors once, into a Set, instead of
      // re-lowercasing them inside the innermost comparison for every otherEntry.
      // entry.author is identical across all FIELDS, so building the Set above the
      // loop is behavior preserving: an otherEntry matches iff one of its authors
      // equals a source author case-insensitively, exactly as before.
      const srcAuthors = entry.author || [];
      const srcAuthorsLower = new Set(srcAuthors.map(a => a.toLowerCase()));
      // refs is a const from loadReferencesCached and is neither reassigned nor
      // mutated in this handler (the loops only read otherEntry and push into the
      // separate suggestions object, with no intervening await), so
      // Object.entries(refs) yields the same entries in the same order on every
      // field iteration. Compute it once here instead of rebuilding it up to four
      // times, once per FIELD; enumerating the single refEntries array scans the
      // identical candidates in the identical order, so every suggestions[field]
      // (value + source, capped at 3) stays byte identical.
      const refEntries = Object.entries(refs);
      for (const field of FIELDS) {
        if (entry[field]) continue;
        if (srcAuthors.length === 0) continue;
        for (const [otherKey, otherEntry] of refEntries) {
          if (otherKey === key || !otherEntry[field]) continue;
          const otherAuthors = otherEntry.author || [];
          if (otherAuthors.some(oa => srcAuthorsLower.has(oa.toLowerCase()))) {
            if (!suggestions[field]) suggestions[field] = [];
            if (suggestions[field].length < 3) suggestions[field].push({value: otherEntry[field], source: otherKey});
          }
        }
      }
      return json(res, 200, {key, currentEntry: entry, suggestions});
    } catch {
      return json(res, 500, {error: 'Autofill failed'});
    }
  }

  // ── Brief content summary ──
  if (req.method === 'GET' && pathname === '/api/content-summary') {
    try {
      // Memoize the recursive content scan, the references count, and the
      // assembled summary for 60s, mirroring the sibling cached('stats-overview'),
      // cached('citations-per-page'), and cached('link-density') handlers in this
      // file. The handler takes no query parameters, so a single static key serves
      // every request, and the summary is deterministic for a given content state:
      // serving a 60s snapshot skips the readdirSync/readFileSync walk on repeat
      // requests while leaving the payload byte identical. The try/catch stays
      // outside the closure so a failed scan returns a 500 that is never cached.
      const summary = cached('content-summary', 60000, () => {
        let files = 0, words = 0, refs = 0;
        const contentDir = path.join(PROJECT_ROOT, 'content');
        function scan(dir) { for (const e of fs.readdirSync(dir, {withFileTypes: true})) { if (e.name.startsWith('.')) continue; const fp = path.join(dir, e.name); if (e.isDirectory()) { scan(fp); continue; } if (ALLOWED_EXTS.some(ext => e.name.endsWith(ext))) { files++; try { words += fs.readFileSync(fp, 'utf-8').split(/\s+/).filter(Boolean).length; } catch {} } } }
        scan(contentDir);
        try { refs = Object.keys(loadReferencesCached(fs, path, PROJECT_ROOT)).length; } catch {}
        return {files, words, references: refs, readingHours: Math.round(words / 200 / 60 * 10) / 10};
      });
      return json(res, 200, summary);
    } catch { return json(res, 500, {error: 'Summary failed'}); }
  }

  // ── Random reference ──
  if (req.method === 'GET' && pathname === '/api/references/random') {
    try {
      const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
      const keys = Object.keys(refs);
      if (keys.length === 0) return json(res, 200, {reference: null});
      const idx = Math.floor(Math.random() * keys.length);
      const key = keys[idx];
      return json(res, 200, {key, ...refs[key]});
    } catch { return json(res, 500, {error: 'Random failed'}); }
  }

  // ── Citations per page ranking ──
  if (req.method === 'GET' && pathname === '/api/stats/citations-per-page') {
    try {
      // Memoize the recursive content scan, sort, and assembled ranking for 60s,
      // mirroring the sibling cached('stats-overview'), cached('link-density'), and
      // cached('kb-outline') handlers in this file. The handler takes no query
      // parameters, so a single static key serves every request, and the ranking is
      // deterministic for a given content state: serving a 60s snapshot skips the
      // readdirSync/readFileSync walk on repeat requests while leaving the payload
      // byte identical. The try/catch stays outside the closure so a failed scan
      // returns a 500 that is never cached.
      const result = cached('citations-per-page', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const pages = [];
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const citations = (content.match(/\[@/g) || []).length;
              const words = content.split(/\s+/).filter(Boolean).length;
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              pages.push({path: path.relative(PROJECT_ROOT, fp), title, citations, words, citationsPerKWords: words > 0 ? Math.round((citations / words) * 1000 * 10) / 10 : 0});
            } catch {}
          }
        }
        scan(contentDir);
        pages.sort((a, b) => b.citations - a.citations);
        return {pages: pages.slice(0, 20), total: pages.length, avgCitations: Math.round(pages.reduce((s, p) => s + p.citations, 0) / Math.max(pages.length, 1) * 10) / 10};
      });
      return json(res, 200, result);
    } catch { return json(res, 500, {error: 'Citation density failed'}); }
  }

  // ── Nested heading tree for a file ──
  if (req.method === 'GET' && pathname === '/api/file/toc-tree') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // Memoize the single file read and heading-tree build for 30s, mirroring the
      // sibling cached('filestyle:' + path) and cached('filecomplexity:' + path)
      // per-file caches in content-analysis-b.js. The tree is a pure function of the
      // file bytes, so the key carries filePath: each path gets its own entry and a
      // 30s snapshot stays byte identical while skipping the repeat read. The
      // isValidFilePath 400 guard stays above this try, and the try/catch stays
      // outside the closure, so an invalid path never reads and a missing file
      // returns a 404 that is never cached (the cached helper stores nothing when fn
      // throws).
      const result = cached('toctree:' + filePath, 30000, () => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
        const flat = [];
        let inCode = false;
        for (const line of content.split('\n')) {
          if (line.startsWith('```')) { inCode = !inCode; continue; }
          if (inCode) continue;
          const m = line.match(/^(#{1,6})\s+(.+)$/);
          if (m) flat.push({level: m[1].length, text: m[2].trim()});
        }
        function buildTree(items, minLevel) {
          const tree = [];
          let i = 0;
          while (i < items.length) {
            const item = items[i];
            if (item.level === minLevel) {
              const children = [];
              i++;
              while (i < items.length && items[i].level > minLevel) { children.push(items[i]); i++; }
              tree.push({text: item.text, level: item.level, children: children.length > 0 ? buildTree(children, minLevel + 1) : []});
            } else { i++; }
          }
          return tree;
        }
        const minLevel = flat.length > 0 ? Math.min(...flat.map(h => h.level)) : 1;
        return {tree: buildTree(flat, minLevel), totalHeadings: flat.length};
      });
      return json(res, 200, result);
    } catch { return json(res, 404, {error: 'File not found'}); }
  }

  // ── Directory statistics comparison ──
  if (req.method === 'GET' && pathname === '/api/stats/compare') {
    const dir1 = url.searchParams.get('dir1');
    const dir2 = url.searchParams.get('dir2');
    if (!isValidDir(dir1) || !isValidDir(dir2)) return json(res, 400, {error: 'Invalid directories'});
    try {
      // Memoize the two-directory recursive scan and the assembled comparison for
      // 30s, mirroring the sibling cached('similarity:' + path1 + ':' + path2) and
      // cached('word-frequency:' + dir) caches in this file. The payload is a pure
      // function of the files under dir1 and dir2 plus the two query params — no
      // Date, randomness, network, mutable-store read, or wall-clock stamp (unlike
      // the productivity-report's generatedAt) — so the key carries both directories:
      // each (dir1, dir2) pair gets its own entry and a 30s snapshot stays byte
      // identical while skipping the repeat readdirSync/readFileSync word and heading
      // scan. The two isValidDir 400 guards stay above this try, and the try/catch
      // stays outside the closure, so invalid input never scans and a failed scan
      // returns a 500 that is never cached (the cached helper stores nothing when fn
      // throws).
      const result = cached('statscompare:' + dir1 + ':' + dir2, 30000, () => {
        function dirStats(dirPath) {
          const fullDir = path.join(PROJECT_ROOT, dirPath);
          let files = 0, words = 0, headings = 0;
          function scan(dir) {
            for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
              if (entry.name.startsWith('.')) continue;
              const fp = path.join(dir, entry.name);
              if (entry.isDirectory()) { scan(fp); continue; }
              if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
                files++;
                try {
                  const c = fs.readFileSync(fp, 'utf-8');
                  words += c.split(/\s+/).filter(Boolean).length;
                  headings += (c.match(/^#{1,6}\s+/gm) || []).length;
                } catch {}
              }
            }
          }
          scan(fullDir);
          return {directory: dirPath, files, words, headings, avgWordsPerFile: files > 0 ? Math.round(words / files) : 0};
        }
        const stats1 = dirStats(dir1);
        const stats2 = dirStats(dir2);
        return {dir1: stats1, dir2: stats2, comparison: {
          fileDiff: stats1.files - stats2.files,
          wordDiff: stats1.words - stats2.words,
          avgWordsDiff: stats1.avgWordsPerFile - stats2.avgWordsPerFile,
        }};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 500, {error: 'Comparison failed'});
    }
  }

  // ── File merge ──
  if (req.method === 'POST' && pathname === '/api/files/merge') {
    if (!rateLimit(`file-merge:${req.socket.remoteAddress}`, 5)) return json(res, 429, {error: 'Too many requests.'});
    try {
      const body = await readBody(req);
      const {sourcePath, targetPath, separator} = body;
      if (!sourcePath || typeof sourcePath !== 'string') return json(res, 400, {error: 'Missing or invalid sourcePath'});
      if (!targetPath || typeof targetPath !== 'string') return json(res, 400, {error: 'Missing or invalid targetPath'});
      if (!isValidFilePath(sourcePath) || !isValidFilePath(targetPath)) return json(res, 400, {error: 'Invalid paths'});
      if (sourcePath === targetPath) return json(res, 400, {error: 'Source and target paths must be different'});
      if (separator !== undefined && typeof separator !== 'string') return json(res, 400, {error: 'separator must be a string'});
      if (separator && separator.length > 500) return json(res, 400, {error: 'separator must be 500 characters or fewer'});
      const sourceContent = fs.readFileSync(path.join(PROJECT_ROOT, sourcePath), 'utf-8');
      const targetContent = fs.readFileSync(path.join(PROJECT_ROOT, targetPath), 'utf-8');
      let sourceBody = sourceContent;
      const sourceFm = sourceContent.match(/^---\n([\s\S]*?)\n---\n?/);
      let sourceTitle = 'Merged Content';
      if (sourceFm) {
        sourceBody = sourceContent.slice(sourceFm[0].length);
        const tm = sourceFm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
        if (tm) sourceTitle = tm[1];
      }
      const sep = separator || `\n\n---\n\n## ${sourceTitle}\n\n`;
      const merged = targetContent + sep + sourceBody;
      fs.writeFileSync(path.join(PROJECT_ROOT, targetPath), merged, 'utf-8');
      invalidateCache('search');
      return json(res, 200, {success: true, targetPath, mergedWordCount: merged.split(/\s+/).filter(Boolean).length});
    } catch {
      return json(res, 400, {error: 'Merge failed'});
    }
  }

  // ── Citation impact trajectory ──
  if (req.method === 'GET' && pathname === '/api/references/trajectory') {
    const key = url.searchParams.get('key');
    if (!key) return json(res, 400, {error: 'Missing key'});
    try {
      const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
      if (!refs[key]) return json(res, 404, {error: 'Reference not found'});
      // Cache the per-key content-tree walk for 60s, mirroring the sibling
      // per-target caches in this module family (cached('word-frequency:' + dir)
      // above, cached('related:' + filePath) in file-tools). The cache key
      // includes `key` so each citation key is its own entry. The missing-key 400
      // and the reference-not-found 404 both return BEFORE this call, so only a
      // successful scan is memoized. `title` is read from refs[key] outside the
      // cache, so the {key, title, trajectory, totalCitations} payload and its
      // field order stay byte-identical to the pre-cache output.
      const trajectory = cached('trajectory:' + key, 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const CITE_PAT = new RegExp(`\\[@[^\\]]*\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        const citingPages = [];
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              CITE_PAT.lastIndex = 0;
              if (CITE_PAT.test(content)) {
                const stat = fs.statSync(fp);
                let title = entry.name.replace(/\.(mdx?|md)$/, '');
                const fm = content.match(/^---\n([\s\S]*?)\n---/);
                let date = stat.mtime.toISOString().slice(0, 10);
                if (fm) {
                  const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                  if (tm) title = tm[1];
                  const dm = fm[1].match(/^date:\s*["']?(\d{4}-\d{2}-\d{2})/m);
                  if (dm) date = dm[1];
                }
                citingPages.push({path: path.relative(PROJECT_ROOT, fp), title, date});
              }
            } catch {}
          }
        }
        scan(contentDir);
        citingPages.sort((a, b) => a.date.localeCompare(b.date));
        return citingPages;
      });
      return json(res, 200, {key, title: refs[key].title, trajectory, totalCitations: trajectory.length});
    } catch {
      return json(res, 500, {error: 'Trajectory analysis failed'});
    }
  }

  // ── Content topic modeling ──
  if (req.method === 'GET' && pathname === '/api/content-topics') {
    try {
      const topics = cached('content-topics', 120000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const STOP = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not','can','all','each','some','more','most','other','also','than','very','just','such','only','about','into','over','after','which','where','what','when','they','them','their','we','our','you','your','these','those','been','being','would','could','should','using','used','based','between','through','during','while','before','since','both','each','own','same','new','like','many','much','data','make','way','time','work','first','well','need','even','find','give','take','come','know','good','long','high','back','see','part','use','two','how','one','may']);
        const pageTopics = [];
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              let text = fs.readFileSync(fp, 'utf-8');
              text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '').replace(/[^a-zA-Z\s]/g, ' ');
              const freq = {};
              text.toLowerCase().split(/\s+/).filter(w => w.length > 4 && !STOP.has(w)).forEach(w => { freq[w] = (freq[w] || 0) + 1; });
              const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = text.match(/title:\s*["']?(.+?)["']?\s*$/m);
              if (fm) title = fm[1];
              if (topWords.length > 0) pageTopics.push({path: path.relative(PROJECT_ROOT, fp), title, topWords});
            } catch {}
          }
        }
        scan(contentDir);
        const topicGroups = {};
        for (const page of pageTopics) {
          const primaryTopic = page.topWords[0];
          if (!topicGroups[primaryTopic]) topicGroups[primaryTopic] = [];
          topicGroups[primaryTopic].push({path: page.path, title: page.title});
        }
        return Object.entries(topicGroups)
          .filter(([, pages]) => pages.length >= 2)
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 20)
          .map(([topic, pages]) => ({topic, pageCount: pages.length, pages: pages.slice(0, 10)}));
      });
      return json(res, 200, {topics, totalTopics: topics.length});
    } catch {
      return json(res, 500, {error: 'Topic modeling failed'});
    }
  }

  // ── Reference PageRank scoring ──
  if (req.method === 'GET' && pathname === '/api/references/pagerank') {
    try {
      const ranks = cached('ref-pagerank', 120000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;
        const coOccurrences = {};
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              CITE_RE.lastIndex = 0;
              const pageCites = new Set();
              let m;
              while ((m = CITE_RE.exec(content)) !== null) {
                m[1].split(/\s*;\s*/).map(k => k.replace(/^@/, '')).forEach(k => { if (refs[k]) pageCites.add(k); });
              }
              const arr = [...pageCites];
              for (let i = 0; i < arr.length; i++) {
                const ai = arr[i];
                for (let j = i + 1; j < arr.length; j++) {
                  const aj = arr[j];
                  if (!coOccurrences[ai]) coOccurrences[ai] = {};
                  if (!coOccurrences[aj]) coOccurrences[aj] = {};
                  coOccurrences[ai][aj] = (coOccurrences[ai][aj] || 0) + 1;
                  coOccurrences[aj][ai] = (coOccurrences[aj][ai] || 0) + 1;
                }
              }
            } catch {}
          }
        }
        scan(contentDir);
        const keys = Object.keys(refs);
        const scores = {};
        for (const k of keys) scores[k] = 1;
        const damping = 0.85;
        // Each node's total out-weight is loop-invariant: coOccurrences is fully built by scan() above
        // (there is no await in this thunk) and is only read in the iteration loop below, so compute
        // each neighbor's total once here instead of re-reducing it on all 20 iterations. Iterate the
        // actual neighbor keys and memoize per distinct n with an own-property guard, NOT a plain
        // `for (const n of keys)`: a citation key colliding with an Object.prototype member name (e.g.
        // "valueOf") passes the `if (refs[k])` truthy gate during scan yet is absent from
        // Object.keys(refs), so iterating neighbors is what gives such a key its own outTotals entry
        // and stops `outTotals[n] || 0` from reading an inherited prototype value. Each total uses the
        // identical Object.values(coOccurrences[n] || {}).reduce(...) over the same never-mutated
        // objects, so every totalOut, and thus every rank, stays byte identical to the old inline form.
        const outTotals = {};
        for (const k of keys) {
          const nb = coOccurrences[k];
          if (!nb) continue;
          for (const n of Object.keys(nb)) {
            if (!Object.prototype.hasOwnProperty.call(outTotals, n)) {
              outTotals[n] = Object.values(coOccurrences[n] || {}).reduce((s, v) => s + v, 0);
            }
          }
        }
        for (let iter = 0; iter < 20; iter++) {
          const newScores = {};
          for (const k of keys) {
            let sum = 0;
            const neighbors = coOccurrences[k] || {};
            for (const [n, weight] of Object.entries(neighbors)) {
              const totalOut = outTotals[n] || 0;
              if (totalOut > 0) sum += (scores[n] * weight) / totalOut;
            }
            newScores[k] = (1 - damping) + damping * sum;
          }
          Object.assign(scores, newScores);
        }
        return Object.entries(scores)
          .map(([key, score]) => {
            const r = refs[key];
            return {key, title: r.title, year: r.year, venue: r.venue, rank: Math.round(score * 1000) / 1000};
          })
          .sort((a, b) => b.rank - a.rank)
          .slice(0, 30);
      });
      return json(res, 200, {rankings: ranks, total: ranks.length});
    } catch {
      return json(res, 500, {error: 'PageRank failed'});
    }
  }

};

module.exports.numericParam = numericParam;

// Test hook (not used by routes): clear the shared references.yaml memo (owned by
// the references route) so cache-behavior tests can start from a cold cache.
module.exports._clearReferencesCache = require('./references')._resetReferencesCache;
