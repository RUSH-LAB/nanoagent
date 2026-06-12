'use strict';
// Route module organized from server.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server.js detects a sent response via res.writableEnded.

// Object keys that must never be used as property names (prototype-pollution guard).
const PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

// Hoisted lint regexes for POST /api/lint, shared across every line and request.
// A /g regex keeps its lastIndex between calls, so each exec loop resets it to 0
// first (see the broken-image and missing-alt checks below).
const LINT_IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const LINT_ALT_RE = /!\[\s*\]\([^)]+\)/g;

// Per-line lint regexes for POST /api/lint, also shared across every line and
// request so the handler stops rebuilding them per line. All are non-global and
// non-sticky, used only through .test()/.match(), so each holds no lastIndex
// state and a single shared instance is behavior preserving. The fence and
// heading-prefix patterns each appeared at two identical sites; both collapse to
// one shared const here.
const LINT_FM_TITLE_RE = /^title\s*:/m;
const LINT_HEADING_RE = /^(#{1,6})\s+(.+)$/;
const LINT_HTTP_PREFIX_RE = /^https?:\/\//;
const LINT_FENCE_RE = /^```/;
const LINT_URL_ONLY_RE = /^\s*https?:\/\/\S+\s*$/;
const LINT_LINK_ONLY_RE = /^\s*\[.*\]\(https?:\/\/\S+\)\s*$/;
const LINT_HEADING_PREFIX_RE = /^#{1,6}\s+/;

// Shared, mtime plus size aware memo for bibliography/references.yaml, reused by
// the three read-only GET handlers below (citation network, references timeline,
// and the dashboard reference count) so none re-parses the ~251 KB file on every
// request. Defined in references.js next to the other reference handlers; ctx
// does not supply it, so require it here at module scope.
const {loadReferencesCached} = require('./references');

module.exports = async function analysis_admin_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, collectFeedItems, parseFeedItem, cached, invalidateCache, cleanStalePresence, rateLimit, formatAuthorAPA, formatAuthorMLA, formatAuthorIEEE, formatCitation, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Writing Streak Tracker ──
  if (req.method === 'GET' && pathname === '/api/streak') {
    const userId = url.searchParams.get('userId') || 'default';
    const data = loadJSON(STREAKS_FILE);
    const userLog = (data[userId] && data[userId].dailyLog) || [];
    // Compute streaks from log
    let currentStreak = 0;
    let longestStreak = 0;
    let totalWords = 0;
    let tempStreak = 0;
    // Sort log by date ascending
    const sorted = [...userLog].sort((a, b) => a.date.localeCompare(b.date));
    // Parse each entry's date string into epoch ms exactly once here, then reuse
    // these cached numbers for every day-difference in both streak loops below.
    // For the YYYY-MM-DD strings stored here Date.parse(s) equals
    // new Date(s).getTime(), and Date subtraction uses getTime, so each diffDays
    // value (and the === 1 / !== 1 adjacency tests built on it) is identical to
    // re-parsing the string on every pass; an invalid date yields NaN either way.
    const days = sorted.map(e => Date.parse(e.date)); // epoch ms, parsed once per entry
    // Previous QUALIFYING day's epoch ms (null = run broken), the numeric
    // counterpart of the former prevStreakDate string.
    let prevStreakMs = null;
    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i];
      totalWords += entry.words;
      if (entry.words >= 50) {
        // Extend the run only when this qualifying day directly follows the
        // previous one; a date gap (or a duplicate date) restarts it at 1,
        // mirroring the diffDays adjacency check the currentStreak loop uses below.
        if (prevStreakMs !== null) {
          const diffDays = (days[i] - prevStreakMs) / 86400000;
          tempStreak = diffDays === 1 ? tempStreak + 1 : 1;
        } else {
          tempStreak = 1;
        }
        if (tempStreak > longestStreak) longestStreak = tempStreak;
        prevStreakMs = days[i];
      } else {
        tempStreak = 0;
        prevStreakMs = null;
      }
    }
    // Current streak: count consecutive days ending at today (or yesterday)
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    for (let i = sorted.length - 1; i >= 0; i--) {
      const entry = sorted[i];
      if (i === sorted.length - 1 && entry.date !== today && entry.date !== yesterday) break;
      if (entry.words < 50) break;
      // Check consecutive: each entry should be one day before the next
      if (i < sorted.length - 1) {
        const diffDays = (days[i + 1] - days[i]) / 86400000;
        if (diffDays !== 1) break;
      }
      currentStreak++;
    }
    return json(res, 200, {currentStreak, longestStreak, totalWords, dailyLog: sorted});
  }

  if (req.method === 'POST' && pathname === '/api/streak') {
    if (!rateLimit(`streak:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      if (body.userId !== undefined && typeof body.userId !== 'string') return json(res, 400, {error: 'userId must be a string'});
      if (body.userId && body.userId.length > 200) return json(res, 400, {error: 'userId must be 200 characters or fewer'});
      if (body.userId && PROTO_KEYS.includes(body.userId)) return json(res, 400, {error: 'Invalid userId'});
      const userId = body.userId ? sanitizeText(body.userId) : 'default';
      const wordsWritten = typeof body.wordsWritten === 'number' && isFinite(body.wordsWritten) ? body.wordsWritten : 0;
      if (wordsWritten < 0) return json(res, 400, {error: 'wordsWritten must be non-negative'});
      if (wordsWritten > 1000000) return json(res, 400, {error: 'wordsWritten exceeds maximum'});
      const today = new Date().toISOString().slice(0, 10);
      const data = loadJSON(STREAKS_FILE);
      if (!Object.hasOwn(data, userId)) data[userId] = {dailyLog: []};
      const log = data[userId].dailyLog;
      const existing = log.find(e => e.date === today);
      if (existing) {
        existing.words = wordsWritten;
      } else {
        log.push({date: today, words: wordsWritten});
      }
      saveJSON(STREAKS_FILE, data);
      return json(res, 200, {success: true, date: today, words: wordsWritten});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Bulk file operations (delete / move) ──
  if (req.method === 'POST' && pathname === '/api/files/bulk') {
    if (!rateLimit(`files-bulk:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {action, paths, targetDir} = body;
      if (!action || !Array.isArray(paths) || paths.length === 0) {
        return json(res, 400, {error: 'Missing action or paths'});
      }
      if (action !== 'delete' && action !== 'move') {
        return json(res, 400, {error: 'action must be "delete" or "move"'});
      }
      if (action === 'move' && !isValidDir(targetDir)) {
        return json(res, 400, {error: 'Invalid target directory. Must start with content/'});
      }
      const errors = [];
      let processed = 0;

      for (const filePath of paths) {
        try {
          if (!isValidFilePath(filePath)) {
            errors.push({path: filePath, error: 'Invalid path'});
            continue;
          }
          const fullPath = path.join(PROJECT_ROOT, filePath);
          if (!fs.existsSync(fullPath)) {
            errors.push({path: filePath, error: 'File not found'});
            continue;
          }

          if (action === 'delete') {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const baseName = path.basename(filePath);
            const dirPart = path.dirname(filePath);
            const trashedName = `${timestamp}_${baseName}`;
            const trashSubDir = path.join(TRASH_DIR, dirPart);
            fs.mkdirSync(trashSubDir, {recursive: true});
            const trashFullPath = path.join(trashSubDir, trashedName);
            fs.renameSync(fullPath, trashFullPath);
            processed++;
          } else {
            // move
            const baseName = path.basename(filePath);
            const newPath = path.join(targetDir, baseName);
            if (!isValidFilePath(newPath)) {
              errors.push({path: filePath, error: 'Resulting path is invalid'});
              continue;
            }
            const fullTarget = path.join(PROJECT_ROOT, newPath);
            if (fs.existsSync(fullTarget)) {
              errors.push({path: filePath, error: 'Target already exists'});
              continue;
            }
            const fullTargetDir = path.join(PROJECT_ROOT, targetDir);
            fs.mkdirSync(fullTargetDir, {recursive: true});
            fs.renameSync(fullPath, fullTarget);
            processed++;
          }
        } catch {
          errors.push({path: filePath, error: 'Operation failed'});
        }
      }

      // A bulk delete moves files into .trash/ (the file count drops) and a bulk
      // move renames files across directories (the per-directory breakdown changes),
      // so both clear the cached flat file list served by GET /api/files/search and
      // the content-stats counts, mirroring the single-file files.js handlers and
      // the graph-trash-files.js move/restore fix. Guard on processed > 0 so an
      // all-invalid batch (nothing actually moved) invalidates nothing.
      if (processed > 0) {
        invalidateCache('search');
        invalidateCache('stats');
      }

      return json(res, 200, {success: true, processed, errors});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Recently modified files ──
  if (req.method === 'GET' && pathname === '/api/files/recent') {
    try {
      // `parseInt` yields NaN for a present-but-non-numeric value (e.g. `?limit=abc`),
      // which would otherwise collapse the slice below to an empty list. Fall back to
      // the default 10, mirroring the `intParam` idiom in comments-notes.js. Clamp the
      // floor to 0 so a negative limit (e.g. `?limit=-5`) yields an empty page instead
      // of `slice(0, -5)` returning all but the last 5 entries. No upper clamp is added
      // here; the pre-existing `Math.min(limit, 50)` slice bound still caps large values.
      const n = parseInt(url.searchParams.get('limit') || '10', 10);
      const limit = Math.max(Number.isNaN(n) ? 10 : n, 0);
      // Loop-invariant: the includeStats flag is fixed for the whole request, so
      // read it once here rather than re-evaluating searchParams per content file
      // inside walkRecent. The per-file guard and emitted fields are unchanged.
      const includeStats = url.searchParams.get('includeStats') === 'true';
      // The walk and sort depend only on includeStats (not on limit, which merely
      // slices the result below), so cache the full sorted list keyed by that flag
      // and apply the slice outside the cache, mirroring the sibling cached scans
      // in this file. A 30s snapshot is behavior preserving because the walk is
      // deterministic for a given content state. The slice and the try/catch 500
      // path stay outside the cache, so errors are never cached.
      const sorted = cached('files-recent:' + (includeStats ? 'stats' : 'plain'), 30000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const files = [];
        function walkRecent(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walkRecent(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              const stat = fs.statSync(fullPath);
              const relPath = path.relative(PROJECT_ROOT, fullPath);
              const fileInfo = {name: entry.name, path: relPath, mtime: stat.mtimeMs};
              if (includeStats) {
                try {
                  const content = fs.readFileSync(fullPath, 'utf-8');
                  const wordCount = content.split(/\s+/).filter(Boolean).length;
                  fileInfo.wordCount = wordCount;
                  fileInfo.readingTimeMin = Math.ceil(wordCount / 200);
                  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                  if (fmMatch) {
                    const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                    if (titleMatch) fileInfo.title = titleMatch[1];
                  }
                } catch {}
              }
              files.push(fileInfo);
            }
          }
        }
        walkRecent(contentDir);
        files.sort((a, b) => b.mtime - a.mtime);
        return files;
      });
      return json(res, 200, {files: sorted.slice(0, Math.min(limit, 50))});
    } catch {
      return json(res, 500, {error: 'Failed to list recent files'});
    }
  }

  // ── Annotations ─────────────────────────────────────────────────────────

  if (req.method === 'GET' && pathname === '/api/annotations') {
    const page = url.searchParams.get('page');
    if (!page) return json(res, 400, {error: 'Missing page parameter'});
    const annotations = loadJSON(ANNOTATIONS_FILE);
    // Only treat an OWN key as a real page. A request-controlled `page` such as
    // `constructor`, `toString`, or `__proto__` resolves to a truthy inherited
    // value, so the `|| []` fallback is skipped and the body serializes to a
    // malformed shape (a dropped function leaves `{}`, an inherited object leaves
    // `{annotations: {}}`) instead of `{annotations: []}`. The guard returns the
    // empty default for any non-own key; real own-key pages are unchanged.
    // Mirrors the comments-list read-path guard.
    return json(res, 200, {annotations: Object.hasOwn(annotations, page) ? annotations[page] : []});
  }

  if (req.method === 'POST' && pathname === '/api/annotations') {
    if (!rateLimit(`annotations:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {page, text, note, startOffset, endOffset, author} = body;
      if (!page || !text || startOffset == null || endOffset == null) {
        return json(res, 400, {error: 'Missing required fields: page, text, startOffset, endOffset'});
      }
      if (typeof page === 'string' && page.length > 500) return json(res, 400, {error: 'Page must be 500 characters or fewer'});
      if (typeof text === 'string' && text.length > 5000) return json(res, 400, {error: 'Text must be 5000 characters or fewer'});
      if (note !== undefined && typeof note === 'string' && note.length > 5000) return json(res, 400, {error: 'Note must be 5000 characters or fewer'});
      if (author !== undefined && typeof author === 'string' && author.length > 100) return json(res, 400, {error: 'Author must be 100 characters or fewer'});
      if (PROTO_KEYS.includes(page)) return json(res, 400, {error: 'Invalid page'});
      const annotations = loadJSON(ANNOTATIONS_FILE);
      if (!Object.hasOwn(annotations, page)) annotations[page] = [];
      const annotation = {
        id: 'ann_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        text: sanitizeText(text),
        note: note ? sanitizeText(note) : '',
        startOffset,
        endOffset,
        author: sanitizeText(author || 'Anonymous'),
        createdAt: new Date().toISOString(),
      };
      annotations[page].push(annotation);
      saveJSON(ANNOTATIONS_FILE, annotations);
      return json(res, 201, {annotation});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'DELETE' && pathname === '/api/annotations') {
    try {
      const body = await readBody(req);
      const {page, id} = body;
      if (!page || !id) return json(res, 400, {error: 'Missing page or id'});
      const annotations = loadJSON(ANNOTATIONS_FILE);
      if (!Object.hasOwn(annotations, page)) return json(res, 404, {error: 'Page not found'});
      const idx = annotations[page].findIndex(a => a.id === id);
      if (idx === -1) return json(res, 404, {error: 'Annotation not found'});
      annotations[page].splice(idx, 1);
      saveJSON(ANNOTATIONS_FILE, annotations);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Content Duplication Detection ──
  if (req.method === 'GET' && pathname === '/api/analytics/duplicates') {
    try {
      const duplicates = cached('analytics:duplicates', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const fingerprints = []; // [{path, name, words: Set}]

        function scanFiles(dir) {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              scanFiles(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                let text = fs.readFileSync(fullPath, 'utf8');
                // Strip frontmatter
                text = text.replace(/^---[\s\S]*?---/, '');
                // Strip markdown syntax
                text = text.replace(/```[\s\S]*?```/g, '');
                text = text.replace(/`[^`]*`/g, '');
                text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
                text = text.replace(/#{1,6}\s*/g, '');
                text = text.replace(/[*_~`>|\\[\]()-]/g, ' ');
                text = text.replace(/<[^>]+>/g, '');
                // First 100 words as fingerprint
                const allWords = text.toLowerCase().split(/\s+/).filter(w => w.length > 0);
                const first100 = allWords.slice(0, 100);
                if (first100.length < 5) continue; // skip very short files
                const relPath = path.relative(PROJECT_ROOT, fullPath);
                fingerprints.push({path: relPath, name: entry.name, words: new Set(first100)});
              } catch { /* skip unreadable */ }
            }
          }
        }

        scanFiles(contentDir);

        // Compare all pairs using Jaccard similarity
        const pairs = [];
        for (let i = 0; i < fingerprints.length; i++) {
          // Hoist the outer-i-invariant reads out of the inner j loop. fingerprints
          // is fully built by scanFiles before this loop and is never mutated here
          // (the only write in the loop is pairs.push), so fingerprints[i].words, its
          // .size, and fingerprints[i].path are constant across every j. Reading them
          // once per i, rather than (n - i - 1) times, leaves the pairs array (paths,
          // similarity values, and order) byte-identical.
          const a = fingerprints[i].words;
          const aSize = a.size;
          const pathI = fingerprints[i].path;
          for (let j = i + 1; j < fingerprints.length; j++) {
            const b = fingerprints[j].words;
            let intersection = 0;
            for (const w of a) {
              if (b.has(w)) intersection++;
            }
            const union = aSize + b.size - intersection;
            const similarity = union === 0 ? 0 : intersection / union;
            if (similarity > 0.5) {
              pairs.push({
                file1: pathI,
                file2: fingerprints[j].path,
                similarity: Math.round(similarity * 1000) / 1000,
              });
            }
          }
        }

        pairs.sort((a, b) => b.similarity - a.similarity);
        return pairs;
      });

      return json(res, 200, {duplicates});
    } catch {
      return json(res, 500, {error: 'Duplicate scan failed'});
    }
  }

  // ── Orphan Pages Detection ──
  if (req.method === 'GET' && pathname === '/api/analytics/orphans') {
    try {
      const orphans = cached('analytics:orphans', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const allPages = []; // [{path, name, fullPath}]
        const linkedTargets = new Set(); // set of basenames and relative paths that are linked to

        // First pass: collect all pages and all outgoing links
        function collectPages(dir) {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              collectPages(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              const relPath = path.relative(PROJECT_ROOT, fullPath);
              allPages.push({path: relPath, name: entry.name, fullPath});
            }
          }
        }

        collectPages(contentDir);

        // Second pass: find all link targets across all pages, plus sidebar references
        const wikiLinkRe = /\[\[([^\]]+)\]\]/g;
        const mdLinkRe = /\[([^\]]*)\]\(([^)]+)\)/g;

        for (const page of allPages) {
          try {
            const content = fs.readFileSync(page.fullPath, 'utf8');
            let match;

            // Wiki links [[target]] or [[target|alias]]
            wikiLinkRe.lastIndex = 0;
            while ((match = wikiLinkRe.exec(content)) !== null) {
              const target = match[1].split('|')[0].trim();
              linkedTargets.add(target);
              linkedTargets.add(target.toLowerCase());
            }

            // Markdown links [text](path)
            mdLinkRe.lastIndex = 0;
            while ((match = mdLinkRe.exec(content)) !== null) {
              const href = match[2].trim();
              // Only consider relative links (not http/https)
              if (!href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('#')) {
                const cleaned = href.replace(/^\.\//, '').replace(/\.(md|mdx)$/, '');
                linkedTargets.add(cleaned);
                linkedTargets.add(cleaned.toLowerCase());
              }
            }

            // Sidebar position in frontmatter implies it is referenced by sidebar navigation
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch && /sidebar_position\s*:/.test(fmMatch[1])) {
              const baseName = path.basename(page.path, path.extname(page.path));
              linkedTargets.add(baseName);
              linkedTargets.add(baseName.toLowerCase());
            }
          } catch { /* skip unreadable */ }
        }

        // Determine orphans: pages not referenced by any other page
        const result = [];
        for (const page of allPages) {
          const baseName = path.basename(page.path, path.extname(page.path));
          const relFromContent = path.relative('content', page.path).replace(/\\/g, '/');
          const withoutExt = relFromContent.replace(/\.(md|mdx)$/, '');

          // Check if any link target matches this page
          const isLinked =
            linkedTargets.has(baseName) ||
            linkedTargets.has(baseName.toLowerCase()) ||
            linkedTargets.has(withoutExt) ||
            linkedTargets.has(withoutExt.toLowerCase()) ||
            linkedTargets.has(withoutExt.replace(/^docs\//, '')) ||
            linkedTargets.has(withoutExt.replace(/^docs\//, '').toLowerCase());

          // Index/readme pages are navigational, skip them
          if (/^(index|readme|_category_)$/i.test(baseName)) continue;

          if (!isLinked) {
            // Compute word count
            let wordCount = 0;
            try {
              let text = fs.readFileSync(page.fullPath, 'utf8');
              text = text.replace(/^---[\s\S]*?---/, '');
              text = text.replace(/```[\s\S]*?```/g, '');
              text = text.replace(/`[^`]*`/g, '');
              wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
            } catch {}
            result.push({path: page.path, name: page.name, wordCount});
          }
        }

        result.sort((a, b) => a.path.localeCompare(b.path));
        return result;
      });

      return json(res, 200, {orphans});
    } catch {
      return json(res, 500, {error: 'Orphan scan failed'});
    }
  }

  // ── Markdown linting ──
  if (req.method === 'POST' && pathname === '/api/lint') {
    if (!rateLimit(`lint:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {content} = body;
      if (typeof content !== 'string') return json(res, 400, {error: 'Content must be a string'});
      if (content.length > 50000) return json(res, 400, {error: 'Content must be 50000 characters or fewer'});

      const issues = [];
      const lines = content.split('\n');

      // 1. Missing title in frontmatter
      if (content.startsWith('---')) {
        const fmEnd = content.indexOf('---', 3);
        if (fmEnd !== -1) {
          const frontmatter = content.slice(3, fmEnd);
          if (!LINT_FM_TITLE_RE.test(frontmatter)) {
            issues.push({line: 1, column: 1, message: 'Frontmatter is missing a title field', severity: 'warning'});
          }
        }
      }

      // 2. Duplicate headings
      const headingSeen = new Map();
      for (let i = 0; i < lines.length; i++) {
        const hMatch = lines[i].match(LINT_HEADING_RE);
        if (hMatch) {
          const text = hMatch[2].trim();
          if (headingSeen.has(text)) {
            issues.push({line: i + 1, column: 1, message: `Duplicate heading: "${text}" (first at line ${headingSeen.get(text)})`, severity: 'warning'});
          } else {
            headingSeen.set(text, i + 1);
          }
        }
      }

      // 3. Broken image references (path doesn't start with http or /)
      for (let i = 0; i < lines.length; i++) {
        let m;
        LINT_IMG_RE.lastIndex = 0;
        while ((m = LINT_IMG_RE.exec(lines[i])) !== null) {
          const imgPath = m[2].trim();
          if (!LINT_HTTP_PREFIX_RE.test(imgPath) && !imgPath.startsWith('/')) {
            issues.push({line: i + 1, column: m.index + 1, message: `Possibly broken image reference: "${imgPath}" (relative path, should start with / or http)`, severity: 'warning'});
          }
        }
      }

      // 4. Unclosed code blocks (odd number of triple backticks)
      let codeBlockCount = 0;
      let codeBlockOpenLine = 0;
      for (let i = 0; i < lines.length; i++) {
        if (LINT_FENCE_RE.test(lines[i].trim())) {
          codeBlockCount++;
          if (codeBlockCount % 2 === 1) codeBlockOpenLine = i + 1;
        }
      }
      if (codeBlockCount % 2 !== 0) {
        issues.push({line: codeBlockOpenLine, column: 1, message: 'Unclosed code block (odd number of ``` fences)', severity: 'error'});
      }

      // 5. Very long lines (>200 chars, excluding URLs and code blocks)
      let inCodeBlock = false;
      for (let i = 0; i < lines.length; i++) {
        if (LINT_FENCE_RE.test(lines[i].trim())) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (inCodeBlock) continue;
        if (lines[i].length > 200) {
          // Skip lines that are mostly a URL
          if (LINT_URL_ONLY_RE.test(lines[i])) continue;
          if (LINT_LINK_ONLY_RE.test(lines[i])) continue;
          issues.push({line: i + 1, column: 201, message: `Line is ${lines[i].length} characters long (exceeds 200 char limit)`, severity: 'warning'});
        }
      }

      // 6. Empty sections (heading with no content before next heading)
      for (let i = 0; i < lines.length; i++) {
        if (LINT_HEADING_PREFIX_RE.test(lines[i])) {
          let hasContent = false;
          for (let j = i + 1; j < lines.length; j++) {
            if (LINT_HEADING_PREFIX_RE.test(lines[j])) break;
            if (lines[j].trim().length > 0) { hasContent = true; break; }
          }
          if (!hasContent) {
            issues.push({line: i + 1, column: 1, message: 'Empty section — heading has no content before next heading or end of file', severity: 'warning'});
          }
        }
      }

      // 7. Missing alt text in images
      for (let i = 0; i < lines.length; i++) {
        let m;
        LINT_ALT_RE.lastIndex = 0;
        while ((m = LINT_ALT_RE.exec(lines[i])) !== null) {
          issues.push({line: i + 1, column: m.index + 1, message: 'Image is missing alt text', severity: 'warning'});
        }
      }

      return json(res, 200, {issues});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Tags: list all tags with counts ──
  if (req.method === 'GET' && pathname === '/api/tags') {
    try {
      const tags = cached('all-tags', 30000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const tagCounts = {};
        function scanTags(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              scanTags(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                if (fmMatch) {
                  const tagsMatch = fmMatch[1].match(/^tags:\s*\[([^\]]*)\]/m);
                  if (tagsMatch) {
                    const fileTags = tagsMatch[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
                    for (const tag of fileTags) {
                      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                    }
                  }
                }
              } catch {}
            }
          }
        }
        scanTags(contentDir);
        return Object.entries(tagCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([tag, count]) => ({tag, count}));
      });
      return json(res, 200, {tags});
    } catch {
      return json(res, 500, {error: 'Failed to list tags'});
    }
  }

  // ── Citation network analysis ──
  if (req.method === 'GET' && pathname === '/api/references/network') {
    try {
      const network = cached('citation-network', 60000, () => {
        // Serve the parsed bibliography from the shared, mtime plus size aware memo
        // instead of re-reading and re-parsing references.yaml on every request.
        // loadReferencesCached swallows a missing or unparseable bibliography and
        // returns {}; reproduce the original parse only when the memo is empty so a
        // genuinely broken or missing file still throws to the catch (500), while a
        // legitimately empty file falls through with refs = {} exactly as before.
        const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
        if (Object.keys(refs).length === 0) {
          const yaml = require('js-yaml');
          yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8'));
        }
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;
        const citedIn = {};
        const coCitations = {};

        function scanCitations(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanCitations(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const pagePath = path.relative(PROJECT_ROOT, fp);
              CITE_RE.lastIndex = 0;
              const pageCites = new Set();
              let m;
              while ((m = CITE_RE.exec(content)) !== null) {
                const keys = m[1].split(/\s*;\s*/).map(k => k.replace(/^@/, ''));
                for (const key of keys) {
                  if (refs[key]) {
                    pageCites.add(key);
                    if (!citedIn[key]) citedIn[key] = [];
                    citedIn[key].push(pagePath);
                  }
                }
              }
              const citeArray = [...pageCites];
              for (let i = 0; i < citeArray.length; i++) {
                for (let j = i + 1; j < citeArray.length; j++) {
                  const pair = [citeArray[i], citeArray[j]].sort().join('::');
                  coCitations[pair] = (coCitations[pair] || 0) + 1;
                }
              }
            } catch {}
          }
        }
        scanCitations(contentDir);

        const mostCited = Object.entries(citedIn)
          .map(([key, pages]) => ({key, title: refs[key]?.title || key, count: pages.length, pages}))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20);

        const coCited = Object.entries(coCitations)
          .filter(([, count]) => count > 1)
          .map(([pair, count]) => {
            const [a, b] = pair.split('::');
            return {papers: [a, b], coOccurrences: count};
          })
          .sort((a, b) => b.coOccurrences - a.coOccurrences)
          .slice(0, 20);

        return {
          totalReferences: Object.keys(refs).length,
          citedReferences: Object.keys(citedIn).length,
          uncitedReferences: Object.keys(refs).length - Object.keys(citedIn).length,
          mostCited,
          coCitations: coCited,
        };
      });
      return json(res, 200, network);
    } catch {
      return json(res, 500, {error: 'Citation network analysis failed'});
    }
  }

  // ── Bulk content lint ──
  if (req.method === 'GET' && pathname === '/api/content-lint') {
    try {
      const report = cached('content-lint', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const fileIssues = [];
        let totalIssues = 0;
        const severityCounts = {error: 0, warning: 0, info: 0};
        function lintFile(fullPath, relPath) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const issues = [];
          const lines = content.split('\n');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (!fmMatch) issues.push({line: 1, severity: 'warning', message: 'Missing frontmatter'});
          else if (!/^title:/m.test(fmMatch[1])) issues.push({line: 1, severity: 'warning', message: 'Missing title'});
          let inCode = false;
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('```')) { inCode = !inCode; continue; }
            if (inCode) continue;
            if (/^#{1,6}\s*$/.test(line)) issues.push({line: i+1, severity: 'warning', message: 'Empty heading'});
          }
          if (inCode) issues.push({line: lines.length, severity: 'error', message: 'Unclosed code block'});
          if (issues.length > 0) {
            fileIssues.push({path: relPath, issues});
            totalIssues += issues.length;
            for (const iss of issues) severityCounts[iss.severity] = (severityCounts[iss.severity] || 0) + 1;
          }
        }
        function scanLint(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanLint(fp); continue; }
            if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try { lintFile(fp, path.relative(PROJECT_ROOT, fp)); } catch {}
            }
          }
        }
        scanLint(contentDir);
        return {files: fileIssues, totalIssues, severityCounts};
      });
      return json(res, 200, report);
    } catch {
      return json(res, 500, {error: 'Content lint failed'});
    }
  }

  // ── Reference timeline (papers by year with top papers per year) ──
  if (req.method === 'GET' && pathname === '/api/references/timeline') {
    try {
      const result = cached('references-timeline', 60000, () => {
        // Serve the parsed bibliography from the shared, mtime plus size aware memo
        // instead of re-reading and re-parsing references.yaml on every request.
        // loadReferencesCached swallows a missing or unparseable bibliography and
        // returns {}; reproduce the original parse only when the memo is empty so a
        // genuinely broken or missing file still throws to the catch (500), while a
        // legitimately empty file falls through with refs = {} exactly as before.
        const refs = loadReferencesCached(fs, path, PROJECT_ROOT);
        if (Object.keys(refs).length === 0) {
          const yaml = require('js-yaml');
          yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'), 'utf8'));
        }
        const byYear = {};
        for (const [key, entry] of Object.entries(refs)) {
          const year = entry.year || 'unknown';
          if (year === 'unknown') continue;
          if (!byYear[year]) byYear[year] = [];
          byYear[year].push({key, title: entry.title, venue: entry.venue, authors: (entry.author || []).slice(0, 3)});
        }
        const timeline = Object.entries(byYear)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([year, papers]) => ({
            year: Number(year),
            count: papers.length,
            papers: papers.slice(0, 5),
          }));
        return {timeline, totalYears: timeline.length};
      });
      return json(res, 200, result);
    } catch {
      return json(res, 500, {error: 'Timeline failed'});
    }
  }

  // ── Content word cloud data (top 100 words) ──
  if (req.method === 'GET' && pathname === '/api/content-wordcloud') {
    try {
      const words = cached('wordcloud', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const STOP = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','shall','can','and','but','or','nor','for','yet','so','in','on','at','to','by','of','with','from','up','about','into','through','during','before','after','above','below','between','out','off','over','under','again','further','then','once','here','there','when','where','why','how','all','each','every','both','few','more','most','other','some','such','no','not','only','own','same','than','too','very','just','because','as','until','while','this','that','these','those','it','its','he','she','they','them','their','we','our','you','your','i','me','my','what','which','who','whom','if','also','use','used','using','one','two','new','first','set','see','let','given','show','function','return','import','const','var','true','false','null','undefined','class','export','default','from','require','module','type','number','string','object','array']);
        const freq = {};
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              let text = fs.readFileSync(fp, 'utf-8');
              text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, ' ').replace(/[^a-zA-Z\s]/g, ' ');
              const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
              for (const w of words) freq[w] = (freq[w] || 0) + 1;
            } catch {}
          }
        }
        scan(contentDir);
        return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 100).map(([word, count]) => ({word, count}));
      });
      const maxCount = words.length > 0 ? words[0].count : 1;
      return json(res, 200, {
        words: words.map(w => ({...w, weight: Math.round((w.count / maxCount) * 100) / 100})),
        total: words.length,
      });
    } catch {
      return json(res, 500, {error: 'Word cloud failed'});
    }
  }

  // ── Dashboard overview: comprehensive API health dashboard ──
  if (req.method === 'GET' && pathname === '/api/dashboard') {
    try {
      const dashboard = cached('api-dashboard', 30000, () => {
        const yaml = require('js-yaml');

        // ── server (from /api/health + /api/debug/memory) ──
        const mem = process.memoryUsage();
        const server = {
          uptime: Math.round(process.uptime()),
          memory: {
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            rss: mem.rss,
          },
          startup: {
            time: new Date(Date.now() - process.uptime() * 1000).toISOString(),
            durationMs: typeof _routeDiagnostics.startupMs === 'number' ? _routeDiagnostics.startupMs : null,
            memoryAtStartupMB: typeof _routeDiagnostics.memoryAtStartupMB === 'number' ? _routeDiagnostics.memoryAtStartupMB : null,
          },
        };

        // ── content (from /api/stats) ──
        const contentDir = path.join(PROJECT_ROOT, 'content');
        let totalFiles = 0, totalWords = 0;
        function countContent(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            if (entry.isDirectory()) { countContent(path.join(dir, entry.name)); continue; }
            if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              totalFiles++;
              try { totalWords += fs.readFileSync(path.join(dir, entry.name), 'utf-8').split(/\s+/).filter(Boolean).length; } catch {}
            }
          }
        }
        countContent(contentDir);
        // The dashboard only counts keys; loadReferencesCached returns {} on a
        // missing or broken bibliography (it never throws), so a corrupt or absent
        // file yields refCount = 0 exactly as the swallowed try/catch did. The
        // integrity probe below keeps its own raw parse to flag a corrupt file.
        const refCount = Object.keys(loadReferencesCached(fs, path, PROJECT_ROOT)).length;
        const content = {totalFiles, totalWords, references: refCount};

        // ── activity (recent pageviews, comments, discussions) ──
        const analytics = loadJSON(ANALYTICS_FILE);
        const recentPageviews = Object.values(analytics.counts || {}).reduce((s, c) => s + c, 0);
        const comments = loadJSON(COMMENTS_FILE);
        let recentComments = 0;
        for (const page of Object.values(comments)) { if (Array.isArray(page)) recentComments += page.length; }
        const discData = loadJSON(DISCUSSIONS_FILE);
        const channelCount = Object.keys(discData.channels || {}).length;
        let messageCount = 0;
        for (const msgs of Object.values(discData.messages || {})) { if (Array.isArray(msgs)) messageCount += msgs.length; }
        const activity = {
          recentPageviews,
          recentComments,
          recentDiscussions: {channels: channelCount, messages: messageCount},
        };

        // ── tests (scan test directory for suites) ──
        const testsDir = path.join(PROJECT_ROOT, 'tests');
        let suites = 0, totalTests = 0;
        try {
          const testFiles = fs.readdirSync(testsDir, {recursive: true})
            .filter(f => typeof f === 'string' && f.endsWith('.test.mjs'));
          suites = testFiles.length;
          for (const tf of testFiles) {
            try {
              const src = fs.readFileSync(path.join(testsDir, tf), 'utf-8');
              const itMatches = src.match(/\bit\s*\(|test\s*\(/g);
              if (itMatches) totalTests += itMatches.length;
            } catch {}
          }
        } catch {}
        const tests = {lastRun: null, suites, totalTests};

        // ── endpoints (from /api/debug/routes) ──
        const endpoints = {
          total: typeof _routeDiagnostics.totalHandlers === 'number' ? _routeDiagnostics.totalHandlers : 0,
          unique: typeof _routeDiagnostics.uniqueRoutes === 'number' ? _routeDiagnostics.uniqueRoutes : 0,
        };

        // ── health (from /api/integrity + /api/debug/memory) ──
        // Run integrity checks inline
        const dataDir = path.join(PROJECT_ROOT, 'data');
        let integrityPassed = true;
        let duplicateCount = typeof _routeDiagnostics.duplicateCount === 'number' ? _routeDiagnostics.duplicateCount : 0;
        try {
          const jsonFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
          for (const file of jsonFiles) {
            try { JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8')); }
            catch { integrityPassed = false; break; }
          }
        } catch { integrityPassed = false; }
        try {
          const refPath = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
          if (fs.existsSync(refPath)) { yaml.load(fs.readFileSync(refPath, 'utf-8')); }
        } catch { integrityPassed = false; }
        const health = {
          integrity: integrityPassed ? 'healthy' : 'issues',
          duplicates: duplicateCount,
          cacheEntries: Object.keys(cache).length,
        };

        return {server, content, activity, tests, endpoints, health, generatedAt: new Date().toISOString()};
      });
      return json(res, 200, dashboard);
    } catch {
      return json(res, 500, {error: 'Dashboard failed'});
    }
  }

};

// Exported for the per-line lint regex-hoist regression test, which pins each
// shared instance's .source/.flags, confirms the two collapsed pairs (fence and
// heading-prefix) are each a single instance, and drives POST /api/lint to
// verify the findings are unchanged. Not part of the route contract.
// LINT_IMG_RE/LINT_ALT_RE stay internal, exercised only through the handler.
module.exports.LINT_FM_TITLE_RE = LINT_FM_TITLE_RE;
module.exports.LINT_HEADING_RE = LINT_HEADING_RE;
module.exports.LINT_HTTP_PREFIX_RE = LINT_HTTP_PREFIX_RE;
module.exports.LINT_FENCE_RE = LINT_FENCE_RE;
module.exports.LINT_URL_ONLY_RE = LINT_URL_ONLY_RE;
module.exports.LINT_LINK_ONLY_RE = LINT_LINK_ONLY_RE;
module.exports.LINT_HEADING_PREFIX_RE = LINT_HEADING_PREFIX_RE;
