'use strict';
// Route module organized from server.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server.js detects a sent response via res.writableEnded.

// Parse a numeric query parameter, clamping to `max` and falling back to `def`
// when the value is absent or non-numeric. Without the fallback a stray
// `?limit=abc` parses to NaN, `Math.min(NaN, 200)` stays NaN, and the
// backlink-ranking page collapses to `ranking.slice(0, NaN)` === empty even when
// matches exist. Absent and valid numeric values keep their previous behavior.
function numericParam(raw, def, max) {
  const n = parseInt(raw, 10);
  return Math.min(Number.isNaN(n) ? def : n, max);
}

// Wiki-link regex for the GET /api/admin/health-summary link-health scan, compiled
// once at module load instead of rebuilt on every request. Because this /g regex is
// now shared module state, the handler resets `lastIndex` before each file's exec
// loop, which keeps the link-health stats identical across back-to-back requests.
// Named distinctly from the alias-aware WIKI_RE inside the backlink-ranking cached
// closure, whose `/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g` also requires the closing `]]`.
const HEALTH_WIKI_LINK_RE = /\[\[([^\]|]+)/g;

// Citation-key regex for the GET /api/writing-prompts cited-key scan, compiled once
// at module load instead of rebuilt on every request. Because this /g regex is now
// shared module state, the handler resets `lastIndex` before each file's exec loop,
// which keeps the cited-key set (and the resulting uncited-reference prompts)
// identical across back-to-back requests. Named distinctly from the per-request
// `CITE_PAT` built for one key in /api/references/abstracts and from the inline
// `content.match(/\[@[\w-]+/g)` one-shots in the quality scorers, which need no
// persistent /g state.
const WRITING_PROMPTS_CITE_RE = /\[@([\w-]+)/g;

// Image-without-alt and heading regexes for the GET /api/file/accessibility
// per-line scan, compiled once at module load instead of rebuilt on every line of
// every request. Both are non-global and read only through String.prototype.match,
// so they hold no lastIndex state and need no per-request reset (unlike the /g scan
// regexes above); one shared instance of each stays correct across back-to-back
// requests, and every issue keeps the same type, order, and line number as before.
const ACCESS_IMG_NOALT_RE = /!\[\]\(/;
const ACCESS_HEADING_RE = /^(#{1,6})\s+/;

// Prototype-pollution guard keys for the POST /api/template-variables handler,
// built once at module load instead of allocated on every request. Used read-only
// via `.has(name)` to reject a variable name (e.g. `__proto__`) that would
// otherwise let a caller poison the saved variables map. The Set carries no
// per-request state, so one shared instance stays correct across requests.
const TEMPLATE_VAR_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Variable-name validation pattern for the POST /api/template-variables handler,
// built once at module load instead of allocated on every request. It is
// non-global and non-sticky and used only through `.test(name)`, so it holds no
// lastIndex state and one shared instance stays correct across requests.
const TEMPLATE_VAR_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

module.exports = async function content_analysis_c_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, collectFeedItems, parseFeedItem, cached, invalidateCache, cleanStalePresence, rateLimit, formatAuthorAPA, formatAuthorMLA, formatAuthorIEEE, formatCitation, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Content publishing workflow status ──
  if (req.method === 'GET' && pathname === '/api/content-status') {
    try {
      const status = cached('content-status', 30000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const byStatus = {published: [], draft: [], review: []};
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              let pageStatus = 'published';
              if (fm) {
                const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                if (tm) title = tm[1];
                if (/^draft:\s*true/m.test(fm[1])) pageStatus = 'draft';
                if (/^status:\s*review/m.test(fm[1])) pageStatus = 'review';
              }
              byStatus[pageStatus].push({path: path.relative(PROJECT_ROOT, fp), title});
            } catch {}
          }
        }
        scan(contentDir);
        return byStatus;
      });
      return json(res, 200, {
        published: status.published.length,
        draft: status.draft.length,
        review: status.review.length,
        total: status.published.length + status.draft.length + status.review.length,
        drafts: status.draft,
        inReview: status.review,
      });
    } catch {
      return json(res, 500, {error: 'Status check failed'});
    }
  }

  // ── Search history tracking ──
  if (req.method === 'POST' && pathname === '/api/search/history') {
    if (!rateLimit(`search-history:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {query, userId, resultCount} = body;
      if (!query || typeof query !== 'string') return json(res, 400, {error: 'Missing or invalid query'});
      if (query.length > 500) return json(res, 400, {error: 'Query must be 500 characters or fewer'});
      if (userId !== undefined && typeof userId !== 'string') return json(res, 400, {error: 'userId must be a string'});
      if (userId && userId.length > 200) return json(res, 400, {error: 'userId must be 200 characters or fewer'});
      if (resultCount !== undefined && (typeof resultCount !== 'number' || !isFinite(resultCount) || resultCount < 0)) return json(res, 400, {error: 'resultCount must be a non-negative number'});
      const HISTORY_FILE = path.join(PROJECT_ROOT, 'data', 'search-history.json');
      const data = loadJSON(HISTORY_FILE);
      if (!data.searches) data.searches = [];
      data.searches.push({
        query: sanitizeText(query),
        userId: userId ? sanitizeText(userId) : 'anonymous',
        resultCount: resultCount || 0,
        timestamp: new Date().toISOString(),
      });
      if (data.searches.length > 1000) data.searches = data.searches.slice(-1000);
      saveJSON(HISTORY_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/search/history') {
    const HISTORY_FILE = path.join(PROJECT_ROOT, 'data', 'search-history.json');
    const data = loadJSON(HISTORY_FILE);
    const searches = (data.searches || []).slice(-50).reverse();
    const topQueries = {};
    for (const s of (data.searches || [])) {
      topQueries[s.query] = (topQueries[s.query] || 0) + 1;
    }
    const popular = Object.entries(topQueries).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([query, count]) => ({query, count}));
    return json(res, 200, {recent: searches, popular, total: (data.searches || []).length});
  }

  // ── Content backlink ranking ──
  if (req.method === 'GET' && pathname === '/api/content-backlink-ranking') {
    try {
      const ranking = cached('backlink-ranking', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const WIKI_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        const incomingCounts = {};
        const pages = new Map();
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            const relPath = path.relative(PROJECT_ROOT, fp);
            let id = path.relative(path.join(PROJECT_ROOT, 'content'), fp).replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
            if (id.endsWith('/index')) id = id.slice(0, -6);
            let title = entry.name.replace(/\.(mdx?|md)$/, '');
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              pages.set(id, {path: relPath, title});
              WIKI_RE.lastIndex = 0;
              let m;
              while ((m = WIKI_RE.exec(content)) !== null) {
                const target = m[1].trim();
                const resolved = [...pages.keys()].find(k => k === target || k.endsWith('/' + target)) || target;
                incomingCounts[resolved] = (incomingCounts[resolved] || 0) + 1;
              }
            } catch {}
          }
        }
        scan(contentDir);
        const ranked = [...pages.entries()].map(([id, info]) => ({
          id, path: info.path, title: info.title,
          incomingLinks: incomingCounts[id] || 0,
        })).sort((a, b) => b.incomingLinks - a.incomingLinks);
        return ranked;
      });
      const limit = Math.max(numericParam(url.searchParams.get('limit'), 30, 200), 0);
      return json(res, 200, {
        pages: ranking.slice(0, limit),
        totalPages: ranking.length,
        mostLinked: ranking.slice(0, 5),
        leastLinked: ranking.filter(p => p.incomingLinks === 0).slice(0, 10),
      });
    } catch {
      return json(res, 500, {error: 'Backlink ranking failed'});
    }
  }

  // ── Admin health summary score ──
  if (req.method === 'GET' && pathname === '/api/admin/health-summary') {
    try {
      // Cache the content-tree walk and score assembly on a 60s window, mirroring
      // the sibling cached scans in this file (content-status, backlink-ranking,
      // content-quality, ...). Repeated requests within the TTL skip the full
      // readdirSync/readFileSync walk and return the memoized result object. The
      // try/catch stays OUTSIDE the closure so a failed scan is never cached, and
      // the HEALTH_WIKI_LINK_RE.lastIndex reset stays INSIDE, before each file's
      // exec loop, so the link-health stats stay correct across requests.
      const summary = cached('health-summary', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        let totalFiles = 0, filesWithTitle = 0, filesWithTags = 0, totalHeadings = 0;
        let totalWords = 0;
        let totalLinks = 0, brokenLinks = 0;
        const pageIds = new Set();
        function collect(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { collect(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            totalFiles++;
            let id = path.relative(path.join(PROJECT_ROOT, 'content'), fp).replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
            if (id.endsWith('/index')) id = id.slice(0, -6);
            pageIds.add(id);
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              totalWords += content.split(/\s+/).filter(Boolean).length;
              totalHeadings += (content.match(/^#{1,6}\s+/gm) || []).length;
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              if (fm) {
                if (/^title:/m.test(fm[1])) filesWithTitle++;
                if (/^tags:/m.test(fm[1])) filesWithTags++;
              }
              HEALTH_WIKI_LINK_RE.lastIndex = 0;
              let m;
              while ((m = HEALTH_WIKI_LINK_RE.exec(content)) !== null) {
                totalLinks++;
                const target = m[1].trim();
                if (!pageIds.has(target) && ![...pageIds].some(id => id.endsWith(target))) brokenLinks++;
              }
            } catch {}
          }
        }
        collect(contentDir);
        const titleScore = totalFiles > 0 ? Math.round((filesWithTitle / totalFiles) * 25) : 0;
        const tagScore = totalFiles > 0 ? Math.round((filesWithTags / totalFiles) * 15) : 0;
        const headingScore = Math.min(20, Math.round((totalHeadings / Math.max(totalFiles, 1)) * 5));
        const wordScore = Math.min(20, Math.round((totalWords / Math.max(totalFiles, 1)) / 100));
        const linkHealthScore = totalLinks > 0 ? Math.round(((totalLinks - brokenLinks) / totalLinks) * 20) : 20;
        const overallScore = Math.min(100, titleScore + tagScore + headingScore + wordScore + linkHealthScore);
        const level = overallScore >= 80 ? 'excellent' : overallScore >= 60 ? 'good' : overallScore >= 40 ? 'adequate' : 'needs-work';
        return {
          score: overallScore,
          level,
          breakdown: {titles: titleScore, tags: tagScore, headings: headingScore, wordCount: wordScore, linkHealth: linkHealthScore},
          stats: {totalFiles, filesWithTitle, filesWithTags, totalWords, totalLinks, brokenLinks},
        };
      });
      return json(res, 200, summary);
    } catch {
      return json(res, 500, {error: 'Health summary failed'});
    }
  }

  // ── Reference abstract/context summary ──
  if (req.method === 'GET' && pathname === '/api/references/abstracts') {
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query) return json(res, 400, {error: 'Missing query'});
    try {
      // Cache the references.yaml parse and the per-key content-tree citation-context
      // walk on a 60s window, keyed by the lowercased/trimmed query, mirroring the
      // sibling cached scans in this file (byauthor:, venuestats:, authorprofile:,
      // diffsummary:, statsdir:). Both inputs are pure functions of on-disk content
      // plus the query, so a short TTL snapshot stays byte identical while skipping
      // the repeat parse and walk. The empty-query 400 guard stays OUTSIDE and ABOVE
      // this closure, so an empty query never reaches the cache; the require('js-yaml'),
      // the references.yaml read, and the match/scan loop stay INSIDE; the try/catch
      // 500 stays OUTSIDE, so a broken references.yaml still returns 500 and is never
      // cached (cached() stores nothing when fn throws). The key carries the query, so
      // each query is a distinct cache entry.
      const result = cached('abstracts:' + query, 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const matches = [];
        for (const [key, entry] of Object.entries(refs)) {
          const searchable = [key, entry.title || '', (entry.author || []).join(' ')].join(' ').toLowerCase();
          if (!searchable.includes(query)) continue;
          const contexts = [];
          const CITE_PAT = new RegExp(`\\[@[^\\]]*\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^\\]]*\\]`, 'g');
          function scanCtx(dir) {
            for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
              if (e.name.startsWith('.')) continue;
              const fp = path.join(dir, e.name);
              if (e.isDirectory()) { scanCtx(fp); continue; }
              if (!ALLOWED_EXTS.some(ext => e.name.endsWith(ext))) continue;
              try {
                const c = fs.readFileSync(fp, 'utf-8');
                CITE_PAT.lastIndex = 0;
                let m;
                while ((m = CITE_PAT.exec(c)) !== null) {
                  const start = Math.max(0, m.index - 80);
                  const end = Math.min(c.length, m.index + m[0].length + 80);
                  contexts.push(c.slice(start, end).replace(/\n/g, ' ').trim());
                  if (contexts.length >= 3) break;
                }
              } catch {}
              if (contexts.length >= 3) break;
            }
          }
          scanCtx(contentDir);
          matches.push({key, title: entry.title, year: entry.year, venue: entry.venue, authors: entry.author, contexts});
          if (matches.length >= 10) break;
        }
        return {results: matches, total: matches.length};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 500, {error: 'Abstract search failed'});
    }
  }

  // ── Content diff summary between two dates ──
  if (req.method === 'GET' && pathname === '/api/content-diff-summary') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to') || new Date().toISOString().slice(0, 10);
    if (!from) return json(res, 400, {error: 'Missing from date (YYYY-MM-DD)'});
    try {
      // Cache the content-tree date-range walk on a 30s window, keyed by both date
      // params, mirroring the sibling cached scans in this file (content-status,
      // health-summary, statsdir:, ...). The walk reads only file timestamps (no
      // request state), so it is deterministic given the range and safe to memoize:
      // repeated requests for the same [from, to] skip the readdirSync/statSync walk
      // and return the memoized {created, modified}. The 400 missing-from guard, the
      // per-request `to` default, the try/catch 500 path, and the .slice(0, 50)
      // previews + counts all stay OUTSIDE the closure, so a failed scan still
      // propagates to the outer catch as a 500 and only a successful scan is ever
      // cached. The key carries both dates, so each range is a distinct cache entry.
      const {created, modified} = cached('diffsummary:' + from + ':' + to, 30000, () => {
        const fromDate = new Date(from + 'T00:00:00Z');
        const toDate = new Date(to + 'T23:59:59Z');
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const modified = [], created = [];
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const stat = fs.statSync(fp);
              const mtime = stat.mtime;
              const ctime = stat.birthtime;
              const relPath = path.relative(PROJECT_ROOT, fp);
              if (mtime >= fromDate && mtime <= toDate) {
                if (ctime >= fromDate && ctime <= toDate) {
                  created.push({path: relPath, date: mtime.toISOString().slice(0, 10)});
                } else {
                  modified.push({path: relPath, date: mtime.toISOString().slice(0, 10)});
                }
              }
            } catch {}
          }
        }
        scan(contentDir);
        return {created, modified};
      });
      return json(res, 200, {
        from, to,
        created: created.length,
        modified: modified.length,
        total: created.length + modified.length,
        createdFiles: created.slice(0, 50),
        modifiedFiles: modified.slice(0, 50),
      });
    } catch {
      return json(res, 500, {error: 'Diff summary failed'});
    }
  }

  // ── Content accessibility check ──
  if (req.method === 'GET' && pathname === '/api/file/accessibility') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // The a11y issue list and score are a pure function of this one file's
      // content, so memoize the whole payload keyed by path for the TTL while the
      // json() write below still runs on every request. Mirrors the per-path caches
      // in this file (mentions:, statsdir:) and the blessed filestyle: cache in
      // content-analysis-b.js. The readFileSync stays INSIDE the closure, so a
      // missing file still throws into the outer catch and the 404 is never cached
      // (cached stores nothing when fn throws).
      const result = cached('accessibility:' + filePath, 30000, () => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
        const issues = [];
        const lines = content.split('\n');
        let lastHeadingLevel = 0;
        let inCode = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith('```')) { inCode = !inCode; continue; }
          if (inCode) continue;
          const imgNoAlt = line.match(ACCESS_IMG_NOALT_RE);
          if (imgNoAlt) issues.push({line: i + 1, type: 'warning', message: 'Image without alt text'});
          const headingMatch = line.match(ACCESS_HEADING_RE);
          if (headingMatch) {
            const level = headingMatch[1].length;
            if (lastHeadingLevel > 0 && level > lastHeadingLevel + 1) {
              issues.push({line: i + 1, type: 'info', message: `Heading level skipped: h${lastHeadingLevel} to h${level}`});
            }
            lastHeadingLevel = level;
          }
        }
        // Tally the warning and info issue types in a single walk of `issues`, then
        // score from the tallies. This replaces the two `issues.filter(...).length`
        // passes with one loop; the same categories, multipliers, and Math.max(0, ...)
        // clamp keep `score` (and every other response field) byte identical.
        let warningCount = 0, infoCount = 0;
        for (const iss of issues) {
          if (iss.type === 'warning') warningCount++;
          else if (iss.type === 'info') infoCount++;
        }
        const score = Math.max(0, 100 - warningCount * 10 - infoCount * 3);
        return {path: filePath, score, issues, issueCount: issues.length};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── JSON-LD structured data ──
  if (req.method === 'GET' && pathname === '/api/file/jsonld') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // The JSON-LD object is a pure function of this one file's content plus its
      // stored mtime, so memoize the whole payload keyed by path for the TTL while
      // the json() write below still runs on every request. The stat.mtime read is
      // deterministic, exactly like the blessed fileinfo: cache in
      // graph-trash-files.js, so the statSync stays INSIDE the closure alongside the
      // readFileSync; both throw into the outer catch for a missing file, so the 404
      // is never cached (cached stores nothing when fn throws).
      const result = cached('jsonld:' + filePath, 30000, () => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
        const stat = fs.statSync(path.join(PROJECT_ROOT, filePath));
        const mtimeIso = stat.mtime.toISOString();
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let title = path.basename(filePath, path.extname(filePath));
        let date = mtimeIso;
        let description = '';
        let tags = [];
        let authors = [];
        if (fmMatch) {
          const fm = fmMatch[1];
          const tm = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
          if (tm) title = tm[1];
          const dm = fm.match(/^date:\s*["']?(\d{4}-\d{2}-\d{2})/m);
          if (dm) date = dm[1] + 'T00:00:00Z';
          const desc = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
          if (desc) description = desc[1];
          const tgm = fm.match(/^tags:\s*\[([^\]]*)\]/m);
          if (tgm) tags = tgm[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
          const auth = fm.match(/^authors:\s*\[([^\]]*)\]/m);
          if (auth) authors = auth[1].split(',').map(a => a.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        }
        const wordCount = content.split(/\s+/).filter(Boolean).length;
        return {
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: title,
          datePublished: date,
          dateModified: mtimeIso,
          wordCount,
          ...(description && {description}),
          ...(authors.length > 0 && {author: authors.map(a => ({'@type': 'Person', name: a}))}),
          ...(tags.length > 0 && {keywords: tags.join(', ')}),
        };
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── XML Sitemap ──
  if (req.method === 'GET' && pathname === '/api/sitemap.xml') {
    try {
      // Cache the content-tree walk on a 60s window, mirroring the sibling cached
      // scans in this file (content-status, backlink-ranking, knowledge-gaps, ...).
      // The thunk builds and returns the url list; the XML is rendered from the
      // cached list below, so the emitted document is byte identical to before and
      // only the redundant per-request walk is removed.
      const urls = cached('sitemap-xml', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const collected = [];
        function scanSitemap(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanSitemap(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            const stat = fs.statSync(fp);
            let urlPath = '/' + path.relative(path.join(PROJECT_ROOT, 'content'), fp)
              .replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
            if (urlPath.endsWith('/index')) urlPath = urlPath.slice(0, -6);
            collected.push({loc: urlPath, lastmod: stat.mtime.toISOString().slice(0, 10)});
          }
        }
        scanSitemap(contentDir);
        return collected;
      });
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `<url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}
</urlset>`;
      res.writeHead(200, {'Content-Type': 'application/xml; charset=utf-8', 'Access-Control-Allow-Origin': CORS_ORIGIN});
      return res.end(xml);
    } catch {
      return json(res, 500, {error: 'Sitemap generation failed'});
    }
  }

  // ── Analytics trends (week-over-week) ──
  if (req.method === 'GET' && pathname === '/api/analytics/trends') {
    try {
      const analytics = loadJSON(ANALYTICS_FILE);
      const recent = analytics.recent || [];
      const now = Date.now();
      // The two week windows are disjoint, so tally both in a single pass over
      // `recent`, mirroring the comments loop below.
      let thisWeek = 0, lastWeek = 0;
      for (const r of recent) {
        if (!r.timestamp) continue;
        const t = new Date(r.timestamp).getTime();
        if (t > now - 7 * 86400000) thisWeek++;
        else if (t > now - 14 * 86400000) lastWeek++;
      }
      const pageviewGrowth = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : thisWeek > 0 ? 100 : 0;
      const comments = loadJSON(COMMENTS_FILE);
      let commentsThisWeek = 0, commentsLastWeek = 0;
      for (const page of Object.values(comments)) {
        if (!Array.isArray(page)) continue;
        for (const c of page) {
          if (!c.createdAt) continue;
          const t = new Date(c.createdAt).getTime();
          if (t > now - 7 * 86400000) commentsThisWeek++;
          else if (t > now - 14 * 86400000) commentsLastWeek++;
        }
      }
      const commentGrowth = commentsLastWeek > 0 ? Math.round(((commentsThisWeek - commentsLastWeek) / commentsLastWeek) * 100) : commentsThisWeek > 0 ? 100 : 0;
      return json(res, 200, {
        pageviews: {thisWeek, lastWeek, growth: pageviewGrowth},
        comments: {thisWeek: commentsThisWeek, lastWeek: commentsLastWeek, growth: commentGrowth},
        period: '7 days',
      });
    } catch {
      return json(res, 500, {error: 'Trends calculation failed'});
    }
  }

  // ── Content engagement scoring ──
  if (req.method === 'GET' && pathname === '/api/content-engagement') {
    try {
      const analytics = loadJSON(ANALYTICS_FILE);
      const comments = loadJSON(COMMENTS_FILE);
      const bookmarks = loadJSON(BOOKMARKS_FILE);
      const readingLists = loadJSON(READING_LISTS_FILE);
      const pageScores = {};
      for (const [page, views] of Object.entries(analytics.counts || {})) {
        if (!pageScores[page]) pageScores[page] = {views: 0, comments: 0, bookmarks: 0, readingLists: 0};
        pageScores[page].views = views;
      }
      for (const [page, pageComments] of Object.entries(comments)) {
        if (!pageScores[page]) pageScores[page] = {views: 0, comments: 0, bookmarks: 0, readingLists: 0};
        pageScores[page].comments = Array.isArray(pageComments) ? pageComments.length : 0;
      }
      for (const b of (bookmarks.bookmarks || [])) {
        const bp = b.path;
        if (!pageScores[bp]) pageScores[bp] = {views: 0, comments: 0, bookmarks: 0, readingLists: 0};
        pageScores[bp].bookmarks++;
      }
      for (const list of (readingLists.lists || [])) {
        for (const item of (list.items || [])) {
          const ip = item.path;
          if (!pageScores[ip]) pageScores[ip] = {views: 0, comments: 0, bookmarks: 0, readingLists: 0};
          pageScores[ip].readingLists++;
        }
      }
      const scored = Object.entries(pageScores).map(([page, data]) => {
        const score = data.views * 1 + data.comments * 5 + data.bookmarks * 10 + data.readingLists * 3;
        return {page, ...data, engagementScore: score};
      }).sort((a, b) => b.engagementScore - a.engagementScore);
      return json(res, 200, {pages: scored.slice(0, 30), total: scored.length});
    } catch {
      return json(res, 500, {error: 'Engagement scoring failed'});
    }
  }

  // ── Knowledge gap analysis ──
  if (req.method === 'GET' && pathname === '/api/knowledge-gaps') {
    try {
      const gaps = cached('knowledge-gaps', 120000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const STOP = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not','can','all']);
        const refTopics = {};
        for (const entry of Object.values(refs)) {
          const words = (entry.title || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4 && !STOP.has(w));
          for (const w of words) refTopics[w] = (refTopics[w] || 0) + 1;
        }
        const contentTopics = {};
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              let text = fs.readFileSync(fp, 'utf-8').replace(/^---[\s\S]*?---/, '');
              const words = text.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4 && !STOP.has(w));
              for (const w of words) contentTopics[w] = (contentTopics[w] || 0) + 1;
            } catch {}
          }
        }
        scan(contentDir);
        const gaps = [];
        for (const [topic, refCount] of Object.entries(refTopics)) {
          if (refCount >= 5) {
            const contentCount = contentTopics[topic] || 0;
            const ratio = contentCount / refCount;
            if (ratio < 2) {
              gaps.push({topic, referenceMentions: refCount, contentMentions: contentCount, gap: Math.round((1 - ratio / 2) * 100)});
            }
          }
        }
        gaps.sort((a, b) => b.gap - a.gap);
        return gaps.slice(0, 20);
      });
      return json(res, 200, {gaps, total: gaps.length});
    } catch {
      return json(res, 500, {error: 'Knowledge gap analysis failed'});
    }
  }

  // ── Writing prompts / inspiration ──
  if (req.method === 'GET' && pathname === '/api/writing-prompts') {
    try {
      const prompts = [];
      // Serve the parsed bibliography from the shared, mtime + size aware memo
      // instead of re-reading and re-parsing references.yaml on every request.
      const {loadReferencesCached} = require('./references');
      const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
      // loadReferencesCached swallows a missing or unparseable bibliography and
      // returns {}. Preserve the original 500-on-failure response by reproducing
      // that read only when the memoized parse is empty: a genuinely broken or
      // missing file still throws to the catch, while a legitimately empty file
      // re-reads cleanly and falls through with refs = {} exactly as before.
      if (Object.keys(refs).length === 0) {
        const yaml = require('js-yaml');
        yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8'));
      }
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const citedKeys = new Set();
      function scanCites(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scanCites(fp); continue; }
          if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              let m;
              WRITING_PROMPTS_CITE_RE.lastIndex = 0;
              while ((m = WRITING_PROMPTS_CITE_RE.exec(content)) !== null) citedKeys.add(m[1]);
            } catch {}
          }
        }
      }
      scanCites(contentDir);
      const uncited = Object.entries(refs).filter(([key]) => !citedKeys.has(key)).slice(0, 5);
      for (const [key, entry] of uncited) {
        prompts.push({type: 'uncited-reference', prompt: `Write about "${entry.title}" — it's in your bibliography but hasn't been cited yet.`, key});
      }
      const RQ_FILE = path.join(PROJECT_ROOT, 'data', 'research-questions.json');
      const rqData = loadJSON(RQ_FILE);
      const openQuestions = (rqData.questions || []).filter(q => q.status === 'open').slice(0, 3);
      for (const q of openQuestions) {
        prompts.push({type: 'research-question', prompt: `Explore: "${q.question}"`, id: q.id});
      }
      const lowQuality = cached('low-quality-pages', 60000, () => {
        const results = [];
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const words = content.split(/\s+/).filter(Boolean).length;
              if (words < 100 && words > 10) {
                let title = entry.name.replace(/\.(mdx?|md)$/, '');
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                if (fmMatch) { const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
                results.push({path: path.relative(PROJECT_ROOT, fp), title, words});
              }
            } catch {}
          }
        }
        scan(contentDir);
        return results.sort((a, b) => a.words - b.words).slice(0, 5);
      });
      for (const page of lowQuality) {
        prompts.push({type: 'expand-content', prompt: `"${page.title}" only has ${page.words} words — expand it!`, path: page.path});
      }
      return json(res, 200, {prompts, total: prompts.length});
    } catch {
      return json(res, 500, {error: 'Prompts generation failed'});
    }
  }

  // ── Batch content quality scoring ──
  if (req.method === 'GET' && pathname === '/api/content-quality') {
    try {
      const scores = cached('content-quality', 120000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const results = [];
        function scanQuality(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanQuality(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              let score = 0;
              if (fmMatch) {
                const fm = fmMatch[1];
                if (/^title:/m.test(fm)) { score += 5; const tm = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
                if (/^date:/m.test(fm)) score += 3;
                if (/^tags:/m.test(fm)) score += 3;
              }
              score += Math.min(20, Math.round(content.split(/\s+/).filter(Boolean).length / 50));
              score += Math.min(15, (content.match(/^#{1,6}\s+.+$/gm) || []).length * 3);
              score += Math.min(15, (content.match(/\[@[\w-]+/g) || []).length * 3);
              score += Math.min(10, ((content.match(/\[\[/g) || []).length + (content.match(/\]\(/g) || []).length) * 2);
              score = Math.min(100, score);
              results.push({path: path.relative(PROJECT_ROOT, fp), title, score});
            } catch {}
          }
        }
        scanQuality(contentDir);
        results.sort((a, b) => b.score - a.score);
        return results;
      });
      // Single pass over the request-sized `scores`: accumulate the score sum
      // alongside the bucket distribution so the array is walked once. Summing the
      // same values in the same order, then applying the same rounding, keeps
      // `scoreSum` and the derived `averageScore` identical to the prior
      // reduce-based form; the empty-array guard still yields avgScore 0.
      let scoreSum = 0;
      const counts = {excellent: 0, good: 0, adequate: 0, needsImprovement: 0, minimal: 0};
      for (const r of scores) {
        scoreSum += r.score;
        if (r.score >= 80) counts.excellent++;
        else if (r.score >= 60) counts.good++;
        else if (r.score >= 40) counts.adequate++;
        else if (r.score >= 20) counts.needsImprovement++;
        else counts.minimal++;
      }
      const avgScore = scores.length > 0 ? Math.round(scoreSum / scores.length * 10) / 10 : 0;
      return json(res, 200, {
        averageScore: avgScore,
        totalFiles: scores.length,
        distribution: counts,
        top10: scores.slice(0, 10),
        bottom10: scores.slice(-10).reverse(),
      });
    } catch {
      return json(res, 500, {error: 'Quality scoring failed'});
    }
  }

  // ── Content quality score ──
  if (req.method === 'GET' && pathname === '/api/file/quality-score') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // The score breakdown is a pure function of this one file's content, so
      // memoize the whole payload keyed by path for the TTL while the json() write
      // below still runs on every request. Mirrors the per-path caches in this file
      // (mentions:, statsdir:) and the blessed filestyle: cache in
      // content-analysis-b.js. The readFileSync stays INSIDE the closure, so a
      // missing file still throws into the outer catch and the 404 is never cached
      // (cached stores nothing when fn throws).
      const result = cached('qualityscore:' + filePath, 30000, () => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let score = 0;
        const breakdown = {};
        if (fmMatch) {
          const fm = fmMatch[1];
          let fmScore = 0;
          if (/^title:/m.test(fm)) fmScore += 5;
          if (/^date:/m.test(fm)) fmScore += 3;
          if (/^tags:/m.test(fm)) fmScore += 3;
          if (/^description:/m.test(fm)) fmScore += 4;
          breakdown.frontmatter = fmScore;
          score += fmScore;
        } else {
          breakdown.frontmatter = 0;
        }
        const wordCount = content.split(/\s+/).filter(Boolean).length;
        const wordScore = Math.min(20, Math.round(wordCount / 50));
        breakdown.wordCount = wordScore;
        score += wordScore;
        const headings = (content.match(/^#{1,6}\s+.+$/gm) || []).length;
        const headingScore = Math.min(15, headings * 3);
        breakdown.headings = headingScore;
        score += headingScore;
        const citations = (content.match(/\[@[\w-]+/g) || []).length;
        const citationScore = Math.min(15, citations * 3);
        breakdown.citations = citationScore;
        score += citationScore;
        const links = (content.match(/\[\[/g) || []).length + (content.match(/\]\(/g) || []).length;
        const linkScore = Math.min(10, links * 2);
        breakdown.links = linkScore;
        score += linkScore;
        const codeBlocks = (content.match(/```/g) || []).length / 2;
        const codeScore = Math.min(10, Math.round(codeBlocks * 3));
        breakdown.codeExamples = codeScore;
        score += codeScore;
        const images = (content.match(/!\[/g) || []).length;
        const imageScore = Math.min(10, images * 5);
        breakdown.images = imageScore;
        score += imageScore;
        score = Math.min(100, score);
        const level = score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'adequate' : score >= 20 ? 'needs-improvement' : 'minimal';
        return {path: filePath, score, level, breakdown, wordCount};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Content readability trends ──
  if (req.method === 'GET' && pathname === '/api/stats/readability') {
    try {
      const stats = cached('readability-trends', 120000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const byDir = {};
        let totalGrade = 0, totalFiles = 0;
        function scan(dir, dirName) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp, dirName || entry.name); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              let text = fs.readFileSync(fp, 'utf-8');
              text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '');
              const words = text.split(/\s+/).filter(w => w.length > 0);
              const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 3);
              if (words.length < 10) continue;
              const syllables = words.reduce((sum, w) => {
                const clean = w.toLowerCase().replace(/[^a-z]/g, '');
                if (!clean) return sum;
                let s = clean.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
                return sum + Math.max(1, s ? s.length : 1);
              }, 0);
              const grade = Math.round((0.39 * (words.length / Math.max(sentences.length, 1)) + 11.8 * (syllables / words.length) - 15.59) * 10) / 10;
              const dn = dirName || 'root';
              if (!byDir[dn]) byDir[dn] = {grades: [], count: 0};
              byDir[dn].grades.push(grade);
              byDir[dn].count++;
              totalGrade += grade;
              totalFiles++;
            } catch {}
          }
        }
        scan(contentDir, null);
        const directories = Object.entries(byDir).map(([name, info]) => ({
          directory: name,
          avgGrade: Math.round(info.grades.reduce((s, g) => s + g, 0) / info.count * 10) / 10,
          fileCount: info.count,
          minGrade: Math.round(Math.min(...info.grades) * 10) / 10,
          maxGrade: Math.round(Math.max(...info.grades) * 10) / 10,
        })).sort((a, b) => a.avgGrade - b.avgGrade);
        return {
          overallAvgGrade: totalFiles > 0 ? Math.round(totalGrade / totalFiles * 10) / 10 : 0,
          totalFiles,
          directories,
        };
      });
      return json(res, 200, stats);
    } catch {
      return json(res, 500, {error: 'Readability trends failed'});
    }
  }

  // ── Content statistics summary for a directory ──
  if (req.method === 'GET' && pathname === '/api/stats/directory') {
    const dir = url.searchParams.get('dir');
    if (!isValidDir(dir)) return json(res, 400, {error: 'Invalid directory'});
    try {
      // Cache the recursive directory walk on a 30s window, keyed by the requested
      // `dir`, mirroring the sibling cached scans in this file (content-status,
      // backlink-ranking, health-summary, ...). Repeated requests for the same dir
      // skip the readdirSync/readFileSync walk and return the memoized result. The
      // isValidDir 400 guard and the try/catch 404 path stay OUTSIDE the cache: the
      // walk runs inside the closure, so a non-existent directory still throws and
      // propagates to the outer catch as a 404, and only a successful scan is ever
      // cached. The key carries `dir`, so each directory is a distinct cache entry.
      const result = cached('statsdir:' + dir, 30000, () => {
        const fullDir = path.join(PROJECT_ROOT, dir);
        let files = 0, words = 0, drafts = 0;
        function count(d) {
          for (const entry of fs.readdirSync(d, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(d, entry.name);
            if (entry.isDirectory()) { count(fp); continue; }
            if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              files++;
              try {
                const content = fs.readFileSync(fp, 'utf-8');
                words += content.split(/\s+/).filter(Boolean).length;
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                if (fmMatch && /^draft:\s*true/m.test(fmMatch[1])) drafts++;
              } catch {}
            }
          }
        }
        count(fullDir);
        return {directory: dir, files, words, drafts, avgWordsPerFile: files > 0 ? Math.round(words / files) : 0};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'Directory not found'});
    }
  }

  // ── Paper recommendations by author preference ──
  if (req.method === 'GET' && pathname === '/api/references/recommend-by-author') {
    const authorName = url.searchParams.get('name');
    if (!authorName) return json(res, 400, {error: 'Missing name'});
    try {
      // Cache the references.yaml parse and coauthor/venue scoring on a 60s window,
      // keyed by the queried author, mirroring the sibling cached scans in this file
      // (statsdir:, mentions:, diffsummary:). The payload is a pure function of
      // references.yaml plus the name, so a short TTL snapshot stays byte identical
      // while skipping the repeat parse. The 400 missing-name guard stays OUTSIDE the
      // closure; the require('js-yaml'), fs.readFileSync, and yaml.load stay INSIDE,
      // so a broken references.yaml still throws to the outer catch as a 500 and is
      // never cached. The key carries the name, so each author is a distinct entry.
      const result = cached('byauthor:' + authorName, 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
        const nameLower = authorName.toLowerCase();
        const coauthors = new Set();
        const preferredVenues = new Set();
        for (const entry of Object.values(refs)) {
          if ((entry.author || []).some(a => a.toLowerCase().includes(nameLower))) {
            for (const a of (entry.author || [])) {
              const aLower = a.toLowerCase();
              if (!aLower.includes(nameLower)) coauthors.add(aLower);
            }
            if (entry.venue) preferredVenues.add(entry.venue);
          }
        }
        const recommendations = [];
        for (const [key, entry] of Object.entries(refs)) {
          if ((entry.author || []).some(a => a.toLowerCase().includes(nameLower))) continue;
          let score = 0;
          for (const a of (entry.author || [])) {
            if (coauthors.has(a.toLowerCase())) score += 2;
          }
          if (preferredVenues.has(entry.venue)) score += 1;
          if (score > 0) {
            recommendations.push({key, title: entry.title, year: entry.year, venue: entry.venue, score});
          }
        }
        recommendations.sort((a, b) => b.score - a.score || (b.year || 0) - (a.year || 0));
        return {author: authorName, recommendations: recommendations.slice(0, 15)};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 500, {error: 'Recommendation failed'});
    }
  }

  // ── File diff between two files ──
  if (req.method === 'GET' && pathname === '/api/file/diff') {
    const path1 = url.searchParams.get('path1');
    const path2 = url.searchParams.get('path2');
    if (!isValidFilePath(path1) || !isValidFilePath(path2)) return json(res, 400, {error: 'Invalid paths'});
    try {
      // The diff payload is a pure function of the two files' contents plus the pair
      // of paths, so memoize the whole result keyed by both paths for the TTL while
      // the json() write below still runs on every request. Mirrors the per-file
      // caches in this file (accessibility:, jsonld:). Both readFileSync reads stay
      // INSIDE the closure, so a missing file still throws into the outer catch and
      // the 404 is never cached (cached stores nothing when fn throws). Distinct from
      // the never-cache /api/file/compare in file-tools.js, which shells out to
      // `git show` and stamps new Date() into its payload; this handler does neither,
      // so the snapshot stays byte identical for the TTL window.
      const result = cached('filediff:' + path1 + ':' + path2, 30000, () => {
        const content1 = fs.readFileSync(path.join(PROJECT_ROOT, path1), 'utf-8');
        const content2 = fs.readFileSync(path.join(PROJECT_ROOT, path2), 'utf-8');
        const lines1 = content1.split('\n');
        const lines2 = content2.split('\n');
        const diff = [];
        const maxLen = Math.max(lines1.length, lines2.length);
        for (let i = 0; i < maxLen; i++) {
          const l1 = lines1[i];
          const l2 = lines2[i];
          if (l1 === undefined) diff.push({line: i + 1, type: 'added', text: l2});
          else if (l2 === undefined) diff.push({line: i + 1, type: 'removed', text: l1});
          else if (l1 !== l2) diff.push({line: i + 1, type: 'changed', old: l1, new: l2});
        }
        return {
          path1, path2,
          lines1: lines1.length,
          lines2: lines2.length,
          changes: diff.length,
          diff: diff.slice(0, 200),
        };
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Venue statistics ──
  if (req.method === 'GET' && pathname === '/api/references/venue-stats') {
    const venue = url.searchParams.get('venue');
    if (!venue) return json(res, 400, {error: 'Missing venue'});
    try {
      // Cache the references.yaml parse and per-venue aggregation on a 60s window,
      // keyed by the queried venue, mirroring the sibling cached scans in this file
      // (statsdir:, mentions:, diffsummary:). The payload is a pure function of
      // references.yaml plus the venue, so a short TTL snapshot stays byte identical
      // while skipping the repeat parse. The 400 missing-venue guard stays OUTSIDE the
      // closure; the require('js-yaml'), fs.readFileSync, and yaml.load stay INSIDE,
      // so a broken references.yaml still throws to the outer catch as a 500 and is
      // never cached. The key carries the venue, so each venue is a distinct entry.
      const result = cached('venuestats:' + venue, 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
        const venueLower = venue.toLowerCase();
        const papers = [];
        const authorCounts = {};
        const byYear = {};
        for (const [key, entry] of Object.entries(refs)) {
          if ((entry.venue || '').toLowerCase() === venueLower) {
            papers.push({key, title: entry.title, year: entry.year, authors: entry.author});
            const year = entry.year || 'unknown';
            byYear[year] = (byYear[year] || 0) + 1;
            for (const author of (entry.author || [])) {
              authorCounts[author] = (authorCounts[author] || 0) + 1;
            }
          }
        }
        const topAuthors = Object.entries(authorCounts).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, count]) => ({name, count}));
        const years = Object.entries(byYear).filter(([y]) => y !== 'unknown').sort((a, b) => Number(a[0]) - Number(b[0])).map(([year, count]) => ({year: Number(year), count}));
        return {
          venue,
          paperCount: papers.length,
          authorCount: Object.keys(authorCounts).length,
          topAuthors,
          yearDistribution: years,
          papers: papers.sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 20),
        };
      });
      return json(res, 200, result);
    } catch {
      return json(res, 500, {error: 'Venue stats failed'});
    }
  }

  // ── Author profile aggregation ──
  if (req.method === 'GET' && pathname === '/api/references/author-profile') {
    const name = url.searchParams.get('name');
    if (!name) return json(res, 400, {error: 'Missing name'});
    try {
      // Cache the references.yaml parse and per-author aggregation on a 60s window,
      // keyed by the queried name, mirroring the sibling cached scans in this file
      // (statsdir:, mentions:, diffsummary:). The payload is a pure function of
      // references.yaml plus the name, so a short TTL snapshot stays byte identical
      // while skipping the repeat parse. The 400 missing-name guard stays OUTSIDE the
      // closure; the require('js-yaml'), fs.readFileSync, and yaml.load stay INSIDE,
      // so a broken references.yaml still throws to the outer catch as a 500 and is
      // never cached. The key carries the name, so each author is a distinct entry.
      const result = cached('authorprofile:' + name, 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8')) || {};
        const nameLower = name.toLowerCase();
        const papers = [];
        const coauthorSet = new Set();
        const venueSet = new Set();
        for (const [key, entry] of Object.entries(refs)) {
          const authors = entry.author || [];
          if (authors.some(a => a.toLowerCase().includes(nameLower))) {
            papers.push({key, title: entry.title, year: entry.year, venue: entry.venue});
            if (entry.venue) venueSet.add(entry.venue);
            for (const a of authors) {
              if (!a.toLowerCase().includes(nameLower)) coauthorSet.add(a);
            }
          }
        }
        papers.sort((a, b) => (b.year || 0) - (a.year || 0));
        return {
          name,
          paperCount: papers.length,
          papers,
          coauthors: [...coauthorSet].slice(0, 30),
          venues: [...venueSet],
          yearRange: papers.length > 0 ? {earliest: papers[papers.length - 1].year, latest: papers[0].year} : null,
        };
      });
      return json(res, 200, result);
    } catch {
      return json(res, 500, {error: 'Profile aggregation failed'});
    }
  }

  // ── Content mentions: find all mentions of a page ──
  if (req.method === 'GET' && pathname === '/api/file/mentions') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      // Cache the per-file mentions scan on a 30s window, keyed by the requested
      // `path`, mirroring the sibling per-file caches (filedeps:, related:,
      // content-similar). Repeated requests for the same path skip the recursive
      // readdirSync/readFileSync walk over content/ and return the memoized
      // payload. The isValidFilePath 400 guard stays OUTSIDE the cache; the target
      // file's readFileSync stays INSIDE the closure, so a missing target still
      // throws here, propagates to the outer catch as a 404, and is never cached.
      // The key carries `path`, so each file is a distinct cache entry.
      const result = cached('mentions:' + filePath, 30000, () => {
        const baseName = path.basename(filePath, path.extname(filePath));
        const fmMatch = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8').match(/^---\n([\s\S]*?)\n---/);
        let title = baseName;
        if (fmMatch) {
          const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
          if (tm) title = tm[1];
        }
        const searchTerms = [baseName.toLowerCase(), title.toLowerCase()];
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const mentions = [];
        function scanMentions(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanMentions(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            const rel = path.relative(PROJECT_ROOT, fp);
            if (rel === filePath) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8').toLowerCase();
              for (const term of searchTerms) {
                if (term.length > 3 && content.includes(term)) {
                  mentions.push({file: rel, matchedTerm: term});
                  break;
                }
              }
            } catch {}
          }
        }
        scanMentions(contentDir);
        return {path: filePath, title, mentions, total: mentions.length};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Template variables ──
  if (req.method === 'GET' && pathname === '/api/template-variables') {
    const VARS_FILE = path.join(PROJECT_ROOT, 'data', 'template-variables.json');
    const data = loadJSON(VARS_FILE);
    const builtIn = {
      date: new Date().toISOString().slice(0, 10),
      year: new Date().getFullYear().toString(),
      timestamp: new Date().toISOString(),
    };
    return json(res, 200, {builtIn, custom: data.variables || {}, total: Object.keys(data.variables || {}).length});
  }

  if (req.method === 'POST' && pathname === '/api/template-variables') {
    if (!rateLimit(`template-vars:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {name, value} = body;
      if (!name || typeof name !== 'string') return json(res, 400, {error: 'Missing or invalid name'});
      if (typeof value !== 'string') return json(res, 400, {error: 'Missing or invalid value (must be a string)'});
      if (name.length > 100) return json(res, 400, {error: 'Name must be 100 characters or fewer'});
      if (value.length > 5000) return json(res, 400, {error: 'Value must be 5000 characters or fewer'});
      // Guard against prototype pollution via variable names
      if (TEMPLATE_VAR_PROTO_KEYS.has(name)) return json(res, 400, {error: 'Invalid variable name'});
      if (!TEMPLATE_VAR_NAME_RE.test(name)) return json(res, 400, {error: 'Variable name must be alphanumeric (with underscores/hyphens)'});
      const VARS_FILE = path.join(PROJECT_ROOT, 'data', 'template-variables.json');
      const data = loadJSON(VARS_FILE);
      if (!data.variables) data.variables = {};
      data.variables[sanitizeText(name)] = sanitizeText(value);
      saveJSON(VARS_FILE, data);
      return json(res, 200, {success: true, name, value});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'DELETE' && pathname === '/api/template-variables') {
    if (!rateLimit(`template-vars-del:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {name} = body;
      if (!name) return json(res, 400, {error: 'Missing name'});
      const VARS_FILE = path.join(PROJECT_ROOT, 'data', 'template-variables.json');
      const data = loadJSON(VARS_FILE);
      if (!data.variables || !(name in data.variables)) return json(res, 404, {error: 'Variable not found'});
      delete data.variables[name];
      saveJSON(VARS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

};

module.exports.numericParam = numericParam;
// Exported for tests: lets the /api/admin/health-summary suite pre-seed lastIndex
// and prove the per-file reset keeps this shared module-scope regex correct.
module.exports.HEALTH_WIKI_LINK_RE = HEALTH_WIKI_LINK_RE;
// Exported for tests: lets the /api/writing-prompts suite pre-seed lastIndex and
// prove the per-file reset keeps this shared module-scope regex correct.
module.exports.WRITING_PROMPTS_CITE_RE = WRITING_PROMPTS_CITE_RE;
// Exported for tests: the shared variable-name validation regex used by the
// POST /api/template-variables handler, so the suite can assert source/flags and
// prove a single shared instance backs every request.
module.exports.TEMPLATE_VAR_NAME_RE = TEMPLATE_VAR_NAME_RE;
