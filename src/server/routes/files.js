'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.

// YAML front-matter delimiter pattern for GET /api/files/search, compiled once
// at module load instead of rebuilt for every matched file on each request. It
// has no /g flag and is used with String.prototype.match, so it carries no
// lastIndex state and is safe to share across requests. This mirrors the
// module-scope `_RE` const convention in the sibling route files.
const {REFERENCES_SEGS} = require('../paths');

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

// Front-matter `title:` extractor for that same GET /api/files/search handler,
// likewise compiled once at module load rather than rebuilt per matched file on
// each request. Like FRONTMATTER_RE it has no /g or /y flag and is used with
// String.prototype.match, so it holds no lastIndex state and one shared instance
// produces the same result for the same input as a freshly allocated literal.
const SEARCH_TITLE_RE = /^title:\s*["']?(.+?)["']?\s*$/m;

module.exports = async function files_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, NOTES_FILE, ANALYTICS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Read file ──
  if (req.method === 'GET' && pathname === '/api/file') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    const fullPath = path.join(PROJECT_ROOT, filePath);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      return json(res, 200, {content});
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Write file ──
  if (req.method === 'PUT' && pathname === '/api/file') {
    if (!rateLimit(`file-write:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: filePath, content} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      if (typeof content !== 'string') return json(res, 400, {error: 'Content must be a string'});
      if (content.length > 50000) return json(res, 400, {error: 'Content must be 50000 characters or fewer'});
      const fullPath = path.join(PROJECT_ROOT, filePath);
      if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'File not found'});
      fs.writeFileSync(fullPath, content, 'utf-8');
      invalidateCache('search');
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Failed to update file: request body must be JSON with "path" (string) and "content" (string) fields'});
    }
  }

  // ── Create file ──
  if (req.method === 'POST' && pathname === '/api/file') {
    if (!rateLimit(`file-create:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: filePath, content} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      if (typeof content !== 'string') return json(res, 400, {error: 'Content must be a string'});
      if (content.length > 50000) return json(res, 400, {error: 'Content must be 50000 characters or fewer'});
      const fullPath = path.join(PROJECT_ROOT, filePath);
      if (fs.existsSync(fullPath)) return json(res, 409, {error: 'File already exists'});
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(fullPath, content, 'utf-8');
      invalidateCache('stats');
      invalidateCache('search');
      return json(res, 200, {success: true, path: filePath});
    } catch {
      return json(res, 400, {error: 'Failed to create file: request body must be JSON with "path" (string) and "content" (string) fields'});
    }
  }

  // ── Delete file (move to the trash directory) ──
  if (req.method === 'DELETE' && pathname === '/api/file') {
    if (!rateLimit(`file-delete:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    const fullPath = path.join(PROJECT_ROOT, filePath);
    try {
      if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'File not found'});
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const baseName = path.basename(filePath);
      const dirPart = path.dirname(filePath);
      const trashedName = `${timestamp}_${baseName}`;
      const trashSubDir = path.join(TRASH_DIR, dirPart);
      fs.mkdirSync(trashSubDir, {recursive: true});
      const trashFullPath = path.join(trashSubDir, trashedName);
      fs.renameSync(fullPath, trashFullPath);
      invalidateCache('search');
      return json(res, 200, {success: true, trashPath: path.relative(PROJECT_ROOT, trashFullPath)});
    } catch {
      return json(res, 500, {error: 'Failed to move file to trash: the file may be locked or the trash directory is not writable'});
    }
  }

  // ── List files ──
  if (req.method === 'GET' && pathname === '/api/files') {
    const dir = url.searchParams.get('dir') || 'content';
    if (!isValidDir(dir)) return json(res, 400, {error: 'Invalid directory'});
    const fullDir = path.join(PROJECT_ROOT, dir);
    try {
      return json(res, 200, {files: walkDir(fullDir)});
    } catch {
      return json(res, 404, {error: 'Directory not found'});
    }
  }

  // ── Search files ──
  if (req.method === 'GET' && pathname === '/api/files/search') {
    const query = (url.searchParams.get('q') || '').toLowerCase();
    const fullDir = path.join(PROJECT_ROOT, 'content');
    try {
      // The directory walk is query independent and runs on every keystroke of
      // the file search box, so snapshot it through the shared cache and reuse
      // it until a mutation invalidates 'search' or the 30s TTL clears it. This
      // mirrors the cached('content-stats', ...) wrap below.
      const all = cached('search:list', 30000, () => flatFiles(fullDir));
      if (!query) return json(res, 200, {files: all});
      const filtered = all.filter(f =>
        f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query)
      ).map(f => {
        try {
          const content = fs.readFileSync(path.join(PROJECT_ROOT, f.path), 'utf-8');
          const fmMatch = content.match(FRONTMATTER_RE);
          let title = f.name.replace(/\.(md|mdx)$/, '');
          if (fmMatch) {
            const titleMatch = fmMatch[1].match(SEARCH_TITLE_RE);
            if (titleMatch) title = titleMatch[1];
          }
          return {...f, title};
        } catch {
          return f;
        }
      });
      return json(res, 200, {files: filtered});
    } catch {
      return json(res, 500, {error: 'Search failed'});
    }
  }

  // ── Content stats ──
  if (req.method === 'GET' && pathname === '/api/stats') {
    try {
      const stats = cached('content-stats', 30000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        let totalFiles = 0, totalWords = 0;
        const byDir = {};
        function countDir(dir, name) {
          let files = 0, words = 0;
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            if (entry.isDirectory()) {
              countDir(path.join(dir, entry.name), name);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              files++;
              const content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
              words += content.split(/\s+/).filter(Boolean).length;
            }
          }
          totalFiles += files;
          totalWords += words;
          if (!byDir[name]) byDir[name] = {files: 0, words: 0};
          byDir[name].files += files;
          byDir[name].words += words;
        }
        for (const entry of fs.readdirSync(contentDir, {withFileTypes: true})) {
          if (entry.isDirectory()) countDir(path.join(contentDir, entry.name), entry.name);
        }
        const yaml = require('js-yaml');
        const bibPath = path.join(PROJECT_ROOT, ...REFERENCES_SEGS);
        let refCount = 0;
        try { refCount = Object.keys(yaml.load(fs.readFileSync(bibPath, 'utf8')) || {}).length; } catch {}
        return {totalFiles, totalWords, references: refCount, byDirectory: byDir};
      });
      return json(res, 200, stats, {cacheControl: 'public, max-age=30'});
    } catch {
      return json(res, 500, {error: 'Stats failed'});
    }
  }

};

// Exported so the regression test (tests/next-filesearch-title-re-hoist.test.mjs)
// can assert the title extractor is the single shared module-scope instance.
// files.js otherwise exports only the route handler above, so attach the const
// as a property on it.
module.exports.SEARCH_TITLE_RE = SEARCH_TITLE_RE;
