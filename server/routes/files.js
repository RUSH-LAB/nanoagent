'use strict';
// Route module organized from server.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server.js detects a sent response via res.writableEnded.
module.exports = async function files_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, collectFeedItems, parseFeedItem, cached, invalidateCache, cleanStalePresence, rateLimit, formatAuthorAPA, formatAuthorMLA, formatAuthorIEEE, formatCitation, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
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
      return json(res, 200, {success: true, path: filePath});
    } catch {
      return json(res, 400, {error: 'Failed to create file: request body must be JSON with "path" (string) and "content" (string) fields'});
    }
  }

  // ── Delete file (move to .trash/) ──
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
      return json(res, 200, {success: true, trashPath: path.relative(PROJECT_ROOT, trashFullPath)});
    } catch {
      return json(res, 500, {error: 'Failed to move file to trash: the file may be locked or the trash directory is not writable'});
    }
  }

  // ── Rename / Move file ──
  if (req.method === 'POST' && pathname === '/api/file/rename') {
    try {
      const body = await readBody(req);
      const {oldPath, newPath} = body;
      if (!isValidFilePath(oldPath) || !isValidFilePath(newPath)) return json(res, 400, {error: 'Invalid path'});
      const fullOld = path.join(PROJECT_ROOT, oldPath);
      const fullNew = path.join(PROJECT_ROOT, newPath);
      if (!fs.existsSync(fullOld)) return json(res, 404, {error: 'Source not found'});
      if (fs.existsSync(fullNew)) return json(res, 409, {error: 'Target already exists'});
      const dir = path.dirname(fullNew);
      fs.mkdirSync(dir, {recursive: true});
      fs.renameSync(fullOld, fullNew);
      return json(res, 200, {success: true, path: newPath});
    } catch {
      return json(res, 400, {error: 'Failed to rename file: request body must be JSON with "oldPath" (string) and "newPath" (string) fields'});
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
      const all = flatFiles(fullDir);
      if (!query) return json(res, 200, {files: all});
      const filtered = all.filter(f =>
        f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query)
      ).map(f => {
        try {
          const content = fs.readFileSync(path.join(PROJECT_ROOT, f.path), 'utf-8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          let title = f.name.replace(/\.(md|mdx)$/, '');
          if (fmMatch) {
            const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
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
        const bibPath = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
        let refCount = 0;
        try { refCount = Object.keys(yaml.load(fs.readFileSync(bibPath, 'utf8')) || {}).length; } catch {}
        return {totalFiles, totalWords, references: refCount, byDirectory: byDir};
      });
      const body = JSON.stringify(stats);
      const etag = '"' + crypto.createHash('md5').update(body).digest('hex').slice(0, 16) + '"';
      const hdrs = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'X-API-Version': '1.0',
        'X-Powered-By': 'Mochi Lab',
        'ETag': etag,
        'Cache-Control': 'public, max-age=30',
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, hdrs);
        return res.end();
      }
      res.writeHead(200, hdrs);
      return res.end(body);
    } catch {
      return json(res, 500, {error: 'Stats failed'});
    }
  }

  // ── Image upload ──
  if (req.method === 'POST' && pathname === '/api/upload') {
    try {
      const targetDir = url.searchParams.get('dir') || 'static/img/uploads';
      const fileName = url.searchParams.get('name');
      if (!fileName) return json(res, 400, {error: 'Missing file name'});
      const ext = path.extname(fileName).toLowerCase();
      if (!IMAGE_EXTS.includes(ext)) return json(res, 400, {error: 'Invalid image type'});

      const normalized = path.normalize(targetDir);
      if (normalized.startsWith('..') || path.isAbsolute(normalized)) return json(res, 400, {error: 'Invalid directory'});

      const fullDir = path.resolve(PROJECT_ROOT, normalized);
      if (!fullDir.startsWith(PROJECT_ROOT)) return json(res, 400, {error: 'Invalid directory'});
      fs.mkdirSync(fullDir, {recursive: true});

      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const fullPath = path.join(fullDir, safeName);
      if (!fullPath.startsWith(PROJECT_ROOT)) return json(res, 400, {error: 'Invalid path'});
      const rawBody = await readRawBody(req);
      fs.writeFileSync(fullPath, rawBody);

      const publicPath = '/' + path.relative(path.join(PROJECT_ROOT, 'static'), fullPath).replace(/\\/g, '/');
      return json(res, 200, {success: true, url: publicPath});
    } catch {
      return json(res, 500, {error: 'Upload failed'});
    }
  }

  // ── Git history for a file ──
  if (req.method === 'GET' && pathname === '/api/history') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      const SEP = '\x1f';
      const output = execFileSync('git', [
        'log', `--format=%h${SEP}%an${SEP}%ai${SEP}%s`, '-20', '--', filePath,
      ], {cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000});
      const commits = output.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split(SEP);
        if (parts.length < 4) return null;
        return {hash: parts[0], author: parts[1], date: parts[2], message: parts.slice(3).join(SEP)};
      }).filter(Boolean);
      return json(res, 200, {commits});
    } catch {
      return json(res, 200, {commits: []});
    }
  }

  // ── Git diff for a specific commit ──
  if (req.method === 'GET' && pathname === '/api/history/diff') {
    const filePath = url.searchParams.get('path');
    const hash = url.searchParams.get('hash');
    if (!isValidFilePath(filePath) || !hash || !/^[a-f0-9]{4,40}$/i.test(hash)) {
      return json(res, 400, {error: 'Missing or invalid query parameters: "path" must be a valid file path and "hash" must be a 4-40 character hex string'});
    }
    try {
      const diff = execFileSync('git', [
        'diff', `${hash}~1..${hash}`, '--', filePath,
      ], {cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000});
      return json(res, 200, {diff});
    } catch {
      return json(res, 200, {diff: ''});
    }
  }

};
