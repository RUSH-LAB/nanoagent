'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.

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

// The bibliography plugin lends its memoized references.yaml reader through ctx,
// the three read-only GET handlers below (citation network, references timeline,
// and the dashboard reference count) so none re-parses the ~251 KB file on every
// request. Defined in references.js next to the other reference handlers; ctx
// does not supply it, so require it here at module scope.

module.exports = async function analysis_admin_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, orgSlugFor, contentRootFor, cacheKey, isValidFilePath, isValidDir, resolveContentPath, contentPathToUrl, sanitizeText, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, collection, scopeFor, _routeDiagnostics
  } = ctx;

  // ── Writing Streak Tracker ──
  //
  // Yours, one row per day, keyed by the date. The JSON store was already a map
  // of user id to a log, which is the shape a per-user collection has without
  // the handler doing the keying; what it gains is that a day is a row, so
  // recording today does not rewrite the whole history.
  const streaks = collection('streaks');

  if (req.method === 'GET' && pathname === '/api/streak') {
    const userLog = streaks.values(scopeFor(req));
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
      // Identity comes from the session, so the shape, length, and
      // prototype-key checks that used to police `body.userId` are gone: the
      // value is no longer client-supplied. server/auth.js runs the equivalent
      // check once, on the token subject.
      const {userId} = req.auth;
      const wordsWritten = typeof body.wordsWritten === 'number' && isFinite(body.wordsWritten) ? body.wordsWritten : 0;
      if (wordsWritten < 0) return json(res, 400, {error: 'wordsWritten must be non-negative'});
      if (wordsWritten > 1000000) return json(res, 400, {error: 'wordsWritten exceeds maximum'});
      const today = new Date().toISOString().slice(0, 10);
      // One upsert where the file version searched the log and then either
      // overwrote the day's entry or appended one. The date is the key, so
      // those two branches are the same statement.
      streaks.put(scopeFor(req), today, {date: today, words: wordsWritten});
      return json(res, 200, {success: true, date: today, words: wordsWritten});
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
        const contentDir = contentRootFor(req.auth?.orgId);
        const files = [];
        function walkRecent(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walkRecent(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              const stat = fs.statSync(fullPath);
              const relPath = path.relative(contentRootFor(req.auth?.orgId), fullPath);
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

  // ── Content Duplication Detection ──
  if (req.method === 'GET' && pathname === '/api/analytics/duplicates') {
    try {
      const duplicates = cached(cacheKey(req.auth?.orgId, 'analytics:duplicates'), 60000, () => {
        const contentDir = contentRootFor(req.auth?.orgId);
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
                const relPath = path.relative(contentRootFor(req.auth?.orgId), fullPath);
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
      const orphans = cached(cacheKey(req.auth?.orgId, 'analytics:orphans'), 60000, () => {
        const contentDir = contentRootFor(req.auth?.orgId);
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
              const relPath = path.relative(contentRootFor(req.auth?.orgId), fullPath);
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
          const relFromContent = page.path.replace(/\\/g, '/');
          const withoutExt = relFromContent.replace(/\.(md|mdx)$/, '');
          const withoutExtNoDocs = withoutExt.replace(/^docs\//, '');

          // Check if any link target matches this page
          const isLinked =
            linkedTargets.has(baseName) ||
            linkedTargets.has(baseName.toLowerCase()) ||
            linkedTargets.has(withoutExt) ||
            linkedTargets.has(withoutExt.toLowerCase()) ||
            linkedTargets.has(withoutExtNoDocs) ||
            linkedTargets.has(withoutExtNoDocs.toLowerCase());

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

  // ── Tags: list all tags with counts ──
  if (req.method === 'GET' && pathname === '/api/tags') {
    try {
      const tags = cached(cacheKey(req.auth?.orgId, 'all-tags'), 30000, () => {
        const contentDir = contentRootFor(req.auth?.orgId);
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
  // ── Bulk content lint ──
  if (req.method === 'GET' && pathname === '/api/content-lint') {
    try {
      const report = cached(cacheKey(req.auth?.orgId, 'content-lint'), 60000, () => {
        const contentDir = contentRootFor(req.auth?.orgId);
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
              try { lintFile(fp, path.relative(contentRootFor(req.auth?.orgId), fp)); } catch {}
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
