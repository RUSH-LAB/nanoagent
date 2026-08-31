'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.
//
// Every /api/stats/* endpoint: corpus totals, per-file and per-directory
// aggregates, and the readability, reading-time and word-frequency measures.
// They were previously spread across four modules that had been split by size
// rather than by domain.

// Common words excluded from the /api/stats/word-frequency ranking.
const WORD_FREQ_STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not','can','all','each','some','more','most','other','also','than','very','just','such','only']);


module.exports = async function stats_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, NOTES_FILE, READING_LISTS_FILE, SNAPSHOTS_FILE, SCHEDULE_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, orgSlugFor, contentRootFor, cacheKey, isValidFilePath, isValidDir, resolveContentPath, contentPathToUrl, sanitizeText, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, collection, scopeFor, _routeDiagnostics
  } = ctx;

  if (req.method === 'GET' && pathname === '/api/stats/timeline') {
    try {
      const timeline = cached(cacheKey(req.auth?.orgId, 'stats:timeline'), 60000, () => {
        const contentDir = contentRootFor(req.auth?.orgId);
        const byMonth = {};
        function scanTimeline(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              scanTimeline(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                let date = null;
                if (fmMatch) {
                  const dateMatch = fmMatch[1].match(/^date:\s*["']?(\d{4}-\d{2}(?:-\d{2})?)/m);
                  if (dateMatch) date = dateMatch[1].slice(0, 7);
                }
                if (!date) {
                  const stat = fs.statSync(fullPath);
                  date = stat.mtime.toISOString().slice(0, 7);
                }
                byMonth[date] = (byMonth[date] || 0) + 1;
              } catch {}
            }
          }
        }
        scanTimeline(contentDir);
        return Object.entries(byMonth)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([month, count]) => ({month, count}));
      });
      return json(res, 200, {timeline});
    } catch {
      return json(res, 500, {error: 'Timeline stats failed'});
    }
  }
};

// /api/stats/overview reads the bibliography through the shared memo, so the
// suites need the same reset hook the other readers expose.
