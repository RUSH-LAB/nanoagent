/**
 * Mochi Lab API server. Exposes a REST API on port 3001 (or EDITOR_PORT) for
 * file CRUD, references, analytics, discussions, snapshots, and more.
 * All routes live under /api/* and return JSON with CORS headers.
 */
const _startupTime = process.hrtime.bigint();
const http = require('http');
const fs = require('fs');
const path = require('path');
const {URL} = require('url');
const {execFileSync} = require('child_process');
const {
  isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors,
  mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH,
} = require('./lib/server-utils');

const PROJECT_ROOT = __dirname;
const PORT = process.env.EDITOR_PORT || 3001;
const COMMENTS_FILE = path.join(PROJECT_ROOT, 'data', 'comments.json');
const NOTES_FILE = path.join(PROJECT_ROOT, 'data', 'notes.json');
const ANALYTICS_FILE = path.join(PROJECT_ROOT, 'data', 'analytics.json');
const DISCUSSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'discussions.json');
const USERS_FILE = path.join(PROJECT_ROOT, 'data', 'users.json');
const BOOKMARKS_FILE = path.join(PROJECT_ROOT, 'data', 'bookmarks.json');
const READING_LISTS_FILE = path.join(PROJECT_ROOT, 'data', 'reading-lists.json');
const STREAKS_FILE = path.join(PROJECT_ROOT, 'data', 'streaks.json');
const ANNOTATIONS_FILE = path.join(PROJECT_ROOT, 'data', 'annotations.json');
const SNAPSHOTS_FILE = path.join(PROJECT_ROOT, 'data', 'snapshots.json');
const SCHEDULES_FILE = path.join(PROJECT_ROOT, 'data', 'schedules.json');
const WHITEBOARDS_FILE = path.join(PROJECT_ROOT, 'data', 'whiteboards.json');
const FLASHCARDS_FILE = path.join(PROJECT_ROOT, 'data', 'flashcards.json');
const GLOSSARY_FILE = path.join(PROJECT_ROOT, 'data', 'glossary.json');
const TASKS_FILE = path.join(PROJECT_ROOT, 'data', 'tasks.json');
const GOALS_FILE = path.join(PROJECT_ROOT, 'data', 'goals.json');
const TRASH_DIR = path.join(PROJECT_ROOT, '.trash');


function walkDir(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(PROJECT_ROOT, fullPath);
    if (entry.isDirectory()) {
      result.push({name: entry.name, path: relPath, type: 'directory', children: walkDir(fullPath)});
    } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
      const stat = fs.statSync(fullPath);
      result.push({name: entry.name, path: relPath, type: 'file', mtime: stat.mtimeMs});
    }
  }
  return result;
}

function flatFiles(dir) {
  const result = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, {withFileTypes: true})) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(d, entry.name);
      const relPath = path.relative(PROJECT_ROOT, fullPath);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
        result.push({name: entry.name, path: relPath});
      }
    }
  }
  walk(dir);
  return result;
}

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const crypto = require('crypto');

function json(res, status, data) {
  const body = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-API-Version': '1.0',
    'X-Powered-By': 'Mochi Lab',
  };
  if (status === 200 && res.req?.method === 'GET') {
    const etag = '"' + crypto.createHash('md5').update(body).digest('hex').slice(0, 16) + '"';
    headers['ETag'] = etag;
    headers['Cache-Control'] = 'no-cache';
    if (res.req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
  }
  res.writeHead(status, headers);
  res.end(body);
}


function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); return reject(new Error('Body too large')); }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); return reject(new Error('Body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Feed item collector for RSS/Atom ──
function collectFeedItems(postsDir) {
  const items = [];
  function scanDir(dir, category) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Directory-based post: look for index.md or index.mdx
        const indexMd = path.join(fullPath, 'index.md');
        const indexMdx = path.join(fullPath, 'index.mdx');
        const indexFile = fs.existsSync(indexMdx) ? indexMdx : fs.existsSync(indexMd) ? indexMd : null;
        if (indexFile) {
          const item = parseFeedItem(indexFile, category);
          if (item) items.push(item);
        }
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
        const item = parseFeedItem(fullPath, category);
        if (item) items.push(item);
      }
    }
  }
  scanDir(path.join(postsDir, 'blog'), 'blog');
  scanDir(path.join(postsDir, 'research'), 'research');
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return items.slice(0, 20);
}

function parseFeedItem(filePath, category) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return null;
    const fm = fmMatch[1];
    const get = (key) => {
      const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    };
    const title = get('title');
    const slug = get('slug');
    if (!title || !slug) return null;
    const dateStr = get('date');
    const date = dateStr ? new Date(dateStr) : new Date(fs.statSync(filePath).mtimeMs);
    const authorsMatch = fm.match(/^authors:\s*\[([^\]]*)\]/m);
    const authors = authorsMatch ? authorsMatch[1].split(',').map(a => a.trim()) : [];
    const tagsMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
    const tags = tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()) : [];
    // Extract description: text after frontmatter, strip truncate marker, take first 200 chars
    const body = content.slice(fmMatch[0].length).replace(/<!--\s*truncate\s*-->/, '').replace(/\{\/\*\s*truncate\s*\*\/\}/, '').trim();
    const plainText = body.replace(/!\[.*?\]\(.*?\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_`~>\-|]/g, '').replace(/\s+/g, ' ').trim();
    const description = plainText.slice(0, 200) + (plainText.length > 200 ? '...' : '');
    return {title, slug, category, date, authors, tags, description};
  } catch {
    return null;
  }
}

// ── Simple TTL cache for expensive endpoints ──
const cache = {};
function cached(key, ttlMs, fn) {
  const entry = cache[key];
  if (entry && Date.now() - entry.time < ttlMs) return entry.data;
  const data = fn();
  cache[key] = {data, time: Date.now()};
  return data;
}

function invalidateCache(pattern) {
  for (const key of Object.keys(cache)) {
    if (!pattern || key.includes(pattern)) delete cache[key];
  }
}

// ── In-memory presence store (ephemeral) ──
const presenceStore = {}; // { [filePath]: { [userId]: {userId, userName, cursor, lastSeen} } }

const MAX_PRESENCE_FILES = 500;
const MAX_PRESENCE_USERS_PER_FILE = 50;

function cleanStalePresence() {
  const now = Date.now();
  const STALE_MS = 30000;
  for (const filePath of Object.keys(presenceStore)) {
    for (const userId of Object.keys(presenceStore[filePath])) {
      if (now - presenceStore[filePath][userId].lastSeen > STALE_MS) {
        delete presenceStore[filePath][userId];
      }
    }
    if (Object.keys(presenceStore[filePath]).length === 0) {
      delete presenceStore[filePath];
    }
  }
  const fileKeys = Object.keys(presenceStore);
  if (fileKeys.length > MAX_PRESENCE_FILES) {
    fileKeys.slice(MAX_PRESENCE_FILES).forEach(k => delete presenceStore[k]);
  }
}

setInterval(cleanStalePresence, 30000);

// ── In-memory rate limiter ──
const rateLimits = {};
function rateLimit(key, maxPerMinute) {
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = [];
  rateLimits[key] = rateLimits[key].filter(t => now - t < 60000);
  if (rateLimits[key].length >= maxPerMinute) return false;
  rateLimits[key].push(now);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateLimits)) {
    rateLimits[key] = rateLimits[key].filter(t => now - t < 60000);
    if (rateLimits[key].length === 0) delete rateLimits[key];
  }
  if (Object.keys(cache).length > 100) {
    for (const key of Object.keys(cache)) {
      if (Date.now() - cache[key].time > 60000) delete cache[key];
    }
  }
}, 60000);

// ── Scheduled publishing checker (runs every 60s) ──
setInterval(() => {
  try {
    const loaded = loadJSON(SCHEDULES_FILE);
    const schedules = Array.isArray(loaded) ? loaded : [];
    if (schedules.length === 0) return;
    const now = new Date();
    const remaining = [];
    for (const schedule of schedules) {
      if (new Date(schedule.publishAt) <= now) {
        try {
          const fullPath = path.join(PROJECT_ROOT, schedule.path);
          if (!fs.existsSync(fullPath)) {
            console.log(`[schedule] Skipping ${schedule.path}: file not found`);
            continue;
          }
          let content = fs.readFileSync(fullPath, 'utf-8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
          if (fmMatch) {
            let fm = fmMatch[1];
            if (/^draft:\s*.*/m.test(fm)) {
              fm = fm.replace(/^draft:\s*.*/m, 'draft: false');
            } else {
              fm += '\ndraft: false';
            }
            content = `---\n${fm}\n---\n` + content.slice(fmMatch[0].length);
          } else {
            content = '---\ndraft: false\n---\n' + content;
          }
          fs.writeFileSync(fullPath, content, 'utf-8');
          console.log(`[schedule] Published ${schedule.path} (was scheduled for ${schedule.publishAt})`);
        } catch (err) {
          console.error(`[schedule] Failed to publish ${schedule.path}:`, err.message);
        }
      } else {
        remaining.push(schedule);
      }
    }
    if (remaining.length !== schedules.length) {
      saveJSON(SCHEDULES_FILE, remaining);
    }
  } catch (err) {
    console.error('[schedule] Checker error:', err.message);
  }
}, 60000);

// ── Citation formatter ──
function formatAuthorAPA(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts.pop();
  return last + ', ' + parts.map(p => p[0].toUpperCase() + '.').join(' ');
}

function formatAuthorMLA(name) { return name.trim(); }

function formatAuthorIEEE(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts.pop();
  return parts.map(p => p[0].toUpperCase() + '.').join(' ') + ' ' + last;
}

function formatCitation(entry, style, key, index) {
  const authors = entry.author || [];
  const title = entry.title || 'Untitled';
  const year = entry.year || 'n.d.';
  const venue = entry.venue || '';
  const vol = entry.volume || '';
  const iss = entry.issue || '';
  const pages = entry.pages || '';
  const doi = entry.doi ? 'https://doi.org/' + entry.doi : '';

  if (style === 'apa') {
    let authorStr = '';
    if (authors.length === 0) authorStr = '';
    else if (authors.length === 1) authorStr = formatAuthorAPA(authors[0]);
    else if (authors.length === 2) authorStr = formatAuthorAPA(authors[0]) + ', & ' + formatAuthorAPA(authors[1]);
    else authorStr = authors.slice(0, -1).map(formatAuthorAPA).join(', ') + ', & ' + formatAuthorAPA(authors[authors.length - 1]);
    let cite = authorStr ? authorStr + ' ' : '';
    cite += '(' + year + '). ' + title + '.';
    if (venue) {
      cite += ' ' + venue;
      if (vol) cite += ', ' + vol;
      if (iss) cite += '(' + iss + ')';
      if (pages) cite += ', ' + pages;
      cite += '.';
    }
    if (doi) cite += ' ' + doi;
    return cite;
  }

  if (style === 'mla') {
    let authorStr = '';
    if (authors.length === 1) authorStr = formatAuthorMLA(authors[0]);
    else if (authors.length === 2) authorStr = formatAuthorMLA(authors[0]) + ', and ' + formatAuthorMLA(authors[1]);
    else if (authors.length >= 3) authorStr = formatAuthorMLA(authors[0]) + ', et al.';
    let cite = authorStr ? authorStr + '. ' : '';
    cite += '"' + title + '."';
    if (venue) {
      cite += ' ' + venue;
      if (vol) {
        cite += ' ' + vol;
        if (iss) cite += '.' + iss;
      }
      cite += ' (' + year + ')';
      if (pages) cite += ': ' + pages;
      cite += '.';
    }
    return cite;
  }

  if (style === 'chicago') {
    let authorStr = authors.map(formatAuthorMLA).join(', ');
    let cite = authorStr ? authorStr + '. ' : '';
    cite += '"' + title + '."';
    if (venue) {
      cite += ' ' + venue;
      if (vol) cite += ' ' + vol;
      if (iss) cite += ', no. ' + iss;
      cite += ' (' + year + ')';
      if (pages) cite += ': ' + pages;
      cite += '.';
    }
    if (doi) cite += ' ' + doi + '.';
    return cite;
  }

  if (style === 'ieee') {
    const num = typeof index === 'number' ? index : 1;
    let authorStr = authors.map(formatAuthorIEEE).join(', ');
    let cite = '[' + num + '] ';
    if (authorStr) cite += authorStr + ', ';
    cite += '"' + title + ',"';
    if (venue) cite += ' ' + venue;
    if (vol) cite += ', vol. ' + vol;
    if (pages) cite += ', pp. ' + pages;
    cite += ', ' + year + '.';
    return cite;
  }

  return title;
}

let requestCounter = 0;
const server = http.createServer(async (req, res) => {
  req.setTimeout(30000);
  const reqId = ++requestCounter;
  const start = Date.now();
  const origEnd = res.end.bind(res);
  res.end = function (...args) {
    const ms = Date.now() - start;
    if (req.url !== '/api/health' && req.method !== 'OPTIONS') {
      console.log(`[${reqId}] ${req.method} ${req.url} ${res.statusCode} ${ms}ms`);
    }
    return origEnd(...args);
  };

  if (req.method === 'OPTIONS') {
    return json(res, 204, null);
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── Health check ──
  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, {status: 'ok', uptime: process.uptime(), memory: process.memoryUsage().heapUsed});
  }

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
        const bibPath = path.join(PROJECT_ROOT, 'references.yaml');
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

  // ── Comments: list ──
  if (req.method === 'GET' && pathname === '/api/comments') {
    const page = url.searchParams.get('page');
    if (!page) return json(res, 400, {error: 'Missing page param'});
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
    const comments = loadJSON(COMMENTS_FILE);
    const all = comments[page] || [];
    const paginated = all.slice(offset, offset + limit);
    return json(res, 200, {comments: paginated, total: all.length});
  }

  // ── Comments: create ──
  if (req.method === 'POST' && pathname === '/api/comments') {
    if (!rateLimit(`comments:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {page, author, text, parentId, userId} = body;
      if (!page || typeof page !== 'string') return json(res, 400, {error: 'Missing or invalid page'});
      if (!text || typeof text !== 'string') return json(res, 400, {error: 'Missing or invalid text'});
      if (['__proto__', 'constructor', 'prototype'].includes(page)) return json(res, 400, {error: 'Invalid page'});
      if (author !== undefined && typeof author !== 'string') return json(res, 400, {error: 'author must be a string'});
      if (parentId !== undefined && typeof parentId !== 'string') return json(res, 400, {error: 'parentId must be a string'});
      if (userId !== undefined && typeof userId !== 'string') return json(res, 400, {error: 'userId must be a string'});
      const comments = loadJSON(COMMENTS_FILE);
      if (!comments[page]) comments[page] = [];
      const comment = {
        id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        author: sanitizeText(author) || 'Anonymous',
        text: sanitizeText(text),
        parentId: parentId ? sanitizeText(parentId) : null,
        userId: userId ? sanitizeText(userId) : null,
        createdAt: new Date().toISOString(),
      };
      comments[page].push(comment);
      saveJSON(COMMENTS_FILE, comments);
      return json(res, 200, {comment});
    } catch {
      return json(res, 400, {error: 'Failed to create comment: request body must be JSON with "page" (string) and "text" (string) fields'});
    }
  }

  // ── Comments: delete ──
  if (req.method === 'DELETE' && pathname === '/api/comments') {
    try {
      const body = await readBody(req);
      const {page, commentId, userId} = body;
      if (!page || !commentId) return json(res, 400, {error: 'Missing page or commentId'});
      const comments = loadJSON(COMMENTS_FILE);
      if (!comments[page]) return json(res, 404, {error: 'Page not found'});
      const idx = comments[page].findIndex(c => c.id === commentId);
      if (idx === -1) return json(res, 404, {error: 'Comment not found'});
      const comment = comments[page][idx];
      if (comment.userId && userId && comment.userId !== userId) {
        const users = loadJSON(USERS_FILE);
        const requester = users[userId];
        if (!requester || requester.role !== 'owner') {
          return json(res, 403, {error: 'Only the comment author or an admin can delete this comment'});
        }
      }
      comments[page].splice(idx, 1);
      saveJSON(COMMENTS_FILE, comments);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Notes: list all or get one ──
  if (req.method === 'GET' && pathname === '/api/notes') {
    const key = url.searchParams.get('key');
    const notes = loadJSON(NOTES_FILE);
    if (key) return json(res, 200, {note: notes[key] || null});
    return json(res, 200, {notes});
  }

  // ── Notes: save ──
  if (req.method === 'PUT' && pathname === '/api/notes') {
    try {
      const body = await readBody(req);
      const {key, content, title} = body;
      if (!key || typeof key !== 'string') return json(res, 400, {error: 'Missing or invalid key'});
      if (typeof content !== 'string') return json(res, 400, {error: 'Content must be a string'});
      if (['__proto__', 'constructor', 'prototype'].includes(key)) return json(res, 400, {error: 'Invalid key'});
      if (title !== undefined && typeof title !== 'string') return json(res, 400, {error: 'title must be a string'});
      const notes = loadJSON(NOTES_FILE);
      notes[key] = {content: sanitizeText(content), title: sanitizeText(title) || key, updatedAt: new Date().toISOString()};
      saveJSON(NOTES_FILE, notes);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Failed to save note: request body must be JSON with "key" (string) and "content" (string) fields'});
    }
  }

  // ── Notes: delete ──
  if (req.method === 'DELETE' && pathname === '/api/notes') {
    try {
      const body = await readBody(req);
      const {key} = body;
      if (!key || typeof key !== 'string') return json(res, 400, {error: 'Missing or invalid key'});
      if (['__proto__', 'constructor', 'prototype'].includes(key)) return json(res, 400, {error: 'Invalid key'});
      const notes = loadJSON(NOTES_FILE);
      if (!notes[key]) return json(res, 404, {error: 'Note not found'});
      delete notes[key];
      saveJSON(NOTES_FILE, notes);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Failed to delete note: request body must be JSON with "key" (string) identifying the note to delete'});
    }
  }

  // ── References: search (for citation autocomplete) ──
  if (req.method === 'GET' && pathname === '/api/references') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      return json(res, 200, {references: refs});
    } catch {
      return json(res, 200, {references: {}});
    }
  }

  // ── Writing sessions tracking ──
  if (req.method === 'POST' && pathname === '/api/sessions') {
    try {
      const body = await readBody(req);
      const {userId, startTime, endTime, wordsWritten, filesEdited} = body;
      if (!userId || typeof userId !== 'string') return json(res, 400, {error: 'Missing or invalid userId'});
      if (!startTime || typeof startTime !== 'string') return json(res, 400, {error: 'Missing or invalid startTime'});
      if (['__proto__', 'constructor', 'prototype'].includes(userId)) return json(res, 400, {error: 'Invalid userId'});
      if (endTime !== undefined && typeof endTime !== 'string') return json(res, 400, {error: 'endTime must be a string'});
      if (wordsWritten !== undefined && typeof wordsWritten !== 'number') return json(res, 400, {error: 'wordsWritten must be a number'});
      if (filesEdited !== undefined && !Array.isArray(filesEdited)) return json(res, 400, {error: 'filesEdited must be an array'});
      if (Array.isArray(filesEdited) && filesEdited.length > 100) return json(res, 400, {error: 'filesEdited exceeds maximum length of 100'});
      const SESSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'sessions.json');
      const sessions = loadJSON(SESSIONS_FILE);
      if (!sessions[userId]) sessions[userId] = [];
      const session = {
        id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        startTime: sanitizeText(startTime),
        endTime: endTime ? sanitizeText(endTime) : new Date().toISOString(),
        wordsWritten: wordsWritten || 0,
        filesEdited: (filesEdited || []).slice(0, 100),
        duration: endTime ? Math.round((new Date(endTime) - new Date(startTime)) / 60000) : 0,
      };
      sessions[userId].push(session);
      if (sessions[userId].length > 1000) sessions[userId] = sessions[userId].slice(-1000);
      saveJSON(SESSIONS_FILE, sessions);
      return json(res, 200, {success: true, session});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/sessions') {
    const userId = url.searchParams.get('userId') || 'default';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
    const SESSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'sessions.json');
    const sessions = loadJSON(SESSIONS_FILE);
    const userSessions = (sessions[userId] || []).slice(-limit).reverse();
    const totalMinutes = userSessions.reduce((s, sess) => s + (sess.duration || 0), 0);
    const totalWords = userSessions.reduce((s, sess) => s + (sess.wordsWritten || 0), 0);
    return json(res, 200, {
      sessions: userSessions,
      summary: {totalSessions: userSessions.length, totalMinutes, totalWords},
    });
  }

  // ── Content table of contents (hierarchical site map) ──
  if (req.method === 'GET' && pathname === '/api/content-toc') {
    try {
      const toc = cached('content-toc', 30000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        function buildTOC(dir) {
          const entries = [];
          for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const children = buildTOC(fp);
              let title = entry.name;
              const catFile = path.join(fp, '_category_.json');
              if (fs.existsSync(catFile)) {
                try {
                  const cat = JSON.parse(fs.readFileSync(catFile, 'utf8'));
                  if (cat.label) title = cat.label;
                } catch {}
              }
              entries.push({type: 'directory', name: entry.name, title, children, path: path.relative(PROJECT_ROOT, fp)});
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              try {
                const content = fs.readFileSync(fp, 'utf-8');
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                if (fmMatch) {
                  const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                  if (tm) title = tm[1];
                }
              } catch {}
              entries.push({type: 'file', name: entry.name, title, path: path.relative(PROJECT_ROOT, fp)});
            }
          }
          return entries;
        }
        return buildTOC(contentDir);
      });
      return json(res, 200, {toc});
    } catch {
      return json(res, 500, {error: 'TOC generation failed'});
    }
  }

  // ── RSS feed of recent content updates ──
  if (req.method === 'GET' && pathname === '/api/feed/rss') {
    try {
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const items = [];
      function scanRSS(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scanRSS(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          try {
            const stat = fs.statSync(fp);
            const content = fs.readFileSync(fp, 'utf-8');
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let title = entry.name.replace(/\.(mdx?|md)$/, '');
            let date = stat.mtime.toISOString();
            if (fmMatch) {
              const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
              if (tm) title = tm[1];
              const dm = fmMatch[1].match(/^date:\s*["']?(\d{4}-\d{2}-\d{2})/m);
              if (dm) date = dm[1] + 'T00:00:00Z';
            }
            const relPath = path.relative(PROJECT_ROOT, fp);
            items.push({title, date, path: relPath, mtime: stat.mtimeMs});
          } catch {}
        }
      }
      scanRSS(contentDir);
      items.sort((a, b) => b.mtime - a.mtime);
      const recent = items.slice(0, 20);
      const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Mochi Lab</title>
<description>Recent content updates from Mochi Lab</description>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${recent.map(item => {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<item>
<title>${esc(item.title)}</title>
<link>/${esc(item.path.replace(/^content\//, '').replace(/\.(md|mdx)$/, ''))}</link>
<pubDate>${new Date(item.date).toUTCString()}</pubDate>
</item>`;
}).join('\n')}
</channel>
</rss>`;
      res.writeHead(200, {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Cache-Control': 'public, max-age=300',
      });
      return res.end(rss);
    } catch {
      return json(res, 500, {error: 'RSS feed generation failed'});
    }
  }

  // ── Import content from URL ──
  if (req.method === 'POST' && pathname === '/api/import-url') {
    if (!rateLimit(`import-url:${req.socket.remoteAddress}`, 5)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {url: sourceUrl, targetPath, title: customTitle} = body;
      if (!sourceUrl || typeof sourceUrl !== 'string') return json(res, 400, {error: 'Missing or invalid url'});
      if (!targetPath || typeof targetPath !== 'string') return json(res, 400, {error: 'Missing or invalid targetPath'});
      if (customTitle !== undefined && typeof customTitle !== 'string') return json(res, 400, {error: 'title must be a string'});
      if (!isValidFilePath(targetPath)) return json(res, 400, {error: 'Invalid targetPath'});
      if (!/^https?:\/\//i.test(sourceUrl)) return json(res, 400, {error: 'URL must start with http:// or https://'});
      const fullTarget = path.join(PROJECT_ROOT, targetPath);
      if (fs.existsSync(fullTarget)) return json(res, 409, {error: 'Target file already exists'});
      const https = sourceUrl.startsWith('https') ? require('https') : require('http');
      const fetchedText = await new Promise((resolve, reject) => {
        const req = https.get(sourceUrl, {headers: {'User-Agent': 'MochiLab/1.0'}, timeout: 10000}, (r) => {
          if (r.statusCode !== 200) { r.resume(); return resolve(null); }
          const chunks = [];
          r.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 1024 * 1024) { r.destroy(); resolve(null); } });
          r.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      if (!fetchedText) return json(res, 502, {error: 'Failed to fetch URL content'});
      let text = fetchedText.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const title = sanitizeText(customTitle) || 'Imported from ' + new URL(sourceUrl).hostname;
      const content = `---\ntitle: "${title}"\ndate: ${new Date().toISOString().slice(0, 10)}\nsource: "${sourceUrl}"\n---\n\n# ${title}\n\n${text.slice(0, 50000)}\n`;
      const dir = path.dirname(fullTarget);
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(fullTarget, content, 'utf-8');
      invalidateCache('search');
      return json(res, 200, {success: true, path: targetPath, wordCount: text.split(/\s+/).length});
    } catch {
      return json(res, 400, {error: 'Import failed'});
    }
  }

  // ── Content scheduling ──
  if (req.method === 'POST' && pathname === '/api/schedule') {
    try {
      const body = await readBody(req);
      const {path: filePath, publishAt, note} = body;
      if (!filePath || typeof filePath !== 'string') return json(res, 400, {error: 'Missing or invalid path'});
      if (!publishAt || typeof publishAt !== 'string') return json(res, 400, {error: 'Missing or invalid publishAt'});
      if (note !== undefined && typeof note !== 'string') return json(res, 400, {error: 'note must be a string'});
      const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'data', 'schedule.json');
      const schedule = loadJSON(SCHEDULE_FILE);
      if (!schedule.items) schedule.items = [];
      const item = {
        id: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        path: sanitizeText(filePath),
        publishAt: sanitizeText(publishAt),
        note: note ? sanitizeText(note) : '',
        createdAt: new Date().toISOString(),
        status: 'scheduled',
      };
      schedule.items.push(item);
      saveJSON(SCHEDULE_FILE, schedule);
      return json(res, 200, {success: true, item});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/schedule') {
    const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'data', 'schedule.json');
    const schedule = loadJSON(SCHEDULE_FILE);
    const items = (schedule.items || []).sort((a, b) => a.publishAt.localeCompare(b.publishAt));
    const now = new Date().toISOString();
    for (const item of items) {
      if (item.status === 'scheduled' && item.publishAt <= now) {
        item.status = 'due';
      }
    }
    return json(res, 200, {items, upcoming: items.filter(i => i.status === 'scheduled').length, due: items.filter(i => i.status === 'due').length});
  }

  if (req.method === 'DELETE' && pathname === '/api/schedule') {
    try {
      const body = await readBody(req);
      const {id} = body;
      if (!id) return json(res, 400, {error: 'Missing id'});
      const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'data', 'schedule.json');
      const schedule = loadJSON(SCHEDULE_FILE);
      if (!schedule.items) return json(res, 404, {error: 'Not found'});
      const idx = schedule.items.findIndex(i => i.id === id);
      if (idx === -1) return json(res, 404, {error: 'Scheduled item not found'});
      schedule.items.splice(idx, 1);
      saveJSON(SCHEDULE_FILE, schedule);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── File slides: convert markdown to slide presentation ──
  if (req.method === 'GET' && pathname === '/api/file/slides') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      let content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      let title = path.basename(filePath, path.extname(filePath));
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
      if (fmMatch) {
        const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
        if (tm) title = tm[1];
        content = content.slice(fmMatch[0].length);
      }
      const slides = content.split(/\n---\n|(?=\n## )/).filter(s => s.trim()).map(s => s.trim());
      return json(res, 200, {
        title,
        slides: slides.map((text, i) => ({
          index: i,
          content: text,
        })),
        totalSlides: slides.length,
      });
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Atom feed of recent content updates ──
  if (req.method === 'GET' && pathname === '/api/feed/atom') {
    try {
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const items = [];
      function scanAtom(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scanAtom(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          try {
            const stat = fs.statSync(fp);
            const content = fs.readFileSync(fp, 'utf-8');
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let title = entry.name.replace(/\.(mdx?|md)$/, '');
            let date = stat.mtime.toISOString();
            if (fmMatch) {
              const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
              if (tm) title = tm[1];
              const dm = fmMatch[1].match(/^date:\s*["']?(\d{4}-\d{2}-\d{2})/m);
              if (dm) date = dm[1] + 'T00:00:00Z';
            }
            items.push({title, date, path: path.relative(PROJECT_ROOT, fp), mtime: stat.mtimeMs});
          } catch {}
        }
      }
      scanAtom(contentDir);
      items.sort((a, b) => b.mtime - a.mtime);
      const recent = items.slice(0, 20);
      const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Mochi Lab</title>
<updated>${new Date().toISOString()}</updated>
<id>urn:mochi-lab:feed</id>
${recent.map(item => `<entry>
<title>${esc(item.title)}</title>
<link href="/${item.path.replace(/^content\//, '').replace(/\.(md|mdx)$/, '')}"/>
<updated>${item.date}</updated>
<id>urn:mochi-lab:${esc(item.path)}</id>
</entry>`).join('\n')}
</feed>`;
      res.writeHead(200, {
        'Content-Type': 'application/atom+xml; charset=utf-8',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Cache-Control': 'public, max-age=300',
      });
      return res.end(atom);
    } catch {
      return json(res, 500, {error: 'Atom feed generation failed'});
    }
  }

  // ── Activity heatmap: daily activity for last N days ──
  if (req.method === 'GET' && pathname === '/api/activity-heatmap') {
    try {
      const days = Math.min(parseInt(url.searchParams.get('days') || '365', 10), 365);
      const heatmap = cached('activity-heatmap', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const activity = {};
        function scanActivity(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanActivity(fp); continue; }
            if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                const stat = fs.statSync(fp);
                const date = stat.mtime.toISOString().slice(0, 10);
                activity[date] = (activity[date] || 0) + 1;
              } catch {}
            }
          }
        }
        scanActivity(contentDir);
        const comments = loadJSON(COMMENTS_FILE);
        for (const page of Object.values(comments)) {
          if (Array.isArray(page)) {
            for (const c of page) {
              if (c.createdAt) {
                const d = c.createdAt.slice(0, 10);
                activity[d] = (activity[d] || 0) + 1;
              }
            }
          }
        }
        return activity;
      });
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const filtered = {};
      for (const [date, count] of Object.entries(heatmap)) {
        if (date >= cutoff) filtered[date] = count;
      }
      return json(res, 200, {days: filtered, totalDays: Object.keys(filtered).length});
    } catch {
      return json(res, 500, {error: 'Heatmap failed'});
    }
  }

  // ── Daily activity summary ──
  if (req.method === 'GET' && pathname === '/api/summary/daily') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const todayISO = today + 'T00:00:00.000Z';
      const comments = loadJSON(COMMENTS_FILE);
      let commentsToday = 0;
      for (const page of Object.values(comments)) {
        if (Array.isArray(page)) {
          commentsToday += page.filter(c => c.createdAt && c.createdAt >= todayISO).length;
        }
      }
      const discData = loadJSON(DISCUSSIONS_FILE);
      let messagesToday = 0;
      for (const msgs of Object.values(discData.messages || {})) {
        if (Array.isArray(msgs)) {
          messagesToday += msgs.filter(m => m.createdAt && m.createdAt >= todayISO).length;
        }
      }
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const modifiedToday = [];
      function findModified(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { findModified(fp); continue; }
          if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
            const stat = fs.statSync(fp);
            if (stat.mtime.toISOString().slice(0, 10) === today) {
              modifiedToday.push(path.relative(PROJECT_ROOT, fp));
            }
          }
        }
      }
      findModified(contentDir);
      const streakData = loadJSON(STREAKS_FILE);
      const defaultLog = (streakData['default'] && streakData['default'].dailyLog) || [];
      const todayEntry = defaultLog.find(e => e.date === today);
      return json(res, 200, {
        date: today,
        filesModifiedToday: modifiedToday.length,
        modifiedFiles: modifiedToday.slice(0, 20),
        commentsToday,
        messagesToday,
        wordsWrittenToday: todayEntry ? todayEntry.words : 0,
      });
    } catch {
      return json(res, 500, {error: 'Summary failed'});
    }
  }

  // ── References: format all in a given style ──
  if (req.method === 'GET' && pathname === '/api/references/format-all') {
    const style = url.searchParams.get('style') || 'apa';
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const formatted = [];
      for (const [key, entry] of Object.entries(refs)) {
        const authors = entry.author || [];
        const year = entry.year || 'n.d.';
        const title = entry.title || '';
        const venue = entry.venue || '';
        let citation;
        if (style === 'apa') {
          const authorStr = authors.length === 0 ? 'Unknown' :
            authors.length === 1 ? authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).map(n => n[0] + '.').join(' ') :
            authors.slice(0, -1).map(a => a.split(' ').pop() + ', ' + a.split(' ').slice(0, -1).map(n => n[0] + '.').join(' ')).join(', ') + ', & ' + authors[authors.length - 1].split(' ').pop() + ', ' + authors[authors.length - 1].split(' ').slice(0, -1).map(n => n[0] + '.').join(' ');
          citation = `${authorStr} (${year}). ${title}. ${venue ? venue + '.' : ''}`;
        } else if (style === 'mla') {
          const authorStr = authors.length === 0 ? 'Unknown' :
            authors.length === 1 ? authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).join(' ') :
            authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).join(' ') + ', et al.';
          citation = `${authorStr}. "${title}." ${venue ? venue + ', ' : ''}${year}.`;
        } else {
          citation = `${(authors.join(', ') || 'Unknown')}. "${title}." ${venue || ''} (${year}).`;
        }
        formatted.push({key, citation});
      }
      formatted.sort((a, b) => a.citation.localeCompare(b.citation));
      return json(res, 200, {style, references: formatted, total: formatted.length});
    } catch {
      return json(res, 500, {error: 'Format failed'});
    }
  }

  // ── References: group by venue ──
  if (req.method === 'GET' && pathname === '/api/references/by-venue') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const byVenue = {};
      for (const [key, entry] of Object.entries(refs)) {
        const venue = entry.venue || 'Unknown';
        if (!byVenue[venue]) byVenue[venue] = [];
        byVenue[venue].push({key, title: entry.title, year: entry.year, authors: entry.author});
      }
      const venues = Object.entries(byVenue)
        .map(([venue, papers]) => ({venue, count: papers.length, papers: papers.sort((a, b) => (b.year || 0) - (a.year || 0))}))
        .sort((a, b) => b.count - a.count);
      return json(res, 200, {venues, totalVenues: venues.length});
    } catch {
      return json(res, 500, {error: 'Failed to group references by venue: references.yaml may be missing or contain invalid YAML syntax'});
    }
  }

  // ── References: group by author ──
  if (req.method === 'GET' && pathname === '/api/references/by-author') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const byAuthor = {};
      for (const [key, entry] of Object.entries(refs)) {
        for (const author of (entry.author || ['Unknown'])) {
          if (!byAuthor[author]) byAuthor[author] = [];
          byAuthor[author].push({key, title: entry.title, year: entry.year, venue: entry.venue});
        }
      }
      const authors = Object.entries(byAuthor)
        .map(([author, papers]) => ({author, count: papers.length, papers: papers.sort((a, b) => (b.year || 0) - (a.year || 0))}))
        .sort((a, b) => b.count - a.count);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      return json(res, 200, {authors: authors.slice(0, limit), totalAuthors: authors.length});
    } catch {
      return json(res, 500, {error: 'Failed to group references by author: references.yaml may be missing or contain invalid YAML syntax'});
    }
  }

  // ── References: year distribution ──
  if (req.method === 'GET' && pathname === '/api/references/year-distribution') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const byYear = {};
      const byVenue = {};
      for (const entry of Object.values(refs)) {
        const year = entry.year || 'unknown';
        byYear[year] = (byYear[year] || 0) + 1;
        if (entry.venue) {
          byVenue[entry.venue] = (byVenue[entry.venue] || 0) + 1;
        }
      }
      const years = Object.entries(byYear)
        .filter(([y]) => y !== 'unknown')
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([year, count]) => ({year: Number(year), count}));
      const topVenues = Object.entries(byVenue)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([venue, count]) => ({venue, count}));
      return json(res, 200, {
        years,
        topVenues,
        totalReferences: Object.keys(refs).length,
        unknownYear: byYear['unknown'] || 0,
      });
    } catch {
      return json(res, 500, {error: 'Year distribution failed'});
    }
  }

  // ── References: similar papers based on shared co-citations and venue ──
  if (req.method === 'GET' && pathname === '/api/references/similar') {
    const key = url.searchParams.get('key');
    if (!key) return json(res, 400, {error: 'Missing key'});
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const target = refs[key];
      if (!target) return json(res, 404, {error: 'Reference not found'});
      const targetAuthors = new Set((target.author || []).map(a => a.toLowerCase()));
      const targetVenue = (target.venue || '').toLowerCase();
      const targetYear = target.year || 0;
      const candidates = [];
      for (const [k, entry] of Object.entries(refs)) {
        if (k === key) continue;
        let score = 0;
        const entryAuthors = new Set((entry.author || []).map(a => a.toLowerCase()));
        for (const a of targetAuthors) { if (entryAuthors.has(a)) score += 3; }
        if (targetVenue && (entry.venue || '').toLowerCase() === targetVenue) score += 2;
        if (entry.year && Math.abs((entry.year || 0) - targetYear) <= 2) score += 1;
        const targetWords = new Set((target.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const entryWords = (entry.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
        for (const w of entryWords) { if (targetWords.has(w)) score += 0.5; }
        if (score > 1) {
          candidates.push({key: k, title: entry.title, year: entry.year, venue: entry.venue, authors: entry.author, score: Math.round(score * 10) / 10});
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      return json(res, 200, {key, similar: candidates.slice(0, 15)});
    } catch {
      return json(res, 500, {error: 'Similar papers search failed'});
    }
  }

  // ── References: format citation in APA/MLA/Chicago style ──
  if (req.method === 'GET' && pathname === '/api/references/format') {
    const key = url.searchParams.get('key');
    const style = url.searchParams.get('style') || 'apa';
    if (!key) return json(res, 400, {error: 'Missing key'});
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const entry = refs[key];
      if (!entry) return json(res, 404, {error: 'Reference not found'});
      const authors = entry.author || [];
      const year = entry.year || 'n.d.';
      const title = entry.title || '';
      const venue = entry.venue || '';
      let formatted;
      if (style === 'apa') {
        const authorStr = authors.length === 0 ? 'Unknown' :
          authors.length === 1 ? authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).map(n => n[0] + '.').join(' ') :
          authors.slice(0, -1).map(a => a.split(' ').pop() + ', ' + a.split(' ').slice(0, -1).map(n => n[0] + '.').join(' ')).join(', ') + ', & ' + authors[authors.length - 1].split(' ').pop() + ', ' + authors[authors.length - 1].split(' ').slice(0, -1).map(n => n[0] + '.').join(' ');
        formatted = `${authorStr} (${year}). ${title}. ${venue ? venue + '.' : ''}`;
      } else if (style === 'mla') {
        const authorStr = authors.length === 0 ? 'Unknown' :
          authors.length === 1 ? authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).join(' ') :
          authors[0].split(' ').pop() + ', ' + authors[0].split(' ').slice(0, -1).join(' ') + ', et al.';
        formatted = `${authorStr}. "${title}." ${venue ? venue + ', ' : ''}${year}.`;
      } else {
        const authorStr = authors.join(', ') || 'Unknown';
        formatted = `${authorStr}. "${title}." ${venue || ''} (${year}).`;
      }
      return json(res, 200, {key, style, formatted, entry});
    } catch {
      return json(res, 500, {error: 'Format failed'});
    }
  }

  // ── References: search with filtering ──
  if (req.method === 'GET' && pathname === '/api/references/search') {
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query) return json(res, 400, {error: 'Missing query'});
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
      const results = [];
      for (const [key, entry] of Object.entries(refs)) {
        const searchable = [
          key, entry.title || '', (entry.author || []).join(' '),
          entry.venue || '', String(entry.year || ''),
        ].join(' ').toLowerCase();
        if (searchable.includes(query)) {
          results.push({key, ...entry});
          if (results.length >= limit) break;
        }
      }
      return json(res, 200, {results, total: results.length});
    } catch {
      return json(res, 500, {error: 'Search failed'});
    }
  }

  // ── References: add entry ──
  if (req.method === 'POST' && pathname === '/api/references') {
    if (!rateLimit(`add-ref:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody(req);
      const {key, entry} = body;
      if (!key || !entry) return json(res, 400, {error: 'Missing key or entry'});
      if (typeof key !== 'string' || key.length > 200) return json(res, 400, {error: 'Invalid key'});
      if (typeof entry !== 'object') return json(res, 400, {error: 'Invalid entry'});
      const bibPath = path.join(PROJECT_ROOT, 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      if (refs[key]) return json(res, 409, {error: 'Key already exists'});
      refs[key] = entry;
      fs.writeFileSync(bibPath, yaml.dump(refs, {lineWidth: -1}), 'utf-8');
      invalidateCache('stats');
      return json(res, 201, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Draft toggle ──
  if (req.method === 'POST' && pathname === '/api/file/draft') {
    if (!rateLimit(`file-draft:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: filePath, draft} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      if (typeof draft !== 'boolean') return json(res, 400, {error: 'draft must be a boolean'});
      const fullPath = path.join(PROJECT_ROOT, filePath);
      let content = fs.readFileSync(fullPath, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
      if (fmMatch) {
        let fm = fmMatch[1];
        if (/^draft:\s*.*/m.test(fm)) {
          fm = fm.replace(/^draft:\s*.*/m, `draft: ${draft}`);
        } else {
          fm += `\ndraft: ${draft}`;
        }
        content = `---\n${fm}\n---\n` + content.slice(fmMatch[0].length);
      } else {
        content = `---\ndraft: ${draft}\n---\n` + content;
      }
      fs.writeFileSync(fullPath, content, 'utf-8');
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── AI writing assistant (v2 – /api/ai/complete) ──
  if (req.method === 'POST' && pathname === '/api/ai/complete') {
    if (!rateLimit(`ai-complete:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {prompt, context, type} = body;
      if (!prompt || typeof prompt !== 'string') return json(res, 400, {error: 'Missing or invalid prompt'});
      if (context !== undefined && typeof context !== 'string') return json(res, 400, {error: 'context must be a string'});
      if (type !== undefined && typeof type !== 'string') return json(res, 400, {error: 'type must be a string'});
      const validTypes = ['continue', 'improve', 'explain', 'summarize'];
      if (type && !validTypes.includes(type)) {
        return json(res, 400, {error: `Invalid type. Must be one of: ${validTypes.join(', ')}`});
      }
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return json(res, 500, {error: 'ANTHROPIC_API_KEY is not set. Please set it in your environment: export ANTHROPIC_API_KEY=sk-ant-...'});
      }

      const systemPrompts = {
        continue: 'You are a writing assistant. Continue the text naturally, matching the style and tone. Output only the continuation, no preamble.',
        improve: 'You are an editing assistant. Improve the text for clarity, flow, and correctness while preserving the original meaning and tone. Output only the improved text, no preamble.',
        explain: 'You are a teaching assistant. Explain the given text in simple, clear terms. Be concise but thorough.',
        summarize: 'You are a summarization assistant. Provide a concise summary of the given text in 2-3 sentences.',
      };

      let userContent = prompt;
      if (context) {
        userContent = `Context:\n${context}\n\nText:\n${prompt}`;
      }

      const messages = [{role: 'user', content: userContent}];
      const requestBody = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages,
      };
      if (type && systemPrompts[type]) {
        requestBody.system = systemPrompts[type];
      }

      const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(requestBody),
      });

      const aiData = await aiResponse.json();
      if (!aiResponse.ok) {
        return json(res, 502, {error: aiData.error?.message || 'Anthropic API error'});
      }

      const text = aiData.content?.[0]?.text || 'No response generated';
      return json(res, 200, {text});
    } catch (err) {
      return json(res, 500, {error: 'AI request failed: ' + err.message});
    }
  }

  // ── Multi-source metadata aggregation ──
  if (req.method === 'GET' && pathname === '/api/metadata/search') {
    const query = url.searchParams.get('q');
    if (!query) return json(res, 400, {error: 'Missing query'});

    const https = require('https');

    function fetchJSON(fetchUrl) {
      return new Promise((resolve) => {
        https.get(fetchUrl, {headers: {'User-Agent': 'MochiLab/1.0'}}, (r) => {
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch { resolve(null); }
          });
        }).on('error', () => resolve(null));
      });
    }

    try {
      const [s2, crossref] = await Promise.all([
        fetchJSON(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=5&fields=title,authors,year,venue,externalIds,url`),
        fetchJSON(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=5`),
      ]);

      const results = [];

      if (s2?.data) {
        for (const p of s2.data) {
          results.push({
            source: 'semanticscholar',
            title: p.title,
            authors: (p.authors || []).map(a => a.name),
            year: p.year,
            venue: p.venue,
            doi: p.externalIds?.DOI,
            arxivId: p.externalIds?.ArXiv,
            url: p.url,
          });
        }
      }

      if (crossref?.message?.items) {
        for (const item of crossref.message.items) {
          results.push({
            source: 'crossref',
            title: item.title?.[0],
            authors: (item.author || []).map(a => `${a.given || ''} ${a.family || ''}`.trim()),
            year: item.published?.['date-parts']?.[0]?.[0],
            venue: item['container-title']?.[0],
            doi: item.DOI,
            url: item.URL,
          });
        }
      }

      return json(res, 200, {results});
    } catch {
      return json(res, 500, {error: 'Metadata search failed'});
    }
  }

  // ── References: enrich (GET - fetch metadata from multiple sources) ──
  if (req.method === 'GET' && pathname === '/api/references/enrich') {
    const citationKey = url.searchParams.get('key');
    if (!citationKey) return json(res, 400, {error: 'Missing key param'});

    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const entry = refs[citationKey];
      if (!entry) return json(res, 404, {error: `Reference "${citationKey}" not found`});

      const title = entry.title;
      if (!title) return json(res, 400, {error: 'Reference has no title to search for'});

      function curlJSON(curlUrl) {
        try {
          const out = execFileSync('curl', [
            '-sSL', '--max-time', '15',
            '-A', 'MochiLab/1.0 (bibliography enrichment)',
            curlUrl,
          ], {encoding: 'utf-8', timeout: 20000});
          return JSON.parse(out);
        } catch {
          return null;
        }
      }

      const encodedTitle = encodeURIComponent(title);

      const s2Data = curlJSON(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedTitle}&limit=1&fields=title,authors,year,venue,externalIds,citationCount,referenceCount,tldr`);
      const crossrefData = curlJSON(`https://api.crossref.org/works?query=${encodedTitle}&rows=1`);
      const dblpData = curlJSON(`https://dblp.org/search/publ/api?q=${encodedTitle}&format=json&h=1`);

      // Parse Semantic Scholar result
      const s2Result = {};
      if (s2Data?.data?.[0]) {
        const p = s2Data.data[0];
        s2Result.title = p.title;
        s2Result.authors = (p.authors || []).map(a => a.name);
        s2Result.year = p.year;
        s2Result.venue = p.venue;
        s2Result.doi = p.externalIds?.DOI || null;
        s2Result.arxivId = p.externalIds?.ArXiv || null;
        s2Result.citationCount = p.citationCount;
        s2Result.referenceCount = p.referenceCount;
        s2Result.tldr = p.tldr?.text || null;
      }

      // Parse CrossRef result
      const crossrefResult = {};
      if (crossrefData?.message?.items?.[0]) {
        const item = crossrefData.message.items[0];
        crossrefResult.title = item.title?.[0];
        crossrefResult.authors = (item.author || []).map(a => `${a.given || ''} ${a.family || ''}`.trim());
        crossrefResult.year = item.published?.['date-parts']?.[0]?.[0];
        crossrefResult.venue = item['container-title']?.[0];
        crossrefResult.doi = item.DOI;
        crossrefResult.url = item.URL;
        crossrefResult.publisher = item.publisher;
        crossrefResult.type = item.type;
        crossrefResult.volume = item.volume;
        crossrefResult.issue = item.issue;
        crossrefResult.pages = item.page;
        crossrefResult.issn = item.ISSN?.[0];
      }

      // Parse DBLP result
      const dblpResult = {};
      if (dblpData?.result?.hits?.hit?.[0]?.info) {
        const info = dblpData.result.hits.hit[0].info;
        dblpResult.title = info.title;
        dblpResult.authors = Array.isArray(info.authors?.author)
          ? info.authors.author.map(a => typeof a === 'string' ? a : a.text)
          : info.authors?.author ? [typeof info.authors.author === 'string' ? info.authors.author : info.authors.author.text] : [];
        dblpResult.year = info.year ? parseInt(info.year, 10) : null;
        dblpResult.venue = info.venue;
        dblpResult.doi = info.doi;
        dblpResult.url = info.ee;
        dblpResult.type = info.type;
        dblpResult.pages = info.pages;
        dblpResult.volume = info.volume;
      }

      return json(res, 200, {
        key: citationKey,
        current: entry,
        sources: {
          semanticScholar: Object.keys(s2Result).length > 0 ? s2Result : null,
          crossref: Object.keys(crossrefResult).length > 0 ? crossrefResult : null,
          dblp: Object.keys(dblpResult).length > 0 ? dblpResult : null,
        },
      });
    } catch (err) {
      return json(res, 500, {error: 'Enrichment failed: ' + err.message});
    }
  }

  // ── References: enrich (POST - apply enriched data to references.yaml) ──
  if (req.method === 'POST' && pathname === '/api/references/enrich') {
    if (!rateLimit(`enrich-ref:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const body = await readBody(req);
      const {key: citationKey, fields} = body;
      if (!citationKey || typeof citationKey !== 'string') return json(res, 400, {error: 'Missing or invalid key'});
      if (citationKey.length > 200) return json(res, 400, {error: 'Key too long'});
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return json(res, 400, {error: 'Missing fields object'});

      const bibPath = path.join(PROJECT_ROOT, 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      if (!refs[citationKey]) return json(res, 404, {error: `Reference "${citationKey}" not found`});

      // Merge the selected fields into the existing reference
      const allowedFields = ['title', 'author', 'year', 'venue', 'doi', 'arxivId', 'url', 'volume', 'issue', 'pages', 'publisher', 'type', 'citationCount', 'referenceCount', 'tldr'];
      for (const [field, value] of Object.entries(fields)) {
        if (allowedFields.includes(field) && value != null) {
          refs[citationKey][field] = value;
        }
      }

      fs.writeFileSync(bibPath, yaml.dump(refs, {lineWidth: -1}), 'utf-8');
      return json(res, 200, {success: true, entry: refs[citationKey]});
    } catch (err) {
      return json(res, 400, {error: 'Invalid request: ' + err.message});
    }
  }

  // ── Analytics: record pageview ──
  if (req.method === 'POST' && pathname === '/api/analytics/pageview') {
    if (!rateLimit(`pageview:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: pagePath, referrer, userAgent} = body;
      if (!pagePath || typeof pagePath !== 'string') return json(res, 400, {error: 'Missing path'});
      if (pagePath.length > 500) return json(res, 400, {error: 'Path too long'});
      if (["__proto__", "constructor", "prototype"].includes(pagePath)) return json(res, 400, {error: "Invalid path"});
      if (referrer !== undefined && typeof referrer !== "string") return json(res, 400, {error: "referrer must be a string"});
      if (userAgent !== undefined && typeof userAgent !== "string") return json(res, 400, {error: "userAgent must be a string"});
      const analytics = loadJSON(ANALYTICS_FILE);
      if (!analytics.counts) analytics.counts = {};
      if (!analytics.recent) analytics.recent = [];
      analytics.counts[pagePath] = (analytics.counts[pagePath] || 0) + 1;
      analytics.recent.unshift({
        path: pagePath,
        referrer: referrer ? sanitizeText(referrer) : null,
        userAgent: userAgent ? sanitizeText(userAgent) : null,
        timestamp: new Date().toISOString(),
      });
      if (analytics.recent.length > 100) analytics.recent = analytics.recent.slice(0, 100);
      saveJSON(ANALYTICS_FILE, analytics);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Analytics: get stats ──
  if (req.method === 'GET' && pathname === '/api/analytics') {
    const analytics = loadJSON(ANALYTICS_FILE);
    return json(res, 200, {
      pageviews: analytics.counts || {},
      recent: analytics.recent || [],
    });
  }

  // ── Users: list all ──
  if (req.method === 'GET' && pathname === '/api/users') {
    const users = loadJSON(USERS_FILE);
    return json(res, 200, {users});
  }

  // ── Users: get current user's role ──
  if (req.method === 'GET' && pathname === '/api/users/me') {
    const userId = url.searchParams.get('userId');
    if (!userId) return json(res, 400, {error: 'Missing userId'});
    const users = loadJSON(USERS_FILE);
    const user = users[userId];
    if (user) {
      return json(res, 200, {role: user.role, email: user.email, name: user.name});
    }
    return json(res, 200, {role: 'viewer'});
  }

  // ── Users: set role ──
  if (req.method === 'PUT' && /^\/api\/users\/[^/]+\/role$/.test(pathname)) {
    if (!rateLimit(`set-role:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      const userId = parts[3]; // /api/users/:id/role
      const body = await readBody(req);
      const {role, email, name, requesterId} = body;
      const validRoles = ['owner', 'editor', 'viewer'];
      if (!role || typeof role !== 'string' || !validRoles.includes(role)) return json(res, 400, {error: 'Invalid role. Must be owner, editor, or viewer'});
      if (['__proto__', 'constructor', 'prototype'].includes(userId)) return json(res, 400, {error: 'Invalid userId'});
      if (!requesterId || typeof requesterId !== 'string') return json(res, 403, {error: 'Missing or invalid requesterId'});
      if (["__proto__", "constructor", "prototype"].includes(requesterId)) return json(res, 400, {error: "Invalid requesterId"});
      if (email !== undefined && typeof email !== "string") return json(res, 400, {error: "email must be a string"});
      if (name !== undefined && typeof name !== "string") return json(res, 400, {error: "name must be a string"});
      const users = loadJSON(USERS_FILE);
      const requester = users[requesterId];
      if (!requester || requester.role !== 'owner') {
        return json(res, 403, {error: 'Only owners can change roles'});
      }
      users[userId] = {
        role,
        email: sanitizeText(email) || users[userId]?.email || '',
        name: sanitizeText(name) || users[userId]?.name || '',
        addedAt: users[userId]?.addedAt || new Date().toISOString(),
      };
      saveJSON(USERS_FILE, users);
      return json(res, 200, {success: true, user: users[userId]});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Presence: update own presence ──
  if (req.method === 'POST' && pathname === '/api/presence') {
    if (!rateLimit(`presence:${req.socket.remoteAddress}`, 120)) return json(res, 429, {error: 'Too many presence updates. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {filePath: presencePath, userId, userName, cursor} = body;
      if (!presencePath || !userId) return json(res, 400, {error: 'Missing filePath or userId'});
      if (typeof presencePath !== 'string' || typeof userId !== 'string') return json(res, 400, {error: 'filePath and userId must be strings'});
      if (presencePath.length > 500 || userId.length > 100) return json(res, 400, {error: 'filePath or userId too long'});
      if (!presenceStore[presencePath]) presenceStore[presencePath] = {};
      presenceStore[presencePath][userId] = {
        userId: sanitizeText(userId),
        userName: sanitizeText(userName) || 'Anonymous',
        cursor: cursor || null,
        lastSeen: Date.now(),
      };
      cleanStalePresence();
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Presence: list users editing a file ──
  if (req.method === 'GET' && pathname === '/api/presence') {
    const presencePath = url.searchParams.get('path');
    if (!presencePath) return json(res, 400, {error: 'Missing path param'});
    cleanStalePresence();
    const entries = presenceStore[presencePath] || {};
    const users = Object.values(entries);
    return json(res, 200, {users});
  }

  // ── Discussions: list channels ──
  if (req.method === 'GET' && pathname === '/api/discussions') {
    const data = loadJSON(DISCUSSIONS_FILE);
    const channels = data.channels || {};
    const messages = data.messages || {};
    const list = Object.entries(channels).map(([id, ch]) => ({
      id,
      ...ch,
      messageCount: (messages[id] || []).length,
    }));
    return json(res, 200, {channels: list});
  }

  // ── Discussions: create channel ──
  if (req.method === 'POST' && pathname === '/api/discussions') {
    if (!rateLimit(`disc-create:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {name, topic, linkedPage} = body;
      if (!name || typeof name !== 'string') return json(res, 400, {error: 'Missing or invalid channel name'});
      if (name.length > 100) return json(res, 400, {error: 'Channel name too long (max 100 characters)'});
      if (topic !== undefined && typeof topic !== 'string') return json(res, 400, {error: 'topic must be a string'});
      if (linkedPage !== undefined && typeof linkedPage !== 'string') return json(res, 400, {error: 'linkedPage must be a string'});
      const data = loadJSON(DISCUSSIONS_FILE);
      if (!data.channels) data.channels = {};
      if (!data.messages) data.messages = {};
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!id) return json(res, 400, {error: 'Channel name must contain at least one alphanumeric character'});
      if (data.channels[id]) return json(res, 409, {error: 'Channel already exists'});
      data.channels[id] = {
        name: sanitizeText(name),
        topic: sanitizeText(topic) || '',
        linkedPage: linkedPage ? sanitizeText(linkedPage) : null,
        createdAt: new Date().toISOString(),
      };
      data.messages[id] = [];
      saveJSON(DISCUSSIONS_FILE, data);
      return json(res, 201, {channel: {id, ...data.channels[id], messageCount: 0}});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Discussions: get messages for a channel ──
  if (req.method === 'GET' && pathname.match(/^\/api\/discussions\/[^/]+\/messages$/)) {
    const parts = pathname.split('/');
    const channelId = decodeURIComponent(parts[3]);
    const data = loadJSON(DISCUSSIONS_FILE);
    if (!data.channels || !data.channels[channelId]) {
      return json(res, 404, {error: 'Channel not found'});
    }
    const all = (data.messages || {})[channelId] || [];
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 1000);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
    const paginated = all.slice(offset, offset + limit);
    return json(res, 200, {messages: paginated, total: all.length});
  }

  // ── Discussions: search messages in a channel ──
  if (req.method === 'GET' && pathname.match(/^\/api\/discussions\/[^/]+\/messages\/search$/)) {
    const parts = pathname.split('/');
    const channelId = decodeURIComponent(parts[3]);
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query) return json(res, 400, {error: 'Missing query'});
    const data = loadJSON(DISCUSSIONS_FILE);
    if (!data.channels || !data.channels[channelId]) {
      return json(res, 404, {error: 'Channel not found'});
    }
    const all = (data.messages || {})[channelId] || [];
    const results = all.filter(m =>
      m.text.toLowerCase().includes(query) || m.author.toLowerCase().includes(query)
    );
    return json(res, 200, {results, total: results.length});
  }

  // ── Discussions: post message to a channel ──
  if (req.method === 'POST' && pathname.match(/^\/api\/discussions\/[^/]+\/messages$/)) {
    if (!rateLimit(`disc-msg:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      const channelId = decodeURIComponent(parts[3]);
      const data = loadJSON(DISCUSSIONS_FILE);
      if (!data.channels || !data.channels[channelId]) {
        return json(res, 404, {error: 'Channel not found'});
      }
      const body = await readBody(req);
      const {author, text} = body;
      if (!text || typeof text !== 'string') return json(res, 400, {error: 'Missing or invalid message text'});
      if (author !== undefined && typeof author !== 'string') return json(res, 400, {error: 'author must be a string'});
      if (!data.messages) data.messages = {};
      if (!data.messages[channelId]) data.messages[channelId] = [];
      const message = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        author: sanitizeText(author) || 'Anonymous',
        text: sanitizeText(text),
        createdAt: new Date().toISOString(),
      };
      data.messages[channelId].push(message);
      saveJSON(DISCUSSIONS_FILE, data);
      return json(res, 201, {message});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Discussions: edit a message in a channel ──
  if (req.method === 'PATCH' && pathname.match(/^\/api\/discussions\/[^/]+\/messages$/)) {
    if (!rateLimit(`disc-edit:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      const channelId = decodeURIComponent(parts[3]);
      const data = loadJSON(DISCUSSIONS_FILE);
      if (!data.channels || !data.channels[channelId]) {
        return json(res, 404, {error: 'Channel not found'});
      }
      const body = await readBody(req);
      const {messageId, text} = body;
      if (!messageId || typeof messageId !== 'string') return json(res, 400, {error: 'Missing or invalid messageId'});
      if (!text || typeof text !== 'string') return json(res, 400, {error: 'Missing or invalid text'});
      if (!data.messages || !data.messages[channelId]) {
        return json(res, 404, {error: 'No messages in channel'});
      }
      const msg = data.messages[channelId].find(m => m.id === messageId);
      if (!msg) return json(res, 404, {error: 'Message not found'});
      msg.text = sanitizeText(text);
      msg.editedAt = new Date().toISOString();
      saveJSON(DISCUSSIONS_FILE, data);
      return json(res, 200, {success: true, message: msg});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Discussions: delete message from a channel ──
  if (req.method === 'DELETE' && pathname.match(/^\/api\/discussions\/[^/]+\/messages$/)) {
    if (!rateLimit(`disc-delete:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      const channelId = decodeURIComponent(parts[3]);
      const data = loadJSON(DISCUSSIONS_FILE);
      if (!data.channels || !data.channels[channelId]) {
        return json(res, 404, {error: 'Channel not found'});
      }
      const body = await readBody(req);
      const {messageId} = body;
      if (!messageId) return json(res, 400, {error: 'Missing messageId'});
      if (!data.messages || !data.messages[channelId]) {
        return json(res, 404, {error: 'No messages in channel'});
      }
      const idx = data.messages[channelId].findIndex(m => m.id === messageId);
      if (idx === -1) return json(res, 404, {error: 'Message not found'});
      data.messages[channelId].splice(idx, 1);
      saveJSON(DISCUSSIONS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Discussions: delete channel ──
  if (req.method === 'DELETE' && pathname.match(/^\/api\/discussions\/[^/]+$/)) {
    if (!rateLimit(`disc-del-ch:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      const channelId = decodeURIComponent(parts[3]);
      const data = loadJSON(DISCUSSIONS_FILE);
      if (!data.channels || !data.channels[channelId]) {
        return json(res, 404, {error: 'Channel not found'});
      }
      delete data.channels[channelId];
      if (data.messages) delete data.messages[channelId];
      saveJSON(DISCUSSIONS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Preprint tracking: check single reference ──
  if (req.method === 'GET' && pathname === '/api/references/track') {
    const key = url.searchParams.get('key');
    if (!key) return json(res, 400, {error: 'Missing key param'});
    try {
      const yaml = require('js-yaml');
      const bibPath = path.join(PROJECT_ROOT, 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      const entry = refs[key];
      if (!entry) return json(res, 404, {error: 'Reference not found'});

      // Extract arXiv ID from URL or explicit field
      const arxivId = entry.arxivId || (entry.url && entry.url.match(/arxiv\.org\/abs\/([\d.]+)/)?.[1]) || null;
      if (!arxivId) return json(res, 200, {published: false, error: 'No arXiv ID found for this reference'});

      const https = require('https');
      const s2Url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=venue,year,externalIds,journal`;
      const data = await new Promise((resolve) => {
        https.get(s2Url, {headers: {'User-Agent': 'MochiLab/1.0'}}, (r) => {
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch { resolve(null); }
          });
        }).on('error', () => resolve(null));
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
      return json(res, 500, {error: 'Track check failed: ' + err.message});
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

      const bibPath = path.join(PROJECT_ROOT, 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      const entry = refs[key];
      if (!entry) return json(res, 404, {error: 'Reference not found'});

      const arxivId = entry.arxivId || (entry.url && entry.url.match(/arxiv\.org\/abs\/([\d.]+)/)?.[1]) || null;
      if (!arxivId) return json(res, 400, {error: 'No arXiv ID found for this reference'});

      const https = require('https');
      const s2Url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=venue,year,externalIds,journal`;
      const data = await new Promise((resolve) => {
        https.get(s2Url, {headers: {'User-Agent': 'MochiLab/1.0'}}, (r) => {
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch { resolve(null); }
          });
        }).on('error', () => resolve(null));
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
      return json(res, 500, {error: 'Track update failed: ' + err.message});
    }
  }

  // ── Preprint tracking: batch check all ──
  if (req.method === 'POST' && pathname === '/api/references/track-all') {
    if (!rateLimit(`track-all:${req.socket.remoteAddress}`, 2)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const https = require('https');
      const bibPath = path.join(PROJECT_ROOT, 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};

      function fetchS2(arxivId) {
        return new Promise((resolve) => {
          const s2Url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=venue,year,externalIds,journal`;
          https.get(s2Url, {headers: {'User-Agent': 'MochiLab/1.0'}}, (r) => {
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { resolve(null); }
            });
          }).on('error', () => resolve(null));
        });
      }

      function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

      // Find all entries with arXiv IDs that don't have publishedVenue yet
      const toCheck = [];
      for (const [key, entry] of Object.entries(refs)) {
        const arxivId = entry.arxivId || (entry.url && entry.url.match(/arxiv\.org\/abs\/([\d.]+)/)?.[1]) || null;
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
      return json(res, 500, {error: 'Batch track failed: ' + err.message});
    }
  }

  // ── Recommendations: get paper recommendations based on bibliography ──
  if (req.method === 'GET' && pathname === '/api/recommendations') {
    if (!rateLimit(`recommendations:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const yaml = require('js-yaml');
      const https = require('https');
      const bibPath = path.join(PROJECT_ROOT, 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};

      function extractRecPaperId(entry) {
        if (entry.paperId) return entry.paperId;
        if (entry.url) {
          const arxivMatch = entry.url.match(/arxiv\.org\/abs\/(\d+\.\d+(?:v\d+)?)/);
          if (arxivMatch) return `ArXiv:${arxivMatch[1]}`;
          const doiMatch = entry.url.match(/doi\.org\/(10\.\d{4,}\/[^\s]+)/);
          if (doiMatch) return doiMatch[1];
        }
        if (entry.arxivId) return `ArXiv:${entry.arxivId}`;
        if (entry.doi) return entry.doi;
        return null;
      }

      const papersWithIds = [];
      for (const [key, entry] of Object.entries(refs)) {
        const paperId = extractRecPaperId(entry);
        if (paperId) papersWithIds.push({ key, entry, paperId });
      }

      if (papersWithIds.length === 0) {
        return json(res, 200, { recommendations: [] });
      }

      const recTopVenues = new Set([
        'NeurIPS', 'ICML', 'ICLR', 'CVPR', 'ICCV', 'ECCV', 'ACL', 'EMNLP',
        'NAACL', 'AAAI', 'IJCAI', 'Nature', 'Science', 'JMLR',
      ]);
      papersWithIds.sort((a, b) => {
        const aScore = (recTopVenues.has(a.entry.venue) ? 10 : 0) + ((a.entry.year || 2000) - 2000);
        const bScore = (recTopVenues.has(b.entry.venue) ? 10 : 0) + ((b.entry.year || 2000) - 2000);
        return bScore - aScore;
      });
      const seeds = papersWithIds.slice(0, 5);

      function fetchS2Recs(fetchUrl) {
        return new Promise((resolve) => {
          https.get(fetchUrl, { headers: { 'User-Agent': 'MochiLab/1.0' } }, (r) => {
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { resolve(null); }
            });
          }).on('error', () => resolve(null));
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

        for (const ref of data.data) {
          const cited = ref.citedPaper;
          if (!cited || !cited.title) continue;
          const titleLower = cited.title.toLowerCase().trim();
          if (existingTitles.has(titleLower)) continue;

          if (recMap.has(titleLower)) {
            const existing = recMap.get(titleLower);
            existing.score += 1;
            if (!existing.recommendedBy.includes(seed.entry.title)) {
              existing.recommendedBy.push(seed.entry.title);
            }
          } else {
            recMap.set(titleLower, {
              title: cited.title,
              authors: (cited.authors || []).map(a => a.name || a),
              year: cited.year,
              venue: cited.venue || '',
              arxivId: cited.externalIds?.ArXiv || null,
              score: 1,
              recommendedBy: [seed.entry.title],
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
      return json(res, 500, { error: 'Failed to fetch recommendations: ' + err.message });
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
      if (authors !== undefined && !Array.isArray(authors)) return json(res, 400, { error: 'authors must be an array' });
      if (Array.isArray(authors) && authors.length > 50) return json(res, 400, { error: 'authors exceeds maximum length of 50' });
      if (year !== undefined && typeof year !== 'number' && typeof year !== 'string') return json(res, 400, { error: 'year must be a number or string' });
      if (venue !== undefined && typeof venue !== 'string') return json(res, 400, { error: 'venue must be a string' });
      if (paperUrl !== undefined && typeof paperUrl !== 'string') return json(res, 400, { error: 'url must be a string' });
      if (arxivId !== undefined && typeof arxivId !== 'string') return json(res, 400, { error: 'arxivId must be a string' });

      const authorList = authors || [];
      const firstAuthor = authorList[0] || 'unknown';
      const lastName = firstAuthor.split(' ').pop().toLowerCase().replace(/[^a-z]/g, '');
      const yearStr = year || 'unknown';
      const baseKey = `${lastName}${yearStr}`;

      const bibPath = path.join(PROJECT_ROOT, 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};

      let finalKey = baseKey;
      let suffix = 1;
      while (refs[finalKey]) {
        const titleSlug = (title || '').split(/\s+/).slice(0, 1).join('').toLowerCase().replace(/[^a-z0-9]/g, '');
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
      else if (arxivId) entry.url = `https://arxiv.org/abs/${arxivId}`;
      if (arxivId) entry.arxivId = arxivId;

      refs[finalKey] = entry;
      fs.writeFileSync(bibPath, yaml.dump(refs, { lineWidth: -1 }), 'utf-8');

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
      const bibPath = path.join(PROJECT_ROOT, 'references.yaml');
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
    const templateDir = path.join(PROJECT_ROOT, 'template');
    try {
      const templates = [
        {id: 'blank', name: 'Blank Page', content: '---\ntitle: "Untitled"\ndate: {{date}}\n---\n\n# Untitled\n\n'},
        {id: 'blog', name: 'Blog Post', content: '---\ntitle: "{{title}}"\ndate: {{date}}\nauthors: [zy]\ntags: []\n---\n\n# {{title}}\n\n## Introduction\n\n## Main Content\n\n## Conclusion\n'},
        {id: 'research', name: 'Research Paper Summary', content: '---\ntitle: "{{title}}"\ndate: {{date}}\nauthors: [zy]\ntags: [research]\n---\n\n# {{title}}\n\n## Summary\n\n## Key Contributions\n\n## Method\n\n## Results\n\n## Discussion\n\n## References\n'},
        {id: 'math', name: 'Math Chapter', content: '---\ntitle: "{{title}}"\n---\n\nimport {Theorem, Definition, Proof, Remark} from \'@site/src/components/Math\';\n\n# {{title}}\n\n<Definition id="def-1" name="Definition Name">\nDefinition content.\n</Definition>\n\n<Theorem id="thm-1" name="Theorem Name">\nTheorem statement.\n</Theorem>\n\n<Proof>\nProof content.\n</Proof>\n'},
        {id: 'tutorial', name: 'Tutorial', content: '---\ntitle: "{{title}}"\nsidebar_position: 1\n---\n\n# {{title}}\n\n## Prerequisites\n\n## Step 1\n\n## Step 2\n\n## Step 3\n\n## Summary\n'},
      ];
      const body = JSON.stringify({templates});
      const etag = '"' + crypto.createHash('md5').update(body).digest('hex').slice(0, 16) + '"';
      const hdrs = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'X-API-Version': '1.0',
        'X-Powered-By': 'Mochi Lab',
        'ETag': etag,
        'Cache-Control': 'public, max-age=3600',
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, hdrs);
        return res.end();
      }
      res.writeHead(200, hdrs);
      return res.end(body);
    } catch {
      return json(res, 500, {error: 'Failed to load templates'});
    }
  }

  // ── Full-text search across all content files ──
  if (req.method === 'GET' && pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query) return json(res, 400, {error: 'Missing query'});
    try {
      const searchIndex = cached('search:index', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const index = [];
        function indexDir(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              indexDir(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const lower = content.toLowerCase();
                const words = new Set(lower.split(/[^a-z0-9À-ɏ一-鿿]+/).filter(w => w.length > 0));
                const firstLines = content.slice(0, 500);
                index.push({
                  path: path.relative(PROJECT_ROOT, fullPath),
                  name: entry.name,
                  words,
                  firstLines,
                  _content: content,
                  _lower: lower,
                });
              } catch {}
            }
          }
        }
        indexDir(contentDir);
        return index;
      });
      const queryWords = query.split(/\s+/).filter(w => w.length > 0);
      const results = [];
      for (const file of searchIndex) {
        // Fast path: check if all query words exist in the word set
        const allWordsMatch = queryWords.every(qw => {
          for (const w of file.words) {
            if (w.includes(qw)) return true;
          }
          return false;
        });
        if (!allWordsMatch) continue;
        // Confirmed match — find snippet position from the full text
        const idx = file._lower.indexOf(query);
        if (idx >= 0) {
          const start = Math.max(0, idx - 50);
          const end = Math.min(file._content.length, idx + query.length + 50);
          const snippet = file._content.slice(start, end).replace(/\n/g, ' ');
          results.push({
            path: file.path,
            name: file.name,
            snippet: (start > 0 ? '...' : '') + snippet + (end < file._content.length ? '...' : ''),
          });
        } else {
          // Words matched individually but not as exact phrase — show first lines as snippet
          const snippet = file.firstLines.replace(/\n/g, ' ').slice(0, 100);
          results.push({
            path: file.path,
            name: file.name,
            snippet: snippet + (file.firstLines.length > 100 ? '...' : ''),
          });
        }
        if (results.length >= 50) break;
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
      function scanReplace(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) { scanReplace(fullPath); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const occurrences = content.split(search).length - 1;
            if (occurrences > 0) {
              const relPath = path.relative(PROJECT_ROOT, fullPath);
              if (!dryRun) {
                const newContent = content.split(search).join(replace);
                fs.writeFileSync(fullPath, newContent, 'utf-8');
              }
              changes.push({path: relPath, occurrences});
            }
          } catch {}
        }
      }
      scanReplace(contentDir);
      invalidateCache('search');
      const totalOccurrences = changes.reduce((s, c) => s + c.occurrences, 0);
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
      const yaml = require('js-yaml');
      const bibPath = path.join(PROJECT_ROOT, 'references.yaml');
      const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      const bibliography = require('./plugins/docusaurus-plugin-bibliography');
      const lines = [];
      for (const [key, entry] of Object.entries(refs)) {
        const authors = (entry.author || []).join(' and ');
        const type = entry.type || 'misc';
        let bibtexType = type;
        if (type === 'article') bibtexType = 'article';
        else if (type === 'inproceedings') bibtexType = 'inproceedings';
        else if (type === 'book') bibtexType = 'book';
        const fields = [];
        fields.push(`  title = {${entry.title || ''}}`);
        if (authors) fields.push(`  author = {${authors}}`);
        if (entry.year) fields.push(`  year = {${entry.year}}`);
        if (entry.venue) {
          if (bibtexType === 'inproceedings') fields.push(`  booktitle = {${entry.venue}}`);
          else if (bibtexType === 'article') fields.push(`  journal = {${entry.venue}}`);
          else fields.push(`  howpublished = {${entry.venue}}`);
        }
        if (entry.url) fields.push(`  url = {${entry.url}}`);
        if (entry.doi) fields.push(`  doi = {${entry.doi}}`);
        if (entry.volume) fields.push(`  volume = {${entry.volume}}`);
        if (entry.pages) fields.push(`  pages = {${entry.pages}}`);
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

  // ── Graph: wiki link connections between all pages ──
  if (req.method === 'GET' && pathname === '/api/graph') {
    try {
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      const nodes = [];
      const edges = [];
      const nodeMap = {};

      // Collect all markdown/mdx files
      function collectGraphFiles(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            collectGraphFiles(fullPath);
          } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
            const relPath = path.relative(path.join(PROJECT_ROOT, 'content'), fullPath);
            // Build a route-like id: strip extension, strip trailing /index
            let id = relPath.replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
            if (id.endsWith('/index')) id = id.slice(0, -6);

            // Extract title from frontmatter or first heading
            const content = fs.readFileSync(fullPath, 'utf-8');
            let title = entry.name.replace(/\.(mdx?|md)$/, '');
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
              const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
              if (titleMatch) title = titleMatch[1];
            }
            if (title === entry.name.replace(/\.(mdx?|md)$/, '')) {
              const headingMatch = content.match(/^#\s+(.+)$/m);
              if (headingMatch) title = headingMatch[1];
            }

            // Determine directory category
            const parts = relPath.split(path.sep);
            let category = parts.length > 1 ? parts[0] : '';
            // For books/X and posts/X, use X as the category
            if ((category === 'books' || category === 'posts') && parts.length > 2) {
              category = parts[1];
            }

            const node = {id, path: relPath, title, category};
            nodes.push(node);
            nodeMap[id] = node;

            // Extract wiki links
            WIKI_LINK_RE.lastIndex = 0;
            let match;
            while ((match = WIKI_LINK_RE.exec(content)) !== null) {
              const target = match[1].trim();
              edges.push({source: id, target});
            }
          }
        }
      }
      collectGraphFiles(contentDir);

      // Resolve edge targets: wiki links use route paths
      // Keep only edges where target matches a known node id
      const nodeIds = new Set(nodes.map(n => n.id));
      const resolvedEdges = [];
      for (const edge of edges) {
        let targetId = edge.target;
        if (nodeIds.has(targetId)) {
          resolvedEdges.push({source: edge.source, target: targetId});
        } else {
          // Try matching against the last segment(s)
          const found = nodes.find(n => n.id.endsWith(targetId) || n.id.endsWith('/' + targetId));
          if (found) {
            resolvedEdges.push({source: edge.source, target: found.id});
          }
        }
      }

      return json(res, 200, {nodes, edges: resolvedEdges});
    } catch (err) {
      return json(res, 500, {error: 'Graph generation failed: ' + err.message});
    }
  }

  // ── Trash: list trashed files ──
  if (req.method === 'GET' && pathname === '/api/trash') {
    try {
      if (!fs.existsSync(TRASH_DIR)) return json(res, 200, {files: []});
      const files = [];
      function walkTrash(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkTrash(fullPath);
          } else {
            const trashRelPath = path.relative(PROJECT_ROOT, fullPath);
            // Extract timestamp and original filename from the trashed name
            // Format: YYYY-MM-DDTHH-MM-SS-sssZ_originalname.md
            const match = entry.name.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)$/);
            if (!match) continue;
            const deletedAt = match[1].replace(/(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3Z').replace(/T(\d{2})-(\d{2})/, 'T$1:$2');
            const originalName = match[2];
            // Reconstruct original path: strip .trash/ prefix, use directory structure + original name
            const trashSubDir = path.relative(TRASH_DIR, dir);
            const originalPath = path.join(trashSubDir, originalName);
            files.push({
              trashPath: trashRelPath,
              originalPath,
              originalName,
              deletedAt,
            });
          }
        }
      }
      walkTrash(TRASH_DIR);
      // Sort newest first
      files.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
      return json(res, 200, {files});
    } catch {
      return json(res, 500, {error: 'Failed to list trash'});
    }
  }

  // ── Trash: restore a trashed file ──
  if (req.method === 'POST' && pathname === '/api/trash/restore') {
    if (!rateLimit(`trash-restore:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {trashPath} = body;
      if (!trashPath || typeof trashPath !== 'string') return json(res, 400, {error: 'Missing trashPath'});
      const normalized = path.normalize(trashPath);
      if (normalized.startsWith('..') || path.isAbsolute(normalized)) return json(res, 400, {error: 'Invalid path'});
      if (!normalized.startsWith('.trash/') && !normalized.startsWith('.trash' + path.sep)) return json(res, 400, {error: 'Path must be within .trash/'});
      const fullTrashPath = path.join(PROJECT_ROOT, normalized);
      if (!fs.existsSync(fullTrashPath)) return json(res, 404, {error: 'Trashed file not found'});
      // Extract original path from trash structure
      const trashedName = path.basename(normalized);
      const match = trashedName.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)$/);
      if (!match) return json(res, 400, {error: 'Invalid trash file format'});
      const originalName = match[2];
      const trashSubDir = path.relative(TRASH_DIR, path.dirname(fullTrashPath));
      const originalPath = path.join(trashSubDir, originalName);
      if (!isValidFilePath(originalPath)) return json(res, 400, {error: 'Cannot restore: original path is invalid'});
      const fullOriginalPath = path.join(PROJECT_ROOT, originalPath);
      if (fs.existsSync(fullOriginalPath)) return json(res, 409, {error: 'A file already exists at the original path. Rename or delete it first.'});
      const dir = path.dirname(fullOriginalPath);
      fs.mkdirSync(dir, {recursive: true});
      fs.renameSync(fullTrashPath, fullOriginalPath);
      return json(res, 200, {success: true, restoredPath: originalPath});
    } catch (err) {
      if (err.message === 'Invalid JSON') return json(res, 400, {error: 'Invalid request'});
      return json(res, 500, {error: 'Restore failed'});
    }
  }

  // ── Trash: permanently empty trash ──
  if (req.method === 'DELETE' && pathname === '/api/trash/empty') {
    if (!rateLimit(`trash-empty:${req.socket.remoteAddress}`, 2)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      if (!fs.existsSync(TRASH_DIR)) return json(res, 200, {success: true, deleted: 0});
      let deleted = 0;
      function countFiles(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.isDirectory()) countFiles(path.join(dir, entry.name));
          else deleted++;
        }
      }
      countFiles(TRASH_DIR);
      fs.rmSync(TRASH_DIR, {recursive: true, force: true});
      return json(res, 200, {success: true, deleted});
    } catch {
      return json(res, 500, {error: 'Failed to empty trash'});
    }
  }

  // ── Backlinks: find pages that link to a given page ──
  if (req.method === 'GET' && pathname === '/api/backlinks') {
    const targetPath = url.searchParams.get('path');
    if (!targetPath) return json(res, 400, {error: 'Missing path param'});
    try {
      const backlinks = cached(`backlinks:${targetPath}`, 60000, () => {
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const result = [];

      // Derive possible link targets from the file path
      // e.g. "content/docs/math/algebra.md" => match [[algebra]], [[math/algebra]], etc.
      const baseName = path.basename(targetPath, path.extname(targetPath));
      const relFromContent = path.relative('content', targetPath).replace(/\\/g, '/');
      const withoutExt = relFromContent.replace(/\.(md|mdx)$/, '');

      // Regex patterns
      const wikiLinkRe = /\[\[([^\]]+)\]\]/g;
      const citationRe = /\[@([^\]]+)\]/g;

      function extractTitle(content) {
        // Try frontmatter title first
        const fmMatch = content.match(/^---\n[\s\S]*?\ntitle:\s*["']?(.+?)["']?\s*\n[\s\S]*?\n---/);
        if (fmMatch) return fmMatch[1];
        // Fall back to first heading
        const headingMatch = content.match(/^#\s+(.+)$/m);
        if (headingMatch) return headingMatch[1];
        return null;
      }

      function scanDir(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
            const sourcePath = path.relative(PROJECT_ROOT, fullPath);
            // Don't report self-links
            if (sourcePath === targetPath) continue;
            try {
              const content = fs.readFileSync(fullPath, 'utf-8');
              const sourceTitle = extractTitle(content) || entry.name;

              // Check wiki links [[page]]
              let match;
              wikiLinkRe.lastIndex = 0;
              while ((match = wikiLinkRe.exec(content)) !== null) {
                const linkTarget = match[1].split('|')[0].trim(); // handle [[page|alias]]
                // Match if the link target equals the basename, or the full path without extension
                if (linkTarget === baseName || linkTarget === withoutExt ||
                    linkTarget === withoutExt.replace(/^docs\//, '')) {
                  result.push({sourcePath, sourceTitle, linkType: 'wikilink'});
                  break;
                }
              }

              citationRe.lastIndex = 0;
              while ((match = citationRe.exec(content)) !== null) {
                const citedKey = match[1].trim();
                if (citedKey === baseName || citedKey === withoutExt) {
                  result.push({sourcePath, sourceTitle, linkType: 'citation'});
                  break;
                }
              }
            } catch {}
          }
        }
      }

      scanDir(contentDir);
      return result;
      });
      return json(res, 200, {backlinks});
    } catch {
      return json(res, 500, {error: 'Backlinks scan failed'});
    }
  }

  // ── Folder: create ──
  if (req.method === 'POST' && pathname === '/api/folder') {
    if (!rateLimit(`create-folder:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: dirPath} = body;
      if (!isValidDir(dirPath)) return json(res, 400, {error: 'Invalid path. Must start with content/'});
      const fullPath = path.join(PROJECT_ROOT, dirPath);
      if (fs.existsSync(fullPath)) return json(res, 409, {error: 'Directory already exists'});
      fs.mkdirSync(fullPath, {recursive: true});
      return json(res, 201, {success: true, path: dirPath});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Folder: delete (empty only) ──
  if (req.method === 'DELETE' && pathname === '/api/folder') {
    if (!rateLimit(`del-folder:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: dirPath} = body;
      if (!isValidDir(dirPath)) return json(res, 400, {error: 'Invalid path. Must start with content/'});
      const normalized = path.normalize(dirPath);
      if (normalized === 'content') return json(res, 400, {error: 'Cannot delete the root content directory'});
      const fullPath = path.join(PROJECT_ROOT, normalized);
      if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'Directory not found'});
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) return json(res, 400, {error: 'Path is not a directory'});
      const entries = fs.readdirSync(fullPath);
      if (entries.length > 0) return json(res, 400, {error: 'Directory is not empty'});
      fs.rmdirSync(fullPath);
      return json(res, 200, {success: true});
    } catch (err) {
      if (err.message === 'Invalid JSON') return json(res, 400, {error: 'Invalid request'});
      return json(res, 500, {error: 'Delete failed'});
    }
  }

  // ── File: move to a different directory ──
  if (req.method === 'POST' && pathname === '/api/file/move') {
    if (!rateLimit(`file-move:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {filePath, targetDir} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid file path'});
      if (!isValidDir(targetDir)) return json(res, 400, {error: 'Invalid target directory. Must start with content/'});
      const fullSource = path.join(PROJECT_ROOT, filePath);
      if (!fs.existsSync(fullSource)) return json(res, 404, {error: 'Source file not found'});
      const baseName = path.basename(filePath);
      const newPath = path.join(targetDir, baseName);
      if (!isValidFilePath(newPath)) return json(res, 400, {error: 'Resulting path is invalid'});
      const fullTarget = path.join(PROJECT_ROOT, newPath);
      if (fs.existsSync(fullTarget)) return json(res, 409, {error: 'A file already exists at the target location'});
      const fullTargetDir = path.join(PROJECT_ROOT, targetDir);
      fs.mkdirSync(fullTargetDir, {recursive: true});
      fs.renameSync(fullSource, fullTarget);
      return json(res, 200, {success: true, newPath});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── File: info / metadata ──
  if (req.method === 'GET' && pathname === '/api/file/info') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    const fullPath = path.join(PROJECT_ROOT, filePath);
    try {
      const stat = fs.statSync(fullPath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const wordCount = content.split(/\s+/).filter(Boolean).length;
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      const hasFrontmatter = !!fmMatch;
      let draft = false;
      if (fmMatch) {
        const draftMatch = fmMatch[1].match(/^draft:\s*(.+)$/m);
        if (draftMatch) draft = draftMatch[1].trim() === 'true';
      }
      // ── Content language detection ──
      // Count CJK characters (Chinese/Japanese/Korean unified ideographs + extensions)
      const cjkCount = (content.match(/[一-鿿㐀-䶿豈-﫿]/g) || []).length;
      // Count Latin letter characters
      const latinCount = (content.match(/[a-zA-Z]/g) || []).length;
      const totalLetters = cjkCount + latinCount;
      let detectedLanguage = 'mixed';
      if (totalLetters > 0) {
        const cjkRatio = cjkCount / totalLetters;
        const latinRatio = latinCount / totalLetters;
        if (cjkRatio > 0.3) detectedLanguage = 'chinese';
        else if (latinRatio > 0.7) detectedLanguage = 'english';
      }

      // ── Content feature detection ──
      const hasCodeBlocks = /```/.test(content);
      const hasMath = /\$\$|\$[^$\n]+\$/.test(content);
      const citationCount = (content.match(/\[@[^\]]+\]/g) || []).length;
      const imageCount = (content.match(/!\[[^\]]*\]/g) || []).length;

      return json(res, 200, {
        path: filePath,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        wordCount,
        hasFrontmatter,
        draft,
        detectedLanguage,
        hasCodeBlocks,
        hasMath,
        citationCount,
        imageCount,
      });
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Bundle export: combine multiple files into one document ──
  if (req.method === 'POST' && pathname === '/api/export/bundle') {
    if (!rateLimit(`export-bundle:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {paths, format} = body;
      if (!Array.isArray(paths) || paths.length === 0) return json(res, 400, {error: 'Missing paths array'});
      if (paths.length > 50) return json(res, 400, {error: 'paths exceeds maximum length of 50'});
      if (!paths.every(p => typeof p === 'string')) return json(res, 400, {error: 'All paths must be strings'});
      if (format !== undefined && typeof format !== 'string') return json(res, 400, {error: 'format must be a string'});
      const outputFormat = format || 'md';
      if (!['md', 'html'].includes(outputFormat)) return json(res, 400, {error: 'format must be md or html'});
      const sections = [];
      for (const filePath of paths.slice(0, 20)) {
        if (!isValidFilePath(filePath)) continue;
        try {
          let content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
          let title = path.basename(filePath, path.extname(filePath));
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
          if (fmMatch) {
            const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
            if (tm) title = tm[1];
            content = content.slice(fmMatch[0].length);
          }
          sections.push({title, content: content.trim(), path: filePath});
        } catch {}
      }
      if (outputFormat === 'md') {
        const md = sections.map(s => `# ${s.title}\n\n${s.content}`).join('\n\n---\n\n');
        res.writeHead(200, {'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="bundle.md"', 'Access-Control-Allow-Origin': CORS_ORIGIN});
        return res.end(md);
      }
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bundle Export</title><style>body{max-width:800px;margin:0 auto;padding:2rem;font-family:sans-serif;line-height:1.6}h1{border-bottom:2px solid #333;padding-bottom:8px}hr{margin:3rem 0}</style></head><body>${sections.map(s => `<h1>${s.title.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</h1>\n${s.content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}`).join('<hr>')}</body></html>`;
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'attachment; filename="bundle.html"', 'Access-Control-Allow-Origin': CORS_ORIGIN});
      return res.end(html);
    } catch {
      return json(res, 400, {error: 'Bundle export failed'});
    }
  }

  // ── Export file as markdown or HTML ──
  if (req.method === 'GET' && pathname === '/api/file/export') {
    const filePath = url.searchParams.get('path');
    const format = url.searchParams.get('format');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    if (!['md', 'html', 'pdf', 'latex', 'slides'].includes(format)) return json(res, 400, {error: 'Invalid format. Must be md, html, pdf, latex, or slides'});
    const fullPath = path.join(PROJECT_ROOT, filePath);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const baseName = path.basename(filePath, path.extname(filePath));

      if (format === 'md') {
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${baseName}.md"`,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(content);
      }

      // format === 'slides' — HTML slide deck
      if (format === 'slides') {
        let markdown = content;
        let title = baseName;
        const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
        if (fmMatch) {
          const fm = fmMatch[1];
          const tm = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
          if (tm) title = tm[1];
          markdown = markdown.slice(fmMatch[0].length);
        }
        const slides = markdown.split(/\n(?=## )/).filter(s => s.trim());
        const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const slideHtml = slides.map((s, i) => {
          let html = s.replace(/^## (.+)$/m, '<h2>$1</h2>').replace(/^### (.+)$/gm, '<h3>$1</h3>');
          html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
          html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
          html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
          html = html.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
          html = html.replace(/^(?!<[a-z/])((?!\s*$).+)$/gm, '<p>$1</p>');
          return `<section class="slide" id="slide-${i}">\n${html.trim()}\n</section>`;
        }).join('\n');
        const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#1a1a2e;color:#eee}
.slide{min-height:100vh;display:flex;flex-direction:column;justify-content:center;padding:4rem 8rem;border-bottom:1px solid #333}
h2{font-size:2.5rem;margin-bottom:1.5rem;color:#e94560}h3{font-size:1.5rem;margin:1rem 0;color:#0f3460}
p{font-size:1.2rem;line-height:1.8;margin:0.5rem 0}ul{margin:1rem 0 1rem 2rem}li{font-size:1.1rem;margin:0.3rem 0}
code{background:#16213e;padding:2px 6px;border-radius:3px;font-size:0.95em}
strong{color:#e94560}em{color:#0f3460}
nav{position:fixed;bottom:20px;right:20px;display:flex;gap:8px}
nav button{background:#16213e;color:#eee;border:1px solid #333;padding:8px 16px;cursor:pointer;border-radius:4px;font-size:0.9rem}
</style></head><body>
<section class="slide" id="slide-title" style="text-align:center"><h1 style="font-size:3rem;color:#e94560">${safeTitle}</h1><p style="font-size:1.3rem;color:#888">${slides.length} slides</p></section>
${slideHtml}
<nav><button onclick="prev()">Prev</button><button onclick="next()">Next</button></nav>
<script>
let cur=0;const slides=document.querySelectorAll('.slide');
function show(i){slides.forEach((s,j)=>s.style.display=j===i?'flex':'none');cur=i}
function next(){show(Math.min(cur+1,slides.length-1))}function prev(){show(Math.max(cur-1,0))}
show(0);document.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' ')next();if(e.key==='ArrowLeft')prev()});
</script></body></html>`;
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="${baseName}-slides.html"`, 'Access-Control-Allow-Origin': '*'});
        return res.end(fullHtml);
      }

      // format === 'latex' — convert to LaTeX
      if (format === 'latex') {
        let markdown = content;
        let title = baseName;
        let authors = '';
        const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
        if (fmMatch) {
          const fm = fmMatch[1];
          const tm = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
          if (tm) title = tm[1];
          const am = fm.match(/^authors?:\s*\[([^\]]*)\]/m);
          if (am) authors = am[1].split(',').map(a => a.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).join(' \\and ');
          markdown = markdown.slice(fmMatch[0].length);
        }
        let latex = markdown;
        latex = latex.replace(/^# (.+)$/gm, '\\section{$1}');
        latex = latex.replace(/^## (.+)$/gm, '\\subsection{$1}');
        latex = latex.replace(/^### (.+)$/gm, '\\subsubsection{$1}');
        latex = latex.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}');
        latex = latex.replace(/\*(.+?)\*/g, '\\textit{$1}');
        latex = latex.replace(/`([^`]+)`/g, '\\texttt{$1}');
        latex = latex.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `\\begin{verbatim}\n${code}\\end{verbatim}`);
        latex = latex.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '\\href{$2}{$1}');
        latex = latex.replace(/^- (.+)$/gm, '\\item $1');
        const safeTitle = title.replace(/[&%$#_{}~^\\]/g, s => '\\' + s);
        const fullLatex = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{hyperref}
\\title{${safeTitle}}
${authors ? `\\author{${authors}}` : ''}
\\date{\\today}
\\begin{document}
\\maketitle
${latex.trim()}
\\end{document}
`;
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${baseName}.tex"`,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(fullLatex);
      }

      // format === 'pdf' — print-optimized HTML with embedded styles
      if (format === 'pdf') {
        let markdown = content;
        let title = baseName;
        const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
        if (fmMatch) {
          const fm = fmMatch[1];
          const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
          if (titleMatch) title = titleMatch[1];
          markdown = markdown.slice(fmMatch[0].length);
        }
        let html = markdown;
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
          const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<pre><code>${escaped}</code></pre>`;
        });
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
        html = html.replace(/(^- .+$(\n- .+$)*)/gm, (match) => {
          const items = match.split('\n').map(line => `<li>${line.slice(2)}</li>`).join('\n');
          return `<ul>\n${items}\n</ul>`;
        });
        html = html.replace(/^(?!<[a-z/])((?!\s*$).+)$/gm, '<p>$1</p>');
        html = html.replace(/\n{3,}/g, '\n\n');
        const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
@page { size: A4; margin: 2cm; }
body { max-width: 700px; margin: 0 auto; padding: 2rem 1rem; font-family: "Times New Roman", Georgia, serif; font-size: 12pt; line-height: 1.8; color: #111; }
h1 { font-size: 20pt; margin-top: 0; border-bottom: 2px solid #333; padding-bottom: 8px; }
h2 { font-size: 16pt; margin-top: 1.5em; }
h3 { font-size: 13pt; margin-top: 1.2em; }
pre { background: #f5f5f5; padding: 12px; overflow-x: auto; border: 1px solid #ddd; font-size: 10pt; }
code { background: #f0f0f0; padding: 1px 4px; border-radius: 2px; font-size: 10pt; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #999; margin-left: 0; padding-left: 1rem; color: #555; }
a { color: #1a0dab; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
@media print {
  body { max-width: none; padding: 0; }
  a { color: inherit; text-decoration: none; }
  pre { border: 1px solid #ccc; }
}
</style>
</head>
<body>
${html.trim()}
<footer style="margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #ccc; font-size: 9pt; color: #888;">
Generated from Mochi Lab &mdash; ${new Date().toLocaleDateString()}
</footer>
</body>
</html>`;
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="${baseName}-print.html"`,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(fullHtml);
      }

      // format === 'html'
      // Strip frontmatter
      let markdown = content;
      let title = baseName;
      const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
      if (fmMatch) {
        const fm = fmMatch[1];
        const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
        if (titleMatch) title = titleMatch[1];
        markdown = markdown.slice(fmMatch[0].length);
      }

      // Convert markdown to basic HTML
      let html = markdown;

      // Code blocks (``` ... ```) — must come before inline code
      html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escaped}</code></pre>`;
      });

      // Headings
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

      // Bold and italic
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

      // Inline code
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

      // Links
      html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

      // Unordered lists: collect consecutive lines starting with "- "
      html = html.replace(/(^- .+$(\n- .+$)*)/gm, (match) => {
        const items = match.split('\n').map(line => `<li>${line.slice(2)}</li>`).join('\n');
        return `<ul>\n${items}\n</ul>`;
      });

      // Paragraphs: wrap remaining non-empty, non-tag lines
      html = html.replace(/^(?!<[a-z/])((?!\s*$).+)$/gm, '<p>$1</p>');

      // Clean up multiple blank lines
      html = html.replace(/\n{3,}/g, '\n\n');

      const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title>
<style>
body { max-width: 800px; margin: 2rem auto; padding: 0 1rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #333; }
pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; border-radius: 4px; }
code { background: #f0f0f0; padding: 0.15em 0.3em; border-radius: 3px; font-size: 0.9em; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #ddd; margin-left: 0; padding-left: 1rem; color: #666; }
a { color: #2563eb; }
</style>
</head>
<body>
${html.trim()}
</body>
</html>`;

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${baseName}.html"`,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(fullHtml);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Productivity report ──
  if (req.method === 'GET' && pathname === '/api/productivity-report') {
    try {
      const userId = url.searchParams.get('userId') || 'default';
      const streakData = loadJSON(STREAKS_FILE);
      const userLog = (streakData[userId] && streakData[userId].dailyLog) || [];
      const sorted = [...userLog].sort((a, b) => a.date.localeCompare(b.date));
      const today = new Date().toISOString().slice(0, 10);
      const last7Days = sorted.filter(e => e.date >= new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
      const last30Days = sorted.filter(e => e.date >= new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
      const totalWordsLast7 = last7Days.reduce((s, e) => s + e.words, 0);
      const totalWordsLast30 = last30Days.reduce((s, e) => s + e.words, 0);
      const avgWordsPerDay7 = last7Days.length > 0 ? Math.round(totalWordsLast7 / 7) : 0;
      const avgWordsPerDay30 = last30Days.length > 0 ? Math.round(totalWordsLast30 / 30) : 0;
      const analytics = loadJSON(ANALYTICS_FILE);
      const totalPageviews = Object.values(analytics.counts || {}).reduce((s, c) => s + c, 0);
      const recentPageviews = (analytics.recent || []).filter(r => r.timestamp >= new Date(Date.now() - 7 * 86400000).toISOString()).length;
      const yaml = require('js-yaml');
      let refCount = 0;
      try { refCount = Object.keys(yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {}).length; } catch {}
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
          activeDaysLast7: last7Days.filter(e => e.words >= 50).length,
          activeDaysLast30: last30Days.filter(e => e.words >= 50).length,
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
      const STOP = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not']);
      function extractWords(filePath) {
        let text = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
        text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/[^a-zA-Z\s]/g, ' ');
        return text.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
      }
      const words1 = extractWords(path1);
      const words2 = extractWords(path2);
      const set1 = new Set(words1);
      const set2 = new Set(words2);
      let intersection = 0;
      for (const w of set1) if (set2.has(w)) intersection++;
      const union = new Set([...set1, ...set2]).size;
      const jaccard = union > 0 ? Math.round((intersection / union) * 1000) / 1000 : 0;
      const sharedWords = [...set1].filter(w => set2.has(w)).slice(0, 20);
      return json(res, 200, {
        similarity: jaccard,
        sharedWords,
        uniqueToFile1: set1.size - intersection,
        uniqueToFile2: set2.size - intersection,
        sharedCount: intersection,
      });
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
      const yaml = require('js-yaml');
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
      try { refs = Object.keys(yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {}).length; } catch {}
      return json(res, 200, {
        files, words, headings, citations, links, references: refs,
        avgWordsPerFile: files > 0 ? Math.round(words / files) : 0,
        avgHeadingsPerFile: files > 0 ? Math.round(headings / files * 10) / 10 : 0,
        avgCitationsPerFile: files > 0 ? Math.round(citations / files * 10) / 10 : 0,
        readingTimeHours: Math.round(words / 200 / 60 * 10) / 10,
      });
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
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 100);
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
      const sourceContent = fs.readFileSync(path.join(PROJECT_ROOT, sourcePath), 'utf-8');
      const STOP = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not','can','all','each','some','more','most','other']);
      const sourceFm = sourceContent.match(/^---\n([\s\S]*?)\n---/);
      const sourceTags = new Set();
      if (sourceFm) {
        const tgm = sourceFm[1].match(/^tags:\s*\[([^\]]*)\]/m);
        if (tgm) tgm[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(t => sourceTags.add(t));
      }
      const sourceWords = new Set(sourceContent.replace(/^---[\s\S]*?---/, '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4 && !STOP.has(w)));
      const sourceCites = new Set();
      const CITE_RE = /\[@([\w-]+)/g;
      let m;
      while ((m = CITE_RE.exec(sourceContent)) !== null) sourceCites.add(m[1]);
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
            const pageWords = content.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4 && !STOP.has(w));
            let wordOverlap = 0;
            for (const w of pageWords) { if (sourceWords.has(w)) wordOverlap++; }
            score += Math.min(wordOverlap / Math.max(pageWords.length, 1) * 10, 5);
            CITE_RE.lastIndex = 0;
            const pageCites = new Set();
            while ((m = CITE_RE.exec(content)) !== null) pageCites.add(m[1]);
            let citeOverlap = 0;
            for (const c of pageCites) { if (sourceCites.has(c)) citeOverlap++; }
            score += citeOverlap * 3;
            if (score > 1) candidates.push({path: rel, title, score: Math.round(score * 10) / 10, sharedTags: [...pageTags].filter(t => sourceTags.has(t)), sharedCitations: citeOverlap});
          } catch {}
        }
      }
      scan(contentDir);
      candidates.sort((a, b) => b.score - a.score);
      return json(res, 200, {recommendations: candidates.slice(0, 10), sourcePath, basedOn: {tags: sourceTags.size, keywords: sourceWords.size, citations: sourceCites.size}});
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
      const byDay = {};
      for (const s of searches) {
        queryCounts[s.query] = (queryCounts[s.query] || 0) + 1;
        if (s.resultCount === 0) zeroResults++;
        if (s.timestamp) {
          const day = s.timestamp.slice(0, 10);
          byDay[day] = (byDay[day] || 0) + 1;
        }
      }
      const topQueries = Object.entries(queryCounts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([q, c]) => ({query: q, count: c}));
      const zeroResultQueries = searches.filter(s => s.resultCount === 0).map(s => s.query);
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
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      let score = 0;
      const checks = {};
      checks.hasFrontmatter = !!fm;
      if (fm) { score += 10; checks.hasTitle = /^title:/m.test(fm[1]); if (checks.hasTitle) score += 10; checks.hasTags = /^tags:/m.test(fm[1]); if (checks.hasTags) score += 5; checks.hasDate = /^date:/m.test(fm[1]); if (checks.hasDate) score += 5; }
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
      return json(res, 200, {path: filePath, healthScore: score, level, checks});
    } catch { return json(res, 404, {error: 'File not found'}); }
  }

  // ── Content reading path generator ──
  if (req.method === 'GET' && pathname === '/api/content-reading-path') {
    const startPath = url.searchParams.get('start');
    const maxDepth = Math.min(parseInt(url.searchParams.get('depth') || '3', 10), 5);
    if (!isValidFilePath(startPath)) return json(res, 400, {error: 'Invalid start path'});
    try {
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const WIKI_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
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
            WIKI_RE.lastIndex = 0;
            const links = [];
            let m;
            while ((m = WIKI_RE.exec(content)) !== null) links.push(m[1].trim());
            pageLinks[rel] = links;
          } catch {}
        }
      }
      scan(contentDir);
      const visited = new Set();
      const readingPath = [];
      function walk(filePath, depth) {
        if (depth > maxDepth || visited.has(filePath)) return;
        visited.add(filePath);
        readingPath.push({path: filePath, title: pageTitles[filePath] || filePath, depth});
        for (const link of (pageLinks[filePath] || [])) {
          const resolved = Object.keys(pageTitles).find(p => p.endsWith(link + '.md') || p.endsWith(link + '.mdx') || p.includes('/' + link + '.'));
          if (resolved && !visited.has(resolved)) {
            walk(resolved, depth + 1);
          }
        }
      }
      walk(startPath, 0);
      return json(res, 200, {startPath, readingPath, totalPages: readingPath.length, maxDepthReached: Math.max(0, ...readingPath.map(p => p.depth))});
    } catch {
      return json(res, 404, {error: 'Start path not found'});
    }
  }

  // ── Bibliography JSON export ──
  if (req.method === 'GET' && pathname === '/api/references/export-json') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
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
      const STOP = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not','can','all','each','some','more','most','other','also','than','very','just','such','only']);
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
              text.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)).forEach(w => { freq[w] = (freq[w] || 0) + 1; });
            } catch {}
          }
        }
      }
      scan(fullDir);
      const words = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([word, count]) => ({word, count}));
      return json(res, 200, {directory: dir, words, totalUniqueWords: Object.keys(freq).length});
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
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const entry = refs[key];
      if (!entry) return json(res, 404, {error: 'Reference not found'});
      const suggestions = {};
      const FIELDS = ['type', 'venue', 'doi', 'url'];
      for (const field of FIELDS) {
        if (entry[field]) continue;
        const authors = entry.author || [];
        if (authors.length === 0) continue;
        for (const [otherKey, otherEntry] of Object.entries(refs)) {
          if (otherKey === key || !otherEntry[field]) continue;
          const otherAuthors = otherEntry.author || [];
          if (authors.some(a => otherAuthors.some(oa => oa.toLowerCase() === a.toLowerCase()))) {
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
      const yaml = require('js-yaml');
      let files = 0, words = 0, refs = 0;
      const contentDir = path.join(PROJECT_ROOT, 'content');
      function scan(dir) { for (const e of fs.readdirSync(dir, {withFileTypes: true})) { if (e.name.startsWith('.')) continue; const fp = path.join(dir, e.name); if (e.isDirectory()) { scan(fp); continue; } if (ALLOWED_EXTS.some(ext => e.name.endsWith(ext))) { files++; try { words += fs.readFileSync(fp, 'utf-8').split(/\s+/).filter(Boolean).length; } catch {} } } }
      scan(contentDir);
      try { refs = Object.keys(yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {}).length; } catch {}
      return json(res, 200, {files, words, references: refs, readingHours: Math.round(words / 200 / 60 * 10) / 10});
    } catch { return json(res, 500, {error: 'Summary failed'}); }
  }

  // ── Random reference ──
  if (req.method === 'GET' && pathname === '/api/references/random') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
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
      return json(res, 200, {pages: pages.slice(0, 20), total: pages.length, avgCitations: Math.round(pages.reduce((s, p) => s + p.citations, 0) / Math.max(pages.length, 1) * 10) / 10});
    } catch { return json(res, 500, {error: 'Citation density failed'}); }
  }

  // ── Nested heading tree for a file ──
  if (req.method === 'GET' && pathname === '/api/file/toc-tree') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
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
      return json(res, 200, {tree: buildTree(flat, minLevel), totalHeadings: flat.length});
    } catch { return json(res, 404, {error: 'File not found'}); }
  }

  // ── Directory statistics comparison ──
  if (req.method === 'GET' && pathname === '/api/stats/compare') {
    const dir1 = url.searchParams.get('dir1');
    const dir2 = url.searchParams.get('dir2');
    if (!isValidDir(dir1) || !isValidDir(dir2)) return json(res, 400, {error: 'Invalid directories'});
    try {
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
      return json(res, 200, {dir1: stats1, dir2: stats2, comparison: {
        fileDiff: stats1.files - stats2.files,
        wordDiff: stats1.words - stats2.words,
        avgWordsDiff: stats1.avgWordsPerFile - stats2.avgWordsPerFile,
      }});
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
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      if (!refs[key]) return json(res, 404, {error: 'Reference not found'});
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
      return json(res, 200, {key, title: refs[key].title, trajectory: citingPages, totalCitations: citingPages.length});
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
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
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
                for (let j = i + 1; j < arr.length; j++) {
                  if (!coOccurrences[arr[i]]) coOccurrences[arr[i]] = {};
                  if (!coOccurrences[arr[j]]) coOccurrences[arr[j]] = {};
                  coOccurrences[arr[i]][arr[j]] = (coOccurrences[arr[i]][arr[j]] || 0) + 1;
                  coOccurrences[arr[j]][arr[i]] = (coOccurrences[arr[j]][arr[i]] || 0) + 1;
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
        for (let iter = 0; iter < 20; iter++) {
          const newScores = {};
          for (const k of keys) {
            let sum = 0;
            const neighbors = coOccurrences[k] || {};
            for (const [n, weight] of Object.entries(neighbors)) {
              const totalOut = Object.values(coOccurrences[n] || {}).reduce((s, v) => s + v, 0);
              if (totalOut > 0) sum += (scores[n] * weight) / totalOut;
            }
            newScores[k] = (1 - damping) + damping * sum;
          }
          Object.assign(scores, newScores);
        }
        return Object.entries(scores)
          .map(([key, score]) => ({key, title: refs[key].title, year: refs[key].year, venue: refs[key].venue, rank: Math.round(score * 1000) / 1000}))
          .sort((a, b) => b.rank - a.rank)
          .slice(0, 30);
      });
      return json(res, 200, {rankings: ranks, total: ranks.length});
    } catch {
      return json(res, 500, {error: 'PageRank failed'});
    }
  }

  // ── Content publishing calendar ──
  if (req.method === 'GET' && pathname === '/api/content-calendar') {
    try {
      const calendar = cached('content-calendar', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const byMonth = {};
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              let date = null;
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              if (fm) {
                const dm = fm[1].match(/^date:\s*["']?(\d{4}-\d{2})/m);
                if (dm) date = dm[1];
                const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                if (tm) title = tm[1];
              }
              if (!date) {
                const stat = fs.statSync(fp);
                date = stat.mtime.toISOString().slice(0, 7);
              }
              if (!byMonth[date]) byMonth[date] = [];
              byMonth[date].push({path: path.relative(PROJECT_ROOT, fp), title});
            } catch {}
          }
        }
        scan(contentDir);
        return Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([month, pages]) => ({month, count: pages.length, pages: pages.slice(0, 5)}));
      });
      return json(res, 200, {calendar, totalMonths: calendar.length});
    } catch {
      return json(res, 500, {error: 'Calendar failed'});
    }
  }

  // ── Bibliography analytics ──
  if (req.method === 'GET' && pathname === '/api/references/analytics') {
    try {
      const analytics = cached('bib-analytics', 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
        const entries = Object.values(refs);
        const years = entries.map(e => e.year).filter(Boolean);
        const avgYear = years.length > 0 ? Math.round(years.reduce((s, y) => s + y, 0) / years.length) : 0;
        const medianYear = years.length > 0 ? years.sort()[Math.floor(years.length / 2)] : 0;
        const avgAge = years.length > 0 ? Math.round(new Date().getFullYear() - avgYear) : 0;
        const authorCounts = {};
        for (const e of entries) {
          for (const a of (e.author || [])) authorCounts[a] = (authorCounts[a] || 0) + 1;
        }
        const venueCounts = {};
        for (const e of entries) { if (e.venue) venueCounts[e.venue] = (venueCounts[e.venue] || 0) + 1; }
        const typeCounts = {};
        for (const e of entries) { const t = e.type || 'misc'; typeCounts[t] = (typeCounts[t] || 0) + 1; }
        return {
          totalReferences: entries.length,
          avgYear, medianYear, avgAge,
          uniqueAuthors: Object.keys(authorCounts).length,
          uniqueVenues: Object.keys(venueCounts).length,
          topAuthors: Object.entries(authorCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => ({name: n, count: c})),
          topVenues: Object.entries(venueCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([v, c]) => ({venue: v, count: c})),
          typeDistribution: typeCounts,
          yearRange: years.length > 0 ? {min: Math.min(...years), max: Math.max(...years)} : null,
        };
      });
      return json(res, 200, analytics);
    } catch {
      return json(res, 500, {error: 'Analytics failed'});
    }
  }

  // ── Graph export as DOT format ──
  if (req.method === 'GET' && pathname === '/api/graph/export') {
    const format = url.searchParams.get('format') || 'dot';
    if (format !== 'dot') return json(res, 400, {error: 'Only DOT format supported'});
    try {
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const WIKI_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      const nodes = new Set();
      const edges = [];
      function scan(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scan(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          let id = path.relative(path.join(PROJECT_ROOT, 'content'), fp).replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
          if (id.endsWith('/index')) id = id.slice(0, -6);
          nodes.add(id);
          try {
            const content = fs.readFileSync(fp, 'utf-8');
            WIKI_RE.lastIndex = 0;
            let m;
            while ((m = WIKI_RE.exec(content)) !== null) {
              edges.push({from: id, to: m[1].trim()});
            }
          } catch {}
        }
      }
      scan(contentDir);
      const esc = s => s.replace(/"/g, '\\"');
      let dot = 'digraph KnowledgeGraph {\n  rankdir=LR;\n  node [shape=box, style=rounded];\n';
      for (const n of nodes) dot += `  "${esc(n)}";\n`;
      for (const e of edges) dot += `  "${esc(e.from)}" -> "${esc(e.to)}";\n`;
      dot += '}\n';
      res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="knowledge-graph.dot"', 'Access-Control-Allow-Origin': CORS_ORIGIN});
      return res.end(dot);
    } catch {
      return json(res, 500, {error: 'DOT export failed'});
    }
  }

  // ── Reference reading order (topological sort by citation deps) ──
  if (req.method === 'GET' && pathname === '/api/references/reading-order') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;
      const citesBefore = {};
      function scan(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scan(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          try {
            const content = fs.readFileSync(fp, 'utf-8');
            CITE_RE.lastIndex = 0;
            const pageCites = [];
            let m;
            while ((m = CITE_RE.exec(content)) !== null) {
              const keys = m[1].split(/\s*;\s*/).map(k => k.replace(/^@/, ''));
              pageCites.push(...keys);
            }
            for (let i = 0; i < pageCites.length; i++) {
              for (let j = i + 1; j < pageCites.length; j++) {
                const a = pageCites[i], b = pageCites[j];
                if (refs[a] && refs[b]) {
                  const yearA = refs[a].year || 9999;
                  const yearB = refs[b].year || 9999;
                  if (yearA < yearB) {
                    if (!citesBefore[b]) citesBefore[b] = new Set();
                    citesBefore[b].add(a);
                  } else if (yearB < yearA) {
                    if (!citesBefore[a]) citesBefore[a] = new Set();
                    citesBefore[a].add(b);
                  }
                }
              }
            }
          } catch {}
        }
      }
      scan(contentDir);
      const allKeys = Object.keys(refs);
      const visited = new Set();
      const order = [];
      function visit(key) {
        if (visited.has(key)) return;
        visited.add(key);
        for (const dep of (citesBefore[key] || [])) visit(dep);
        order.push(key);
      }
      allKeys.sort((a, b) => (refs[a].year || 9999) - (refs[b].year || 9999));
      for (const key of allKeys) visit(key);
      const readingOrder = order.slice(0, 30).map((key, i) => ({
        order: i + 1, key, title: refs[key].title, year: refs[key].year, venue: refs[key].venue,
        prerequisites: [...(citesBefore[key] || [])].slice(0, 5),
      }));
      return json(res, 200, {readingOrder, totalOrdered: order.length});
    } catch {
      return json(res, 500, {error: 'Reading order failed'});
    }
  }

  // ── Cross-reference matrix ──
  if (req.method === 'GET' && pathname === '/api/content-xref-matrix') {
    try {
      const matrix = cached('xref-matrix', 120000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const WIKI_RE = /\[\[([^\]|]+)/g;
        const CITE_RE = /\[@([\w-]+)/g;
        const pages = {};
        const links = [];
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            const rel = path.relative(PROJECT_ROOT, fp);
            let id = path.relative(path.join(PROJECT_ROOT, 'content'), fp).replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
            if (id.endsWith('/index')) id = id.slice(0, -6);
            let title = entry.name.replace(/\.(mdx?|md)$/, '');
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              pages[id] = title;
              WIKI_RE.lastIndex = 0;
              let m;
              while ((m = WIKI_RE.exec(content)) !== null) {
                links.push({from: id, to: m[1].trim(), type: 'wiki'});
              }
              CITE_RE.lastIndex = 0;
              while ((m = CITE_RE.exec(content)) !== null) {
                links.push({from: id, to: m[1], type: 'citation'});
              }
            } catch {}
          }
        }
        scan(contentDir);
        return {pages: Object.entries(pages).map(([id, title]) => ({id, title})).slice(0, 100), links: links.slice(0, 500), totalPages: Object.keys(pages).length, totalLinks: links.length};
      });
      return json(res, 200, matrix);
    } catch {
      return json(res, 500, {error: 'Matrix generation failed'});
    }
  }

  // ── Heading depth distribution ──
  if (req.method === 'GET' && pathname === '/api/stats/heading-depth') {
    try {
      const stats = cached('heading-depth', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const depthCounts = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0};
        let totalHeadings = 0, filesWithHeadings = 0, filesWithoutHeadings = 0;
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const headings = content.match(/^(#{1,6})\s+/gm) || [];
              if (headings.length > 0) {
                filesWithHeadings++;
                for (const h of headings) {
                  const depth = h.trim().replace(/\s+$/, '').length;
                  if (depthCounts[depth] !== undefined) depthCounts[depth]++;
                  totalHeadings++;
                }
              } else {
                filesWithoutHeadings++;
              }
            } catch {}
          }
        }
        scan(contentDir);
        return {depthCounts, totalHeadings, filesWithHeadings, filesWithoutHeadings};
      });
      return json(res, 200, stats);
    } catch {
      return json(res, 500, {error: 'Heading analysis failed'});
    }
  }

  // ── Content update suggestions ──
  if (req.method === 'GET' && pathname === '/api/content-update-suggestions') {
    try {
      const suggestions = cached('update-suggestions', 120000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const items = [];
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              const stat = fs.statSync(fp);
              const relPath = path.relative(PROJECT_ROOT, fp);
              const words = content.split(/\s+/).filter(Boolean).length;
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              const reasons = [];
              let priority = 0;
              if (words < 100) { reasons.push('Very short content (< 100 words)'); priority += 3; }
              if (!fm) { reasons.push('Missing frontmatter'); priority += 2; }
              else if (!/^title:/m.test(fm[1])) { reasons.push('Missing title in frontmatter'); priority += 2; }
              if (fm && !/^tags:/m.test(fm[1])) { reasons.push('No tags defined'); priority += 1; }
              const headings = (content.match(/^#{1,6}\s+/gm) || []).length;
              if (words > 500 && headings < 2) { reasons.push('Long content with few headings'); priority += 2; }
              const images = (content.match(/!\[/g) || []).length;
              if (words > 1000 && images === 0) { reasons.push('Long content with no images'); priority += 1; }
              if (reasons.length > 0) {
                items.push({path: relPath, title, reasons, priority, wordCount: words});
              }
            } catch {}
          }
        }
        scan(contentDir);
        return items.sort((a, b) => b.priority - a.priority).slice(0, 30);
      });
      return json(res, 200, {suggestions, total: suggestions.length});
    } catch {
      return json(res, 500, {error: 'Suggestions failed'});
    }
  }

  // ── Writing style analysis ──
  if (req.method === 'GET' && pathname === '/api/file/style') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      let text = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '');
      const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 5);
      const words = text.split(/\s+/).filter(Boolean);
      const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 10);
      const sentenceLengths = sentences.map(s => s.split(/\s+/).length);
      const avgSentence = sentenceLengths.length > 0 ? Math.round(sentenceLengths.reduce((s, l) => s + l, 0) / sentenceLengths.length * 10) / 10 : 0;
      const sentenceVariance = sentenceLengths.length > 1 ? Math.round(Math.sqrt(sentenceLengths.reduce((s, l) => s + Math.pow(l - avgSentence, 2), 0) / sentenceLengths.length) * 10) / 10 : 0;
      const passivePatterns = /\b(is|are|was|were|been|being)\s+(being\s+)?\w+ed\b/gi;
      const passiveCount = (text.match(passivePatterns) || []).length;
      const passivePercentage = sentences.length > 0 ? Math.round((passiveCount / sentences.length) * 100) : 0;
      const uniqueWords = new Set(words.map(w => w.toLowerCase())).size;
      const vocabularyDiversity = words.length > 0 ? Math.round((uniqueWords / words.length) * 100) / 100 : 0;
      const paragraphLengths = paragraphs.map(p => p.split(/\s+/).length);
      const avgParagraph = paragraphLengths.length > 0 ? Math.round(paragraphLengths.reduce((s, l) => s + l, 0) / paragraphLengths.length) : 0;
      return json(res, 200, {
        path: filePath,
        style: {
          avgSentenceLength: avgSentence,
          sentenceLengthVariation: sentenceVariance,
          passiveVoicePercentage: passivePercentage,
          vocabularyDiversity,
          avgParagraphLength: avgParagraph,
          totalSentences: sentences.length,
          totalParagraphs: paragraphs.length,
          totalWords: words.length,
        },
      });
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Content audience analysis ──
  if (req.method === 'GET' && pathname === '/api/content-audience') {
    try {
      const analysis = cached('content-audience', 120000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const byLevel = {beginner: [], intermediate: [], advanced: [], expert: []};
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              let text = fs.readFileSync(fp, 'utf-8');
              text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '');
              const words = text.split(/\s+/).filter(w => w.length > 0);
              const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 3);
              if (words.length < 20) return;
              const syllables = words.reduce((sum, w) => {
                const c = w.toLowerCase().replace(/[^a-z]/g, '');
                if (!c) return sum;
                let s = c.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
                return sum + Math.max(1, s ? s.length : 1);
              }, 0);
              const grade = 0.39 * (words.length / Math.max(sentences.length, 1)) + 11.8 * (syllables / words.length) - 15.59;
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = text.match(/title:\s*["']?(.+?)["']?\s*$/m);
              if (fm) title = fm[1];
              const level = grade <= 8 ? 'beginner' : grade <= 12 ? 'intermediate' : grade <= 16 ? 'advanced' : 'expert';
              byLevel[level].push({path: path.relative(PROJECT_ROOT, fp), title, grade: Math.round(grade * 10) / 10});
            } catch {}
          }
        }
        scan(contentDir);
        return byLevel;
      });
      return json(res, 200, {
        counts: {beginner: analysis.beginner.length, intermediate: analysis.intermediate.length, advanced: analysis.advanced.length, expert: analysis.expert.length},
        beginner: analysis.beginner.slice(0, 10),
        intermediate: analysis.intermediate.slice(0, 10),
        advanced: analysis.advanced.slice(0, 10),
        expert: analysis.expert.slice(0, 10),
      });
    } catch {
      return json(res, 500, {error: 'Audience analysis failed'});
    }
  }

  // ── Word count leaderboard ──
  if (req.method === 'GET' && pathname === '/api/stats/word-leaderboard') {
    try {
      const leaderboard = cached('word-leaderboard', 60000, () => {
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
              const wordCount = content.split(/\s+/).filter(Boolean).length;
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              pages.push({path: path.relative(PROJECT_ROOT, fp), title, wordCount});
            } catch {}
          }
        }
        scan(contentDir);
        pages.sort((a, b) => b.wordCount - a.wordCount);
        return pages;
      });
      return json(res, 200, {
        longest: leaderboard.slice(0, 20),
        shortest: leaderboard.slice(-10).reverse(),
        total: leaderboard.length,
        avgWordCount: Math.round(leaderboard.reduce((s, p) => s + p.wordCount, 0) / Math.max(leaderboard.length, 1)),
      });
    } catch {
      return json(res, 500, {error: 'Leaderboard failed'});
    }
  }

  // ── Reference deduplication detection ──
  if (req.method === 'GET' && pathname === '/api/references/duplicates') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const titleMap = {};
      for (const [key, entry] of Object.entries(refs)) {
        const normTitle = (entry.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        if (normTitle.length < 5) continue;
        if (!titleMap[normTitle]) titleMap[normTitle] = [];
        titleMap[normTitle].push({key, title: entry.title, year: entry.year, venue: entry.venue});
      }
      const duplicates = Object.values(titleMap).filter(g => g.length > 1).map(g => ({
        title: g[0].title,
        entries: g,
        count: g.length,
      })).sort((a, b) => b.count - a.count);
      return json(res, 200, {duplicates, totalDuplicateGroups: duplicates.length, totalDuplicateEntries: duplicates.reduce((s, d) => s + d.count, 0)});
    } catch {
      return json(res, 500, {error: 'Deduplication failed'});
    }
  }

  // ── Content coverage map ──
  if (req.method === 'GET' && pathname === '/api/content-coverage') {
    try {
      const coverage = cached('content-coverage', 120000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const venueTopics = {};
        for (const entry of Object.values(refs)) {
          const venue = entry.venue || 'Unknown';
          if (!venueTopics[venue]) venueTopics[venue] = {refCount: 0, cited: 0};
          venueTopics[venue].refCount++;
        }
        const CITE_RE = /\[@([\w-]+)/g;
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const c = fs.readFileSync(fp, 'utf-8');
              CITE_RE.lastIndex = 0;
              const cited = new Set();
              let m;
              while ((m = CITE_RE.exec(c)) !== null) cited.add(m[1]);
              for (const key of cited) {
                const ref = refs[key];
                if (ref) {
                  const venue = ref.venue || 'Unknown';
                  if (venueTopics[venue]) venueTopics[venue].cited++;
                }
              }
            } catch {}
          }
        }
        scan(contentDir);
        return Object.entries(venueTopics)
          .map(([venue, data]) => ({venue, references: data.refCount, cited: data.cited, coverage: data.refCount > 0 ? Math.round((data.cited / data.refCount) * 100) : 0}))
          .sort((a, b) => b.references - a.references)
          .slice(0, 30);
      });
      return json(res, 200, {coverage, total: coverage.length});
    } catch {
      return json(res, 500, {error: 'Coverage map failed'});
    }
  }

  // ── Total reading time estimation ──
  if (req.method === 'GET' && pathname === '/api/stats/reading-time') {
    try {
      const stats = cached('reading-time-stats', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const byDir = {};
        let totalWords = 0;
        function scan(dir, dirName) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp, dirName || entry.name); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const words = fs.readFileSync(fp, 'utf-8').split(/\s+/).filter(Boolean).length;
              totalWords += words;
              const dn = dirName || 'root';
              if (!byDir[dn]) byDir[dn] = 0;
              byDir[dn] += words;
            } catch {}
          }
        }
        scan(contentDir, null);
        return {totalWords, byDir};
      });
      const totalMinutes = Math.ceil(stats.totalWords / 200);
      const totalHours = Math.round(totalMinutes / 60 * 10) / 10;
      const directories = Object.entries(stats.byDir).map(([name, words]) => ({
        name, words, readingTimeMinutes: Math.ceil(words / 200), readingTimeHours: Math.round(words / 200 / 60 * 10) / 10,
      })).sort((a, b) => b.words - a.words);
      return json(res, 200, {totalWords: stats.totalWords, totalReadingMinutes: totalMinutes, totalReadingHours: totalHours, directories});
    } catch {
      return json(res, 500, {error: 'Reading time calculation failed'});
    }
  }

  // ── Personalized content recommendations ──
  if (req.method === 'GET' && pathname === '/api/content-recommend') {
    const userId = url.searchParams.get('userId') || 'default';
    try {
      const PROGRESS_FILE = path.join(PROJECT_ROOT, 'data', 'reading-progress.json');
      const progressData = loadJSON(PROGRESS_FILE);
      const readPages = new Set(Object.keys(progressData[userId] || {}));
      const bookmarks = loadJSON(BOOKMARKS_FILE);
      const bookmarkedPaths = new Set((bookmarks.bookmarks || []).map(b => b.path));
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const STOP = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not']);
      const interestWords = {};
      for (const pagePath of [...readPages, ...bookmarkedPaths]) {
        if (!isValidFilePath(pagePath)) continue;
        try {
          const content = fs.readFileSync(path.join(PROJECT_ROOT, pagePath), 'utf-8');
          const words = content.replace(/^---[\s\S]*?---/, '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4 && !STOP.has(w));
          for (const w of words) interestWords[w] = (interestWords[w] || 0) + 1;
        } catch {}
      }
      const topInterests = new Set(Object.entries(interestWords).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([w]) => w));
      const candidates = [];
      function scan(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scan(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          const rel = path.relative(PROJECT_ROOT, fp);
          if (readPages.has(rel)) continue;
          try {
            const content = fs.readFileSync(fp, 'utf-8');
            const words = content.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4);
            let score = 0;
            for (const w of words) { if (topInterests.has(w)) score++; }
            if (score > 3) {
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = content.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              candidates.push({path: rel, title, relevanceScore: score});
            }
          } catch {}
        }
      }
      scan(contentDir);
      candidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
      return json(res, 200, {recommendations: candidates.slice(0, 10), basedOn: {pagesRead: readPages.size, bookmarks: bookmarkedPaths.size}});
    } catch {
      return json(res, 500, {error: 'Recommendation failed'});
    }
  }

  // ── Reference field completeness ──
  if (req.method === 'GET' && pathname === '/api/references/completeness') {
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const FIELDS = ['title', 'author', 'year', 'venue', 'doi', 'url'];
      const results = [];
      let totalComplete = 0;
      for (const [key, entry] of Object.entries(refs)) {
        const missing = FIELDS.filter(f => !entry[f] || (Array.isArray(entry[f]) && entry[f].length === 0));
        const present = FIELDS.filter(f => entry[f] && (!Array.isArray(entry[f]) || entry[f].length > 0));
        const completeness = Math.round((present.length / FIELDS.length) * 100);
        if (completeness === 100) totalComplete++;
        results.push({key, title: entry.title || key, completeness, missing, presentCount: present.length});
      }
      results.sort((a, b) => a.completeness - b.completeness);
      const avgCompleteness = results.length > 0 ? Math.round(results.reduce((s, r) => s + r.completeness, 0) / results.length) : 0;
      return json(res, 200, {
        averageCompleteness: avgCompleteness,
        totalReferences: results.length,
        fullyComplete: totalComplete,
        incomplete: results.filter(r => r.completeness < 100).slice(0, 30),
        fieldCoverage: FIELDS.map(f => ({field: f, count: Object.values(refs).filter(e => e[f] && (!Array.isArray(e[f]) || e[f].length > 0)).length, percentage: Math.round(Object.values(refs).filter(e => e[f] && (!Array.isArray(e[f]) || e[f].length > 0)).length / Math.max(Object.keys(refs).length, 1) * 100)})),
      });
    } catch {
      return json(res, 500, {error: 'Completeness check failed'});
    }
  }

  // ── Content semantic similarity (TF-IDF-like) ──
  if (req.method === 'GET' && pathname === '/api/content-similar') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '5', 10), 20);
    try {
      const STOP = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not','can','all','each','some','more','most','other']);
      function getKeywords(text) {
        return text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/[^a-zA-Z\s]/g, ' ')
          .toLowerCase().split(/\s+/).filter(w => w.length > 4 && !STOP.has(w));
      }
      const sourceContent = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const sourceWords = getKeywords(sourceContent);
      const sourceFreq = {};
      for (const w of sourceWords) sourceFreq[w] = (sourceFreq[w] || 0) + 1;
      const sourceTopWords = new Set(Object.entries(sourceFreq).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([w]) => w));
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const candidates = [];
      function scan(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scan(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          const rel = path.relative(PROJECT_ROOT, fp);
          if (rel === filePath) continue;
          try {
            const c = fs.readFileSync(fp, 'utf-8');
            const words = getKeywords(c);
            const targetSet = new Set(words);
            let overlap = 0;
            for (const w of sourceTopWords) { if (targetSet.has(w)) overlap++; }
            if (overlap > 2) {
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              const fm = c.match(/^---\n([\s\S]*?)\n---/);
              if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
              candidates.push({path: rel, title, similarity: Math.round((overlap / sourceTopWords.size) * 100) / 100});
            }
          } catch {}
        }
      }
      scan(contentDir);
      candidates.sort((a, b) => b.similarity - a.similarity);
      return json(res, 200, {similar: candidates.slice(0, limit), total: candidates.length});
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Trending references (recent + highly cited) ──
  if (req.method === 'GET' && pathname === '/api/references/trending') {
    try {
      const trending = cached('ref-trending', 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const CITE_RE = /\[@([\w-]+)/g;
        const citeCounts = {};
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const c = fs.readFileSync(fp, 'utf-8');
              CITE_RE.lastIndex = 0;
              let m;
              while ((m = CITE_RE.exec(c)) !== null) citeCounts[m[1]] = (citeCounts[m[1]] || 0) + 1;
            } catch {}
          }
        }
        scan(contentDir);
        const currentYear = new Date().getFullYear();
        const recentPapers = [];
        for (const [key, entry] of Object.entries(refs)) {
          if (entry.year && entry.year >= currentYear - 2) {
            const citations = citeCounts[key] || 0;
            if (citations > 0) {
              recentPapers.push({key, title: entry.title, year: entry.year, venue: entry.venue, citations});
            }
          }
        }
        return recentPapers.sort((a, b) => b.citations - a.citations).slice(0, 20);
      });
      return json(res, 200, {trending, total: trending.length});
    } catch {
      return json(res, 500, {error: 'Trending analysis failed'});
    }
  }

  // ── Content complexity analysis ──
  if (req.method === 'GET' && pathname === '/api/file/complexity') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const words = content.split(/\s+/).filter(Boolean);
      const uniqueWords = new Set(words.map(w => w.toLowerCase())).size;
      const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 3);
      const avgSentenceLength = sentences.length > 0 ? Math.round(words.length / sentences.length * 10) / 10 : 0;
      const headings = (content.match(/^#{1,6}\s+/gm) || []).length;
      const maxHeadingDepth = Math.max(0, ...(content.match(/^#{1,6}/gm) || []).map(h => h.length));
      const codeBlocks = (content.match(/```/g) || []).length / 2;
      const mathBlocks = (content.match(/\$\$/g) || []).length / 2 + (content.match(/\\\[/g) || []).length;
      const citations = (content.match(/\[@/g) || []).length;
      const links = (content.match(/\[\[/g) || []).length + (content.match(/\]\(/g) || []).length;
      const lists = (content.match(/^[-*+]\s/gm) || []).length + (content.match(/^\d+\.\s/gm) || []).length;
      const vocabularyRichness = words.length > 0 ? Math.round((uniqueWords / words.length) * 100) / 100 : 0;
      const complexityScore = Math.min(100, Math.round(
        (avgSentenceLength > 20 ? 15 : avgSentenceLength * 0.75) +
        Math.min(20, headings * 3) +
        Math.min(15, codeBlocks * 5) +
        Math.min(15, mathBlocks * 5) +
        Math.min(10, citations * 2) +
        Math.min(10, links * 2) +
        (vocabularyRichness > 0.6 ? 15 : vocabularyRichness * 25)
      ));
      return json(res, 200, {
        path: filePath, complexityScore,
        metrics: {wordCount: words.length, uniqueWords, vocabularyRichness, avgSentenceLength, headings, maxHeadingDepth, codeBlocks: Math.floor(codeBlocks), mathBlocks: Math.floor(mathBlocks), citations, links, lists},
      });
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

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
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 200);
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
      const contentDir = path.join(PROJECT_ROOT, 'content');
      let totalFiles = 0, filesWithTitle = 0, filesWithTags = 0, totalHeadings = 0;
      let totalWords = 0;
      const WIKI_RE = /\[\[([^\]|]+)/g;
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
            WIKI_RE.lastIndex = 0;
            let m;
            while ((m = WIKI_RE.exec(content)) !== null) {
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
      return json(res, 200, {
        score: overallScore,
        level,
        breakdown: {titles: titleScore, tags: tagScore, headings: headingScore, wordCount: wordScore, linkHealth: linkHealthScore},
        stats: {totalFiles, filesWithTitle, filesWithTags, totalWords, totalLinks, brokenLinks},
      });
    } catch {
      return json(res, 500, {error: 'Health summary failed'});
    }
  }

  // ── Reference abstract/context summary ──
  if (req.method === 'GET' && pathname === '/api/references/abstracts') {
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query) return json(res, 400, {error: 'Missing query'});
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
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
      return json(res, 200, {results: matches, total: matches.length});
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
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const issues = [];
      const lines = content.split('\n');
      let lastHeadingLevel = 0;
      let inCode = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('```')) { inCode = !inCode; continue; }
        if (inCode) continue;
        const imgNoAlt = line.match(/!\[\]\(/);
        if (imgNoAlt) issues.push({line: i + 1, type: 'warning', message: 'Image without alt text'});
        const headingMatch = line.match(/^(#{1,6})\s+/);
        if (headingMatch) {
          const level = headingMatch[1].length;
          if (lastHeadingLevel > 0 && level > lastHeadingLevel + 1) {
            issues.push({line: i + 1, type: 'info', message: `Heading level skipped: h${lastHeadingLevel} to h${level}`});
          }
          lastHeadingLevel = level;
        }
      }
      const score = Math.max(0, 100 - issues.filter(i => i.type === 'warning').length * 10 - issues.filter(i => i.type === 'info').length * 3);
      return json(res, 200, {path: filePath, score, issues, issueCount: issues.length});
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── JSON-LD structured data ──
  if (req.method === 'GET' && pathname === '/api/file/jsonld') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const stat = fs.statSync(path.join(PROJECT_ROOT, filePath));
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let title = path.basename(filePath, path.extname(filePath));
      let date = stat.mtime.toISOString();
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
      const jsonld = {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: title,
        datePublished: date,
        dateModified: stat.mtime.toISOString(),
        wordCount,
        ...(description && {description}),
        ...(authors.length > 0 && {author: authors.map(a => ({'@type': 'Person', name: a}))}),
        ...(tags.length > 0 && {keywords: tags.join(', ')}),
      };
      return json(res, 200, jsonld);
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── XML Sitemap ──
  if (req.method === 'GET' && pathname === '/api/sitemap.xml') {
    try {
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const urls = [];
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
          urls.push({loc: urlPath, lastmod: stat.mtime.toISOString().slice(0, 10)});
        }
      }
      scanSitemap(contentDir);
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
      const thisWeek = recent.filter(r => r.timestamp && new Date(r.timestamp).getTime() > now - 7 * 86400000).length;
      const lastWeek = recent.filter(r => {
        if (!r.timestamp) return false;
        const t = new Date(r.timestamp).getTime();
        return t > now - 14 * 86400000 && t <= now - 7 * 86400000;
      }).length;
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
        if (!pageScores[b.path]) pageScores[b.path] = {views: 0, comments: 0, bookmarks: 0, readingLists: 0};
        pageScores[b.path].bookmarks++;
      }
      for (const list of (readingLists.lists || [])) {
        for (const item of (list.items || [])) {
          if (!pageScores[item.path]) pageScores[item.path] = {views: 0, comments: 0, bookmarks: 0, readingLists: 0};
          pageScores[item.path].readingLists++;
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
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
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
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const CITE_RE = /\[@([\w-]+)/g;
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
              CITE_RE.lastIndex = 0;
              while ((m = CITE_RE.exec(content)) !== null) citedKeys.add(m[1]);
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
      const avgScore = scores.length > 0 ? Math.round(scores.reduce((s, r) => s + r.score, 0) / scores.length * 10) / 10 : 0;
      const counts = {excellent: 0, good: 0, adequate: 0, needsImprovement: 0, minimal: 0};
      for (const r of scores) {
        if (r.score >= 80) counts.excellent++;
        else if (r.score >= 60) counts.good++;
        else if (r.score >= 40) counts.adequate++;
        else if (r.score >= 20) counts.needsImprovement++;
        else counts.minimal++;
      }
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
      return json(res, 200, {path: filePath, score, level, breakdown, wordCount});
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
      return json(res, 200, {directory: dir, files, words, drafts, avgWordsPerFile: files > 0 ? Math.round(words / files) : 0});
    } catch {
      return json(res, 404, {error: 'Directory not found'});
    }
  }

  // ── Paper recommendations by author preference ──
  if (req.method === 'GET' && pathname === '/api/references/recommend-by-author') {
    const authorName = url.searchParams.get('name');
    if (!authorName) return json(res, 400, {error: 'Missing name'});
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const nameLower = authorName.toLowerCase();
      const coauthors = new Set();
      const preferredVenues = new Set();
      for (const entry of Object.values(refs)) {
        if ((entry.author || []).some(a => a.toLowerCase().includes(nameLower))) {
          for (const a of (entry.author || [])) {
            if (!a.toLowerCase().includes(nameLower)) coauthors.add(a.toLowerCase());
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
      return json(res, 200, {author: authorName, recommendations: recommendations.slice(0, 15)});
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
      return json(res, 200, {
        path1, path2,
        lines1: lines1.length,
        lines2: lines2.length,
        changes: diff.length,
        diff: diff.slice(0, 200),
      });
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Venue statistics ──
  if (req.method === 'GET' && pathname === '/api/references/venue-stats') {
    const venue = url.searchParams.get('venue');
    if (!venue) return json(res, 400, {error: 'Missing venue'});
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
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
      return json(res, 200, {
        venue,
        paperCount: papers.length,
        authorCount: Object.keys(authorCounts).length,
        topAuthors,
        yearDistribution: years,
        papers: papers.sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 20),
      });
    } catch {
      return json(res, 500, {error: 'Venue stats failed'});
    }
  }

  // ── Author profile aggregation ──
  if (req.method === 'GET' && pathname === '/api/references/author-profile') {
    const name = url.searchParams.get('name');
    if (!name) return json(res, 400, {error: 'Missing name'});
    try {
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
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
      return json(res, 200, {
        name,
        paperCount: papers.length,
        papers,
        coauthors: [...coauthorSet].slice(0, 30),
        venues: [...venueSet],
        yearRange: papers.length > 0 ? {earliest: papers[papers.length - 1].year, latest: papers[0].year} : null,
      });
    } catch {
      return json(res, 500, {error: 'Profile aggregation failed'});
    }
  }

  // ── Content mentions: find all mentions of a page ──
  if (req.method === 'GET' && pathname === '/api/file/mentions') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
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
      return json(res, 200, {path: filePath, title, mentions, total: mentions.length});
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
      const FC_FILE = path.join(PROJECT_ROOT, 'data', 'flashcards.json');
      const data = loadJSON(FC_FILE);
      const uid = userId || 'default';
      if (!data[uid]) data[uid] = [];
      const card = {
        id: `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        front: sanitizeText(front),
        back: sanitizeText(back),
        tags: Array.isArray(tags) ? tags.slice(0, 10).map(t => sanitizeText(t)) : [],
        sourcePath: sourcePath || null,
        interval: 1,
        easeFactor: 2.5,
        repetitions: 0,
        nextReview: new Date().toISOString().slice(0, 10),
        createdAt: new Date().toISOString(),
      };
      data[uid].push(card);
      saveJSON(FC_FILE, data);
      return json(res, 200, {success: true, card});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/flashcards') {
    const userId = url.searchParams.get('userId') || 'default';
    const FC_FILE = path.join(PROJECT_ROOT, 'data', 'flashcards.json');
    const data = loadJSON(FC_FILE);
    const cards = data[userId] || [];
    return json(res, 200, {cards, total: cards.length});
  }

  if (req.method === 'GET' && pathname === '/api/flashcards/due') {
    const userId = url.searchParams.get('userId') || 'default';
    const today = new Date().toISOString().slice(0, 10);
    const FC_FILE = path.join(PROJECT_ROOT, 'data', 'flashcards.json');
    const data = loadJSON(FC_FILE);
    const cards = (data[userId] || []).filter(c => c.nextReview <= today);
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
      const FC_FILE = path.join(PROJECT_ROOT, 'data', 'flashcards.json');
      const data = loadJSON(FC_FILE);
      const card = (data[uid] || []).find(c => c.id === cardId);
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
      saveJSON(FC_FILE, data);
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
      const FC_FILE = path.join(PROJECT_ROOT, 'data', 'flashcards.json');
      const data = loadJSON(FC_FILE);
      if (!data[uid]) return json(res, 404, {error: 'Card not found'});
      const idx = data[uid].findIndex(c => c.id === cardId);
      if (idx === -1) return json(res, 404, {error: 'Card not found'});
      data[uid].splice(idx, 1);
      saveJSON(FC_FILE, data);
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
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      if (!refs[key]) return json(res, 404, {error: 'Reference not found'});
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
        const STOP = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not','can','all','each','some','more','most','other']);
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
                const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                if (tm) title = tm[1];
                const tgm = fmMatch[1].match(/^tags:\s*\[([^\]]*)\]/m);
                if (tgm) tgm[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(t => tags.push(t));
              }
              let text = content.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/[^a-zA-Z\s]/g, ' ');
              const keywords = text.toLowerCase().split(/\s+/).filter(w => w.length > 4 && !STOP.has(w));
              const freq = {};
              for (const w of keywords) freq[w] = (freq[w] || 0) + 1;
              const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w);
              pages.push({path: path.relative(PROJECT_ROOT, fp), title, tags, topWords});
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
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const WIKI_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      const existingLinks = new Set();
      let m;
      while ((m = WIKI_RE.exec(content)) !== null) existingLinks.add(m[1].trim().toLowerCase());
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
              const fm = c.match(/^---\n([\s\S]*?)\n---/);
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              if (fm) {
                const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                if (tm) title = tm[1];
              }
              suggestions.push({path: rel, title, pageName});
            } catch {}
          }
        }
      }
      scanLinks(contentDir);
      return json(res, 200, {suggestions: suggestions.slice(0, 15), total: suggestions.length});
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
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
      const paper1 = refs[key1];
      const paper2 = refs[key2];
      if (!paper1 || !paper2) return json(res, 404, {error: 'One or both references not found'});
      const authors1 = new Set((paper1.author || []).map(a => a.toLowerCase()));
      const authors2 = new Set((paper2.author || []).map(a => a.toLowerCase()));
      const sharedAuthors = [...authors1].filter(a => authors2.has(a));
      const sameVenue = paper1.venue && paper2.venue && paper1.venue === paper2.venue;
      const yearDiff = Math.abs((paper1.year || 0) - (paper2.year || 0));
      const words1 = new Set((paper1.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const words2 = (paper2.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const sharedTitleWords = words2.filter(w => words1.has(w));
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
    const GLOSSARY_FILE = path.join(PROJECT_ROOT, 'data', 'glossary.json');
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
      if (!definition || typeof definition !== 'string') return json(res, 400, {error: 'Missing or invalid definition'});
      const GLOSSARY_FILE = path.join(PROJECT_ROOT, 'data', 'glossary.json');
      const data = loadJSON(GLOSSARY_FILE);
      if (!data.terms) data.terms = [];
      if (data.terms.some(t => t.term.toLowerCase() === term.toLowerCase())) {
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
      const GLOSSARY_FILE = path.join(PROJECT_ROOT, 'data', 'glossary.json');
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
      const totalMinutes = items.reduce((s, item) => s + item.readingTimeMin, 0);
      const minutesPerWeek = hpw * 60;
      const weeks = [];
      let currentWeek = {week: 1, items: [], totalMinutes: 0};
      for (const item of items) {
        if (currentWeek.totalMinutes + item.readingTimeMin > minutesPerWeek && currentWeek.items.length > 0) {
          weeks.push(currentWeek);
          currentWeek = {week: weeks.length + 1, items: [], totalMinutes: 0};
        }
        currentWeek.items.push(item);
        currentWeek.totalMinutes += item.readingTimeMin;
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
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
              let title = name;
              if (fmMatch) {
                const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
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
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
        for (const [key, entry] of Object.entries(refs)) {
          if (key.toLowerCase().includes(query) || (entry.title || '').toLowerCase().includes(query)) {
            suggestions.push({type: 'reference', text: entry.title || key, key});
          }
          if (suggestions.length >= 15) break;
        }
      } catch {}
      return json(res, 200, {suggestions: suggestions.slice(0, 10)});
    } catch {
      return json(res, 200, {suggestions: []});
    }
  }

  // ── Quick notes / scratchpad ──
  if (req.method === 'GET' && pathname === '/api/quicknotes') {
    const userId = url.searchParams.get('userId') || 'default';
    const QUICKNOTES_FILE = path.join(PROJECT_ROOT, 'data', 'quicknotes.json');
    const data = loadJSON(QUICKNOTES_FILE);
    const notes = (data[userId] || []).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return json(res, 200, {notes, total: notes.length});
  }

  if (req.method === 'POST' && pathname === '/api/quicknotes') {
    if (!rateLimit(`quicknotes:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {userId, text, color} = body;
      if (!text || typeof text !== 'string') return json(res, 400, {error: 'Missing or invalid text'});
      const uid = userId || 'default';
      const QUICKNOTES_FILE = path.join(PROJECT_ROOT, 'data', 'quicknotes.json');
      const data = loadJSON(QUICKNOTES_FILE);
      if (!data[uid]) data[uid] = [];
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
      if (!data[uid]) return json(res, 404, {error: 'Note not found'});
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
      const PINS_FILE = path.join(PROJECT_ROOT, 'data', 'pins.json');
      const data = loadJSON(PINS_FILE);
      if (!data.pins) data.pins = [];
      if (data.pins.some(p => p.path === pagePath)) return json(res, 200, {success: true, message: 'Already pinned'});
      data.pins.push({path: pagePath, title: sanitizeText(title || pagePath), pinnedAt: new Date().toISOString()});
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
    return json(res, 200, {preferences: prefs[userId] || {}});
  }

  if (req.method === 'PUT' && pathname === '/api/preferences') {
    if (!rateLimit(`prefs:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {userId, preferences} = body;
      if (!userId || typeof userId !== 'string') return json(res, 400, {error: 'Missing or invalid userId'});
      if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return json(res, 400, {error: 'Missing or invalid preferences'});
      const PREFS_FILE = path.join(PROJECT_ROOT, 'data', 'preferences.json');
      const prefs = loadJSON(PREFS_FILE);
      prefs[userId] = {...(prefs[userId] || {}), ...preferences, updatedAt: new Date().toISOString()};
      saveJSON(PREFS_FILE, prefs);
      return json(res, 200, {success: true, preferences: prefs[userId]});
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
      if (!content || typeof content !== 'string') return json(res, 400, {error: 'Missing or invalid content'});
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
    const views = (analytics.counts || {})[pagePath] || 0;
    const comments = loadJSON(COMMENTS_FILE);
    const commentCount = (comments[pagePath] || []).length;
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
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
              const tgm = fmMatch[1].match(/^tags:\s*\[([^\]]*)\]/m);
              if (tgm) tgm[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
            }
          } catch {}
        }
      }
      scan(contentDir, null);
      let refCount = 0, citedCount = 0;
      try {
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
        refCount = Object.keys(refs).length;
      } catch {}
      const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
      const sections = Object.entries(byDir).sort((a, b) => b[1].words - a[1].words).map(([name, info]) => ({name, ...info}));
      return json(res, 200, {
        overview: {totalFiles, totalWords, references: refCount, avgWordsPerFile: totalFiles > 0 ? Math.round(totalWords / totalFiles) : 0},
        sections,
        topTags: topTags.map(([tag, count]) => ({tag, count})),
        generatedAt: new Date().toISOString(),
      });
    } catch {
      return json(res, 500, {error: 'Report generation failed'});
    }
  }

  // ── File versioning: manual named versions ──
  if (req.method === 'POST' && pathname === '/api/file/version') {
    if (!rateLimit(`file-version:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: filePath, label} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const VERSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'versions.json');
      const versions = loadJSON(VERSIONS_FILE);
      if (!versions[filePath]) versions[filePath] = [];
      const version = {
        id: `ver_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        label: sanitizeText(label || 'Untitled version'),
        content,
        createdAt: new Date().toISOString(),
        wordCount: content.split(/\s+/).filter(Boolean).length,
      };
      versions[filePath].push(version);
      if (versions[filePath].length > 50) versions[filePath] = versions[filePath].slice(-50);
      saveJSON(VERSIONS_FILE, versions);
      return json(res, 200, {success: true, version: {id: version.id, label: version.label, createdAt: version.createdAt, wordCount: version.wordCount}});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/file/versions') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    const VERSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'versions.json');
    const versions = loadJSON(VERSIONS_FILE);
    const fileVersions = (versions[filePath] || []).map(v => ({id: v.id, label: v.label, createdAt: v.createdAt, wordCount: v.wordCount}));
    return json(res, 200, {versions: fileVersions.reverse(), total: fileVersions.length});
  }

  if (req.method === 'GET' && pathname === '/api/file/version') {
    const filePath = url.searchParams.get('path');
    const versionId = url.searchParams.get('id');
    if (!isValidFilePath(filePath) || !versionId) return json(res, 400, {error: 'Invalid params'});
    const VERSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'versions.json');
    const versions = loadJSON(VERSIONS_FILE);
    const v = (versions[filePath] || []).find(v => v.id === versionId);
    if (!v) return json(res, 404, {error: 'Version not found'});
    return json(res, 200, {version: v});
  }

  // ── Global search across all data types ──
  if (req.method === 'GET' && pathname === '/api/search/global') {
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!query) return json(res, 400, {error: 'Missing query'});
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 100);
    try {
      const results = [];
      const contentDir = path.join(PROJECT_ROOT, 'content');
      function searchContent(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { searchContent(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          try {
            const content = fs.readFileSync(fp, 'utf-8');
            if (content.toLowerCase().includes(query)) {
              const relPath = path.relative(PROJECT_ROOT, fp);
              results.push({type: 'content', path: relPath, name: entry.name});
            }
          } catch {}
        }
      }
      searchContent(contentDir);
      const yaml = require('js-yaml');
      try {
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
        for (const [key, entry] of Object.entries(refs)) {
          const searchable = [key, entry.title || '', (entry.author || []).join(' ')].join(' ').toLowerCase();
          if (searchable.includes(query)) {
            results.push({type: 'reference', key, title: entry.title});
          }
        }
      } catch {}
      const comments = loadJSON(COMMENTS_FILE);
      for (const [page, pageComments] of Object.entries(comments)) {
        if (Array.isArray(pageComments)) {
          for (const c of pageComments) {
            if ((c.text || '').toLowerCase().includes(query)) {
              results.push({type: 'comment', page, text: c.text.slice(0, 100), author: c.author});
            }
          }
        }
      }
      const discData = loadJSON(DISCUSSIONS_FILE);
      for (const [channelId, msgs] of Object.entries(discData.messages || {})) {
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            if ((m.text || '').toLowerCase().includes(query)) {
              results.push({type: 'message', channel: channelId, text: m.text.slice(0, 100), author: m.author});
            }
          }
        }
      }
      return json(res, 200, {results: results.slice(0, limit), total: results.length, query});
    } catch {
      return json(res, 500, {error: 'Global search failed'});
    }
  }

  // ── File dependencies: outgoing + incoming links ──
  if (req.method === 'GET' && pathname === '/api/file/dependencies') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const WIKI_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;
      const MD_LINK_RE = /\[([^\]]*)\]\(\/([^)#?]+)\)/g;
      const outgoing = [];
      let m;
      while ((m = WIKI_RE.exec(content)) !== null) outgoing.push({type: 'wiki', target: m[1].trim()});
      while ((m = CITE_RE.exec(content)) !== null) {
        const keys = m[1].split(/\s*;\s*/).map(k => k.replace(/^@/, ''));
        for (const key of keys) outgoing.push({type: 'citation', target: key});
      }
      while ((m = MD_LINK_RE.exec(content)) !== null) outgoing.push({type: 'link', target: m[2].trim()});
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const baseName = path.basename(filePath, path.extname(filePath));
      const incoming = [];
      function scanIncoming(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scanIncoming(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          const rel = path.relative(PROJECT_ROOT, fp);
          if (rel === filePath) continue;
          try {
            const c = fs.readFileSync(fp, 'utf-8');
            WIKI_RE.lastIndex = 0;
            while ((m = WIKI_RE.exec(c)) !== null) {
              if (m[1].trim() === baseName || m[1].trim().endsWith('/' + baseName)) {
                incoming.push({type: 'wiki', source: rel});
                break;
              }
            }
          } catch {}
        }
      }
      scanIncoming(contentDir);
      return json(res, 200, {
        path: filePath,
        outgoing,
        incoming,
        outgoingCount: outgoing.length,
        incomingCount: incoming.length,
      });
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── File summary: extract brief summary ──
  if (req.method === 'GET' && pathname === '/api/file/summary') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      let body = content;
      const fmMatch = body.match(/^---\n([\s\S]*?)\n---\n?/);
      let title = path.basename(filePath, path.extname(filePath));
      if (fmMatch) {
        const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
        if (tm) title = tm[1];
        body = body.slice(fmMatch[0].length);
      }
      body = body.replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '').replace(/import\s+.*$/gm, '');
      const paragraphs = body.split(/\n\n+/).map(p => p.replace(/^#+\s*/gm, '').trim()).filter(p => p.length > 20 && !p.startsWith('import'));
      const summary = paragraphs.slice(0, 2).join(' ').slice(0, 300);
      const headings = [];
      for (const line of content.split('\n')) {
        const m = line.match(/^(#{1,3})\s+(.+)$/);
        if (m) headings.push(m[2].trim());
      }
      const wordCount = content.split(/\s+/).filter(Boolean).length;
      return json(res, 200, {title, summary, headings: headings.slice(0, 10), wordCount, readingTime: Math.ceil(wordCount / 200)});
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Batch file info ──
  if (req.method === 'POST' && pathname === '/api/files/info') {
    if (!rateLimit(`files-info:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {paths} = body;
      if (!Array.isArray(paths)) return json(res, 400, {error: 'paths must be an array'});
      const results = [];
      for (const filePath of paths.slice(0, 50)) {
        if (!isValidFilePath(filePath)) { results.push({path: filePath, error: 'Invalid path'}); continue; }
        try {
          const fullPath = path.join(PROJECT_ROOT, filePath);
          const stat = fs.statSync(fullPath);
          const content = fs.readFileSync(fullPath, 'utf-8');
          const wordCount = content.split(/\s+/).filter(Boolean).length;
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          let title = path.basename(filePath, path.extname(filePath));
          let draft = false;
          if (fmMatch) {
            const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
            if (tm) title = tm[1];
            if (/^draft:\s*true/m.test(fmMatch[1])) draft = true;
          }
          results.push({path: filePath, title, size: stat.size, wordCount, draft, mtime: stat.mtime.toISOString()});
        } catch {
          results.push({path: filePath, error: 'File not found'});
        }
      }
      return json(res, 200, {results, count: results.length});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── File outline: heading structure ──
  if (req.method === 'GET' && pathname === '/api/file/outline') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const headings = [];
      const lines = content.split('\n');
      let inCode = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('```')) { inCode = !inCode; continue; }
        if (inCode) continue;
        const match = line.match(/^(#{1,6})\s+(.+)$/);
        if (match) {
          headings.push({level: match[1].length, text: match[2].trim(), line: i + 1});
        }
      }
      return json(res, 200, {headings, count: headings.length});
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Suggest tags for a file based on content ──
  if (req.method === 'GET' && pathname === '/api/file/suggest-tags') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      let text = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/[^a-zA-Z\s-]/g, ' ');
      const STOP = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not','can','all','each','some','more','most','other','very','just','than','too','own','same']);
      const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
      const freq = {};
      for (const w of words) freq[w] = (freq[w] || 0) + 1;
      const existingTags = cached('all-tags-set', 30000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const tagSet = new Set();
        function scan(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(fp); continue; }
            if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                const c = fs.readFileSync(fp, 'utf-8');
                const fm = c.match(/^---\n([\s\S]*?)\n---/);
                if (fm) {
                  const tgm = fm[1].match(/^tags:\s*\[([^\]]*)\]/m);
                  if (tgm) tgm[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(t => tagSet.add(t));
                }
              } catch {}
            }
          }
        }
        scan(contentDir);
        return tagSet;
      });
      const suggestions = [];
      for (const tag of existingTags) {
        const tagLower = tag.toLowerCase();
        if (freq[tagLower] && freq[tagLower] >= 2) {
          suggestions.push({tag, confidence: Math.min(freq[tagLower] / 5, 1)});
        }
        const hyphenated = tagLower.replace(/-/g, ' ').split(' ');
        if (hyphenated.length > 1 && hyphenated.every(w => freq[w] && freq[w] >= 1)) {
          suggestions.push({tag, confidence: 0.7});
        }
      }
      const topKeywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([word]) => word);
      const uniqueSuggestions = [...new Map(suggestions.map(s => [s.tag, s])).values()]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 10);
      return json(res, 200, {suggestions: uniqueSuggestions, topKeywords});
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── File markdown lint ──
  if (req.method === 'GET' && pathname === '/api/file/lint') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const issues = [];
      const lines = content.split('\n');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) {
        issues.push({line: 1, severity: 'warning', message: 'Missing frontmatter'});
      } else {
        if (!/^title:/m.test(fmMatch[1])) {
          issues.push({line: 1, severity: 'warning', message: 'Missing title in frontmatter'});
        }
      }
      let inCodeBlock = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
        if (inCodeBlock) continue;
        if (line.length > 500) {
          issues.push({line: i + 1, severity: 'info', message: `Very long line (${line.length} chars)`});
        }
        if (/^#{1,6}\s*$/.test(line)) {
          issues.push({line: i + 1, severity: 'warning', message: 'Empty heading'});
        }
        const openBrackets = (line.match(/\[/g) || []).length;
        const closeBrackets = (line.match(/\]/g) || []).length;
        if (openBrackets !== closeBrackets && !line.includes('[[') && !line.includes(']]')) {
          issues.push({line: i + 1, severity: 'info', message: 'Potentially unclosed brackets'});
        }
        if (/^\s+#/.test(line) && !/^\s+#.*code/i.test(line)) {
          issues.push({line: i + 1, severity: 'info', message: 'Heading has leading whitespace'});
        }
      }
      if (inCodeBlock) {
        issues.push({line: lines.length, severity: 'error', message: 'Unclosed code block'});
      }
      return json(res, 200, {issues, issueCount: issues.length});
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── File readability score ──
  if (req.method === 'GET' && pathname === '/api/file/readability') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      let text = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      text = text.replace(/^---[\s\S]*?---/, '');
      text = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
      text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
      text = text.replace(/#{1,6}\s*/g, '').replace(/<[^>]+>/g, '');
      text = text.replace(/[*_~>|\\[\]]/g, '');
      const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 3);
      const words = text.split(/\s+/).filter(w => w.length > 0);
      const syllableCount = words.reduce((sum, w) => {
        const clean = w.toLowerCase().replace(/[^a-z]/g, '');
        if (!clean) return sum;
        let syllables = clean.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
        return sum + Math.max(1, syllables ? syllables.length : 1);
      }, 0);
      const wordCount = words.length;
      const sentenceCount = Math.max(sentences.length, 1);
      const avgWordsPerSentence = Math.round((wordCount / sentenceCount) * 10) / 10;
      const avgSyllablesPerWord = Math.round((syllableCount / Math.max(wordCount, 1)) * 10) / 10;
      const fleschKincaid = Math.round((0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59) * 10) / 10;
      const readingTimeMin = Math.ceil(wordCount / 200);
      let level = 'Advanced';
      if (fleschKincaid <= 6) level = 'Easy';
      else if (fleschKincaid <= 10) level = 'Intermediate';
      else if (fleschKincaid <= 14) level = 'Advanced';
      else level = 'Expert';
      return json(res, 200, {
        wordCount, sentenceCount, avgWordsPerSentence, avgSyllablesPerWord,
        fleschKincaidGrade: fleschKincaid, readingLevel: level,
        readingTimeMinutes: readingTimeMin,
      });
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Related pages: suggest pages related to a given file ──
  if (req.method === 'GET' && pathname === '/api/file/related') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      const fullPath = path.join(PROJECT_ROOT, filePath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      const sourceTags = new Set();
      if (fmMatch) {
        const tagsMatch = fmMatch[1].match(/^tags:\s*\[([^\]]*)\]/m);
        if (tagsMatch) {
          tagsMatch[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(t => sourceTags.add(t));
        }
      }
      const STOP = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','and','but','or','for','in','on','at','to','by','of','with','from','this','that','it','not']);
      let plainText = content.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/[^a-zA-Z\s]/g, ' ');
      const sourceWords = new Set(plainText.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)));
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const candidates = [];
      function scanRelated(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { scanRelated(fp); continue; }
          if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
          const rel = path.relative(PROJECT_ROOT, fp);
          if (rel === filePath) continue;
          try {
            const c = fs.readFileSync(fp, 'utf-8');
            const fm = c.match(/^---\n([\s\S]*?)\n---/);
            let title = entry.name.replace(/\.(mdx?|md)$/, '');
            const tags = new Set();
            if (fm) {
              const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
              if (tm) title = tm[1];
              const tgm = fm[1].match(/^tags:\s*\[([^\]]*)\]/m);
              if (tgm) tgm[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(t => tags.add(t));
            }
            let score = 0;
            for (const t of tags) { if (sourceTags.has(t)) score += 5; }
            let pt = c.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/[^a-zA-Z\s]/g, ' ');
            const ws = pt.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
            let shared = 0;
            for (const w of ws) { if (sourceWords.has(w)) shared++; }
            score += Math.min(shared / Math.max(ws.length, 1) * 10, 5);
            if (score > 0.5) candidates.push({path: rel, title, score: Math.round(score * 100) / 100});
          } catch {}
        }
      }
      scanRelated(contentDir);
      candidates.sort((a, b) => b.score - a.score);
      return json(res, 200, {related: candidates.slice(0, 10)});
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── File keywords: extract top keywords from a file ──
  if (req.method === 'GET' && pathname === '/api/file/keywords') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      let text = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
      text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/#{1,6}\s*/g, '');
      text = text.replace(/[*_~`>|\\[\]()-]/g, ' ').replace(/<[^>]+>/g, '');
      const STOP = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','shall','can','and','but','or','nor','for','yet','so','in','on','at','to','by','of','with','from','up','about','into','through','during','before','after','above','below','between','out','off','over','under','again','further','then','once','here','there','when','where','why','how','all','each','every','both','few','more','most','other','some','such','no','not','only','own','same','than','too','very','just','because','as','until','while','this','that','these','those','it','its','he','she','they','them','their','we','our','you','your','i','me','my','what','which','who','whom','if']);
      const freq = {};
      const words = text.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2 && !STOP.has(w));
      for (const w of words) freq[w] = (freq[w] || 0) + 1;
      const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word, count]) => ({word, count}));
      return json(res, 200, {keywords, totalWords: words.length});
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  // ── Word-level diff between current content and a git version ──
  if (req.method === 'GET' && pathname === '/api/file/word-diff') {
    const filePath = url.searchParams.get('path');
    const hash = url.searchParams.get('hash');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    if (!hash || !/^[a-f0-9]{4,40}$/i.test(hash)) return json(res, 400, {error: 'Invalid hash'});
    try {
      const diff = execFileSync('git', [
        'diff', '--word-diff=plain', `${hash}..HEAD`, '--', filePath,
      ], {cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000});
      const added = (diff.match(/\{\+/g) || []).length;
      const removed = (diff.match(/\[-/g) || []).length;
      return json(res, 200, {diff, wordsAdded: added, wordsRemoved: removed});
    } catch {
      return json(res, 200, {diff: '', wordsAdded: 0, wordsRemoved: 0});
    }
  }

  // ── File compare: get content at two commits ──
  if (req.method === 'GET' && pathname === '/api/file/compare') {
    const filePath = url.searchParams.get('path');
    const hash1 = url.searchParams.get('hash1');
    const hash2 = url.searchParams.get('hash2');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    if (!hash1 || !/^[a-f0-9]{4,40}$/i.test(hash1)) return json(res, 400, {error: 'Invalid hash1'});
    if (!hash2 || (hash2 !== 'current' && !/^[a-f0-9]{4,40}$/i.test(hash2))) {
      return json(res, 400, {error: 'Invalid hash2'});
    }
    try {
      const content1 = execFileSync('git', ['show', `${hash1}:${filePath}`], {
        cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000,
      });
      const date1 = execFileSync('git', ['log', '-1', '--format=%ai', hash1], {
        cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000,
      }).trim();

      let content2, date2, resolvedHash2;
      if (hash2 === 'current') {
        const fullPath = path.join(PROJECT_ROOT, filePath);
        if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'File not found'});
        content2 = fs.readFileSync(fullPath, 'utf-8');
        date2 = new Date().toISOString();
        resolvedHash2 = 'current';
      } else {
        content2 = execFileSync('git', ['show', `${hash2}:${filePath}`], {
          cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000,
        });
        date2 = execFileSync('git', ['log', '-1', '--format=%ai', hash2], {
          cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000,
        }).trim();
        resolvedHash2 = hash2;
      }

      return json(res, 200, {
        version1: {hash: hash1, content: content1, date: date1},
        version2: {hash: resolvedHash2, content: content2, date: date2},
      });
    } catch {
      return json(res, 500, {error: 'Failed to retrieve file versions'});
    }
  }

  // ── Comments: add reaction ──
  if (req.method === 'POST' && pathname === '/api/comments/react') {
    if (!rateLimit(`react:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {page, commentId, emoji, userId} = body;
      if (!page || !commentId || !emoji || !userId) return json(res, 400, {error: 'Missing page, commentId, emoji, or userId'});
      const validEmojis = ['thumbsup', 'heart', 'laugh', 'thinking', 'celebrate'];
      if (!validEmojis.includes(emoji)) return json(res, 400, {error: `Invalid emoji. Must be one of: ${validEmojis.join(', ')}`});
      const comments = loadJSON(COMMENTS_FILE);
      if (!comments[page]) return json(res, 404, {error: 'Page not found'});
      const comment = comments[page].find(c => c.id === commentId);
      if (!comment) return json(res, 404, {error: 'Comment not found'});
      if (!comment.reactions) comment.reactions = [];
      const existing = comment.reactions.find(r => r.emoji === emoji && r.userId === userId);
      if (existing) return json(res, 200, {success: true, reactions: comment.reactions});
      comment.reactions.push({emoji, userId});
      saveJSON(COMMENTS_FILE, comments);
      return json(res, 200, {success: true, reactions: comment.reactions});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Comments: remove reaction ──
  if (req.method === 'DELETE' && pathname === '/api/comments/react') {
    try {
      const body = await readBody(req);
      const {page, commentId, emoji, userId} = body;
      if (!page || !commentId || !emoji || !userId) return json(res, 400, {error: 'Missing page, commentId, emoji, or userId'});
      const comments = loadJSON(COMMENTS_FILE);
      if (!comments[page]) return json(res, 404, {error: 'Page not found'});
      const comment = comments[page].find(c => c.id === commentId);
      if (!comment) return json(res, 404, {error: 'Comment not found'});
      if (!comment.reactions) comment.reactions = [];
      const idx = comment.reactions.findIndex(r => r.emoji === emoji && r.userId === userId);
      if (idx === -1) return json(res, 200, {success: true, reactions: comment.reactions});
      comment.reactions.splice(idx, 1);
      saveJSON(COMMENTS_FILE, comments);
      return json(res, 200, {success: true, reactions: comment.reactions});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Bookmarks: list all ──
  if (req.method === 'GET' && pathname === '/api/bookmarks') {
    const data = loadJSON(BOOKMARKS_FILE);
    return json(res, 200, {bookmarks: data.bookmarks || []});
  }

  // ── Bookmarks: add ──
  if (req.method === 'POST' && pathname === '/api/bookmarks') {
    if (!rateLimit(`bookmarks:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: pagePath, title} = body;
      if (!pagePath || typeof pagePath !== 'string') return json(res, 400, {error: 'Missing path'});
      const data = loadJSON(BOOKMARKS_FILE);
      if (!data.bookmarks) data.bookmarks = [];
      if (data.bookmarks.some(b => b.path === pagePath)) {
        return json(res, 200, {success: true, bookmarks: data.bookmarks});
      }
      const bookmark = {
        path: pagePath,
        title: sanitizeText(title) || pagePath,
        addedAt: new Date().toISOString(),
      };
      data.bookmarks.push(bookmark);
      saveJSON(BOOKMARKS_FILE, data);
      return json(res, 200, {success: true, bookmark});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Bookmarks: remove ──
  if (req.method === 'DELETE' && pathname === '/api/bookmarks') {
    try {
      const body = await readBody(req);
      const {path: pagePath} = body;
      if (!pagePath || typeof pagePath !== 'string') return json(res, 400, {error: 'Missing path'});
      const data = loadJSON(BOOKMARKS_FILE);
      if (!data.bookmarks) data.bookmarks = [];
      const idx = data.bookmarks.findIndex(b => b.path === pagePath);
      if (idx === -1) return json(res, 404, {error: 'Bookmark not found'});
      data.bookmarks.splice(idx, 1);
      saveJSON(BOOKMARKS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Discussions: pin a message ──
  if (req.method === 'POST' && pathname.match(/^\/api\/discussions\/[^/]+\/pin$/)) {
    if (!rateLimit(`disc-pin:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      const channelId = decodeURIComponent(parts[3]);
      const data = loadJSON(DISCUSSIONS_FILE);
      if (!data.channels || !data.channels[channelId]) {
        return json(res, 404, {error: 'Channel not found'});
      }
      const body = await readBody(req);
      const {messageId} = body;
      if (!messageId) return json(res, 400, {error: 'Missing messageId'});
      // Verify the message exists in this channel
      const channelMessages = (data.messages || {})[channelId] || [];
      if (!channelMessages.find(m => m.id === messageId)) {
        return json(res, 404, {error: 'Message not found in this channel'});
      }
      if (!data.channels[channelId].pinnedMessages) {
        data.channels[channelId].pinnedMessages = [];
      }
      if (data.channels[channelId].pinnedMessages.includes(messageId)) {
        return json(res, 200, {success: true, already: true});
      }
      data.channels[channelId].pinnedMessages.push(messageId);
      saveJSON(DISCUSSIONS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Discussions: unpin a message ──
  if (req.method === 'DELETE' && pathname.match(/^\/api\/discussions\/[^/]+\/pin$/)) {
    try {
      const parts = pathname.split('/');
      const channelId = decodeURIComponent(parts[3]);
      const data = loadJSON(DISCUSSIONS_FILE);
      if (!data.channels || !data.channels[channelId]) {
        return json(res, 404, {error: 'Channel not found'});
      }
      const body = await readBody(req);
      const {messageId} = body;
      if (!messageId) return json(res, 400, {error: 'Missing messageId'});
      const pinned = data.channels[channelId].pinnedMessages || [];
      const idx = pinned.indexOf(messageId);
      if (idx === -1) return json(res, 404, {error: 'Message is not pinned'});
      pinned.splice(idx, 1);
      data.channels[channelId].pinnedMessages = pinned;
      saveJSON(DISCUSSIONS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Analytics: content topics/keywords ──
  if (req.method === 'GET' && pathname === '/api/analytics/topics') {
    const STOP_WORDS = new Set([
      'the','a','an','is','are','was','were','be','been','being','have','has','had',
      'do','does','did','will','would','could','should','may','might','shall','can',
      'and','but','or','nor','for','yet','so','in','on','at','to','by','of','with',
      'from','up','about','into','through','during','before','after','above','below',
      'between','out','off','over','under','again','further','then','once','here',
      'there','when','where','why','how','all','each','every','both','few','more',
      'most','other','some','such','no','not','only','own','same','than','too','very',
      'just','because','as','until','while','this','that','these','those','it','its',
      'he','she','they','them','their','we','our','you','your','i','me','my','what',
      'which','who','whom','if',
    ]);

    const topics = cached('analytics:topics', 60000, () => {
      const contentDir = path.join(PROJECT_ROOT, 'content');
      const freq = {};

      function scanMarkdown(dir) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanMarkdown(full);
          } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
            try {
              let text = fs.readFileSync(full, 'utf8');
              // Strip frontmatter
              text = text.replace(/^---[\s\S]*?---/, '');
              // Strip markdown syntax (links, images, code blocks, inline code, headings, bold/italic, html tags)
              text = text.replace(/```[\s\S]*?```/g, '');
              text = text.replace(/`[^`]*`/g, '');
              text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
              text = text.replace(/#{1,6}\s*/g, '');
              text = text.replace(/[*_~`>|\\[\]()-]/g, ' ');
              text = text.replace(/<[^>]+>/g, '');
              // Split into words, lowercase, filter
              const words = text.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
              for (const w of words) {
                freq[w] = (freq[w] || 0) + 1;
              }
            } catch { /* skip unreadable files */ }
          }
        }
      }

      scanMarkdown(contentDir);

      return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([word, count]) => ({word, count}));
    });

    return json(res, 200, {topics});
  }

  // ── Reading Lists: list all ──
  if (req.method === 'GET' && pathname === '/api/reading-lists') {
    const data = loadJSON(READING_LISTS_FILE);
    return json(res, 200, {lists: data.lists || []});
  }

  // ── Reading Lists: create ──
  if (req.method === 'POST' && pathname === '/api/reading-lists') {
    if (!rateLimit(`reading-lists:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {name, description} = body;
      if (!name || typeof name !== 'string' || !name.trim()) return json(res, 400, {error: 'Missing name'});
      const data = loadJSON(READING_LISTS_FILE);
      if (!data.lists) data.lists = [];
      const list = {
        id: crypto.randomUUID(),
        name: sanitizeText(name.trim()),
        description: sanitizeText((description || '').trim()),
        items: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      data.lists.push(list);
      saveJSON(READING_LISTS_FILE, data);
      return json(res, 200, {success: true, list});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Reading Lists: delete a list ──
  if (req.method === 'DELETE' && pathname.match(/^\/api\/reading-lists\/[^/]+$/) && !pathname.includes('/items')) {
    try {
      const parts = pathname.split('/');
      const listId = decodeURIComponent(parts[3]);
      const data = loadJSON(READING_LISTS_FILE);
      if (!data.lists) data.lists = [];
      const idx = data.lists.findIndex(l => l.id === listId);
      if (idx === -1) return json(res, 404, {error: 'Reading list not found'});
      data.lists.splice(idx, 1);
      saveJSON(READING_LISTS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Reading Lists: add item ──
  if (req.method === 'POST' && pathname.match(/^\/api\/reading-lists\/[^/]+\/items$/)) {
    if (!rateLimit(`rl-items:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      const listId = decodeURIComponent(parts[3]);
      const body = await readBody(req);
      const {path: itemPath, title, type} = body;
      if (!itemPath || typeof itemPath !== 'string') return json(res, 400, {error: 'Missing path'});
      const itemType = (type === 'reference' || type === 'doc') ? type : 'doc';
      const data = loadJSON(READING_LISTS_FILE);
      if (!data.lists) data.lists = [];
      const list = data.lists.find(l => l.id === listId);
      if (!list) return json(res, 404, {error: 'Reading list not found'});
      if (list.items.some(item => item.path === itemPath)) {
        return json(res, 200, {success: true, message: 'Item already in list'});
      }
      list.items.push({
        path: itemPath,
        title: sanitizeText(title) || itemPath,
        type: itemType,
        addedAt: new Date().toISOString(),
      });
      list.updatedAt = new Date().toISOString();
      saveJSON(READING_LISTS_FILE, data);
      return json(res, 200, {success: true, list});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Reading Lists: remove item ──
  if (req.method === 'DELETE' && pathname.match(/^\/api\/reading-lists\/[^/]+\/items$/)) {
    try {
      const parts = pathname.split('/');
      const listId = decodeURIComponent(parts[3]);
      const body = await readBody(req);
      const {path: itemPath} = body;
      if (!itemPath || typeof itemPath !== 'string') return json(res, 400, {error: 'Missing path'});
      const data = loadJSON(READING_LISTS_FILE);
      if (!data.lists) data.lists = [];
      const list = data.lists.find(l => l.id === listId);
      if (!list) return json(res, 404, {error: 'Reading list not found'});
      const idx = list.items.findIndex(item => item.path === itemPath);
      if (idx === -1) return json(res, 404, {error: 'Item not found in list'});
      list.items.splice(idx, 1);
      list.updatedAt = new Date().toISOString();
      saveJSON(READING_LISTS_FILE, data);
      return json(res, 200, {success: true, list});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Reading Lists: stats ──
  if (req.method === 'GET' && pathname === '/api/reading-lists/stats') {
    const data = loadJSON(READING_LISTS_FILE);
    const lists = data.lists || [];
    let totalItems = 0, docItems = 0, refItems = 0;
    const itemCounts = {};
    for (const list of lists) {
      const items = list.items || [];
      totalItems += items.length;
      for (const item of items) {
        if (item.type === 'reference') refItems++;
        else docItems++;
        itemCounts[item.path] = (itemCounts[item.path] || 0) + 1;
      }
    }
    const popular = Object.entries(itemCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, count]) => ({path, count}));
    return json(res, 200, {
      totalLists: lists.length,
      totalItems,
      docItems,
      referenceItems: refItems,
      popularItems: popular,
    });
  }

  // ── Reading Lists: reorder items ──
  if (req.method === 'PATCH' && pathname.match(/^\/api\/reading-lists\/[^/]+\/items$/)) {
    try {
      const parts = pathname.split('/');
      const listId = decodeURIComponent(parts[3]);
      const body = await readBody(req);
      const {path: itemPath, direction} = body;
      if (!itemPath || typeof itemPath !== 'string') return json(res, 400, {error: 'Missing path'});
      if (direction !== 'up' && direction !== 'down') return json(res, 400, {error: 'direction must be "up" or "down"'});
      const data = loadJSON(READING_LISTS_FILE);
      if (!data.lists) data.lists = [];
      const list = data.lists.find(l => l.id === listId);
      if (!list) return json(res, 404, {error: 'Reading list not found'});
      const idx = list.items.findIndex(item => item.path === itemPath);
      if (idx === -1) return json(res, 404, {error: 'Item not found in list'});
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= list.items.length) {
        return json(res, 200, {success: true, list}); // already at boundary
      }
      [list.items[idx], list.items[swapIdx]] = [list.items[swapIdx], list.items[idx]];
      list.updatedAt = new Date().toISOString();
      saveJSON(READING_LISTS_FILE, data);
      return json(res, 200, {success: true, list});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Reading Lists: export as markdown ──
  if (req.method === 'GET' && pathname.match(/^\/api\/reading-lists\/[^/]+\/export$/)) {
    try {
      const parts = pathname.split('/');
      const listId = decodeURIComponent(parts[3]);
      const data = loadJSON(READING_LISTS_FILE);
      if (!data.lists) data.lists = [];
      const list = data.lists.find(l => l.id === listId);
      if (!list) return json(res, 404, {error: 'Reading list not found'});
      const format = url.searchParams.get('format') || 'md';
      const safeName = list.name.replace(/[^a-zA-Z0-9_-]/g, '_');

      if (format === 'bibtex') {
        const yaml = require('js-yaml');
        const bibPath = path.join(PROJECT_ROOT, 'references.yaml');
        let refs = {};
        try { refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {}; } catch {}
        const refItems = (list.items || []).filter(item => item.type === 'reference');
        const lines = [];
        for (const item of refItems) {
          const key = item.path;
          const entry = refs[key];
          if (!entry) continue;
          const authors = (entry.author || []).join(' and ');
          const bibtexType = entry.type || 'misc';
          const fields = [];
          fields.push(`  title = {${entry.title || ''}}`);
          if (authors) fields.push(`  author = {${authors}}`);
          if (entry.year) fields.push(`  year = {${entry.year}}`);
          if (entry.venue) fields.push(`  journal = {${entry.venue}}`);
          if (entry.url) fields.push(`  url = {${entry.url}}`);
          if (entry.doi) fields.push(`  doi = {${entry.doi}}`);
          lines.push(`@${bibtexType}{${key},\n${fields.join(',\n')}\n}`);
        }
        const bibtex = lines.join('\n\n') + '\n';
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${safeName}.bib"`,
          'Access-Control-Allow-Origin': CORS_ORIGIN,
        });
        return res.end(bibtex);
      }

      let md = `# ${list.name}\n\n`;
      if (list.description) md += `${list.description}\n\n`;
      if (list.items && list.items.length > 0) {
        list.items.forEach((item, i) => {
          const prefix = item.type === 'reference' ? '[Paper]' : '[Doc]';
          md += `${i + 1}. ${prefix} ${item.title || item.path}\n`;
        });
      } else {
        md += '_No items in this list._\n';
      }
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}.md"`,
        'Access-Control-Allow-Origin': CORS_ORIGIN,
      });
      return res.end(md);
    } catch {
      return json(res, 500, {error: 'Export failed'});
    }
  }

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
    for (const entry of sorted) {
      totalWords += entry.words;
      if (entry.words >= 50) {
        tempStreak++;
        if (tempStreak > longestStreak) longestStreak = tempStreak;
      } else {
        tempStreak = 0;
      }
    }
    // Current streak: count consecutive days ending at today (or yesterday)
    currentStreak = 0;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    for (let i = sorted.length - 1; i >= 0; i--) {
      const entry = sorted[i];
      if (i === sorted.length - 1 && entry.date !== today && entry.date !== yesterday) break;
      if (entry.words < 50) break;
      // Check consecutive: each entry should be one day before the next
      if (i < sorted.length - 1) {
        const prevDate = new Date(sorted[i + 1].date);
        const curDate = new Date(entry.date);
        const diffDays = (prevDate - curDate) / 86400000;
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
      const userId = body.userId || 'default';
      const wordsWritten = typeof body.wordsWritten === 'number' ? body.wordsWritten : 0;
      if (wordsWritten < 0) return json(res, 400, {error: 'wordsWritten must be non-negative'});
      const today = new Date().toISOString().slice(0, 10);
      const data = loadJSON(STREAKS_FILE);
      if (!data[userId]) data[userId] = {dailyLog: []};
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

      return json(res, 200, {success: true, processed, errors});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Recently modified files ──
  if (req.method === 'GET' && pathname === '/api/files/recent') {
    try {
      const limit = parseInt(url.searchParams.get('limit') || '10', 10);
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
            if (url.searchParams.get('includeStats') === 'true') {
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
      return json(res, 200, {files: files.slice(0, Math.min(limit, 50))});
    } catch {
      return json(res, 500, {error: 'Failed to list recent files'});
    }
  }

  // ── Annotations ─────────────────────────────────────────────────────────

  if (req.method === 'GET' && pathname === '/api/annotations') {
    const page = url.searchParams.get('page');
    if (!page) return json(res, 400, {error: 'Missing page parameter'});
    const annotations = loadJSON(ANNOTATIONS_FILE);
    return json(res, 200, {annotations: annotations[page] || []});
  }

  if (req.method === 'POST' && pathname === '/api/annotations') {
    if (!rateLimit(`annotations:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {page, text, note, startOffset, endOffset, author} = body;
      if (!page || !text || startOffset == null || endOffset == null) {
        return json(res, 400, {error: 'Missing required fields: page, text, startOffset, endOffset'});
      }
      const annotations = loadJSON(ANNOTATIONS_FILE);
      if (!annotations[page]) annotations[page] = [];
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
      if (!annotations[page]) return json(res, 404, {error: 'Page not found'});
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
          for (let j = i + 1; j < fingerprints.length; j++) {
            const a = fingerprints[i].words;
            const b = fingerprints[j].words;
            let intersection = 0;
            for (const w of a) {
              if (b.has(w)) intersection++;
            }
            const union = a.size + b.size - intersection;
            const similarity = union === 0 ? 0 : intersection / union;
            if (similarity > 0.5) {
              pairs.push({
                file1: fingerprints[i].path,
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

      const issues = [];
      const lines = content.split('\n');

      // 1. Missing title in frontmatter
      if (content.startsWith('---')) {
        const fmEnd = content.indexOf('---', 3);
        if (fmEnd !== -1) {
          const frontmatter = content.slice(3, fmEnd);
          if (!/^title\s*:/m.test(frontmatter)) {
            issues.push({line: 1, column: 1, message: 'Frontmatter is missing a title field', severity: 'warning'});
          }
        }
      }

      // 2. Duplicate headings
      const headingSeen = new Map();
      for (let i = 0; i < lines.length; i++) {
        const hMatch = lines[i].match(/^(#{1,6})\s+(.+)$/);
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
        const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        let m;
        while ((m = imgRegex.exec(lines[i])) !== null) {
          const imgPath = m[2].trim();
          if (!/^https?:\/\//.test(imgPath) && !imgPath.startsWith('/')) {
            issues.push({line: i + 1, column: m.index + 1, message: `Possibly broken image reference: "${imgPath}" (relative path, should start with / or http)`, severity: 'warning'});
          }
        }
      }

      // 4. Unclosed code blocks (odd number of triple backticks)
      let codeBlockCount = 0;
      let codeBlockOpenLine = 0;
      for (let i = 0; i < lines.length; i++) {
        if (/^```/.test(lines[i].trim())) {
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
        if (/^```/.test(lines[i].trim())) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (inCodeBlock) continue;
        if (lines[i].length > 200) {
          // Skip lines that are mostly a URL
          if (/^\s*https?:\/\/\S+\s*$/.test(lines[i])) continue;
          if (/^\s*\[.*\]\(https?:\/\/\S+\)\s*$/.test(lines[i])) continue;
          issues.push({line: i + 1, column: 201, message: `Line is ${lines[i].length} characters long (exceeds 200 char limit)`, severity: 'warning'});
        }
      }

      // 6. Empty sections (heading with no content before next heading)
      for (let i = 0; i < lines.length; i++) {
        if (/^#{1,6}\s+/.test(lines[i])) {
          let hasContent = false;
          for (let j = i + 1; j < lines.length; j++) {
            if (/^#{1,6}\s+/.test(lines[j])) break;
            if (lines[j].trim().length > 0) { hasContent = true; break; }
          }
          if (!hasContent) {
            issues.push({line: i + 1, column: 1, message: 'Empty section — heading has no content before next heading or end of file', severity: 'warning'});
          }
        }
      }

      // 7. Missing alt text in images
      for (let i = 0; i < lines.length; i++) {
        const altRegex = /!\[\s*\]\([^)]+\)/g;
        let m;
        while ((m = altRegex.exec(lines[i])) !== null) {
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
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
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
      const yaml = require('js-yaml');
      const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
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
      return json(res, 200, {timeline, totalYears: timeline.length});
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

  // ── Dashboard overview: single endpoint for all key metrics ──
  if (req.method === 'GET' && pathname === '/api/dashboard') {
    try {
      const yaml = require('js-yaml');
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
      let refCount = 0;
      try { refCount = Object.keys(yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {}).length; } catch {}
      const comments = loadJSON(COMMENTS_FILE);
      let totalComments = 0;
      for (const page of Object.values(comments)) { if (Array.isArray(page)) totalComments += page.length; }
      const discData = loadJSON(DISCUSSIONS_FILE);
      const channelCount = Object.keys(discData.channels || {}).length;
      let messageCount = 0;
      for (const msgs of Object.values(discData.messages || {})) { if (Array.isArray(msgs)) messageCount += msgs.length; }
      const streakData = loadJSON(STREAKS_FILE);
      const defaultLog = (streakData['default'] && streakData['default'].dailyLog) || [];
      const today = new Date().toISOString().slice(0, 10);
      const todayEntry = defaultLog.find(e => e.date === today);
      const analytics = loadJSON(ANALYTICS_FILE);
      const totalPageviews = Object.values(analytics.counts || {}).reduce((s, c) => s + c, 0);
      return json(res, 200, {
        content: {files: totalFiles, words: totalWords, references: refCount},
        social: {comments: totalComments, channels: channelCount, messages: messageCount},
        streak: {wordsToday: todayEntry ? todayEntry.words : 0, totalEntries: defaultLog.length},
        traffic: {totalPageviews},
        serverUptime: Math.round(process.uptime()),
        generatedAt: new Date().toISOString(),
      });
    } catch {
      return json(res, 500, {error: 'Dashboard failed'});
    }
  }

  // ── Reading progress tracking ──
  if (req.method === 'POST' && pathname === '/api/reading-progress') {
    if (!rateLimit(`reading-progress:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {userId, pagePath, progress} = body;
      if (!userId || typeof userId !== 'string') return json(res, 400, {error: 'Missing or invalid userId'});
      if (!pagePath || typeof pagePath !== 'string') return json(res, 400, {error: 'Missing or invalid pagePath'});
      const PROGRESS_FILE = path.join(PROJECT_ROOT, 'data', 'reading-progress.json');
      const data = loadJSON(PROGRESS_FILE);
      if (!data[userId]) data[userId] = {};
      data[userId][pagePath] = {
        progress: Math.min(100, Math.max(0, typeof progress === 'number' ? progress : 0)),
        lastRead: new Date().toISOString(),
      };
      saveJSON(PROGRESS_FILE, data);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/reading-progress') {
    const userId = url.searchParams.get('userId');
    if (!userId) return json(res, 400, {error: 'Missing userId'});
    const PROGRESS_FILE = path.join(PROJECT_ROOT, 'data', 'reading-progress.json');
    const data = loadJSON(PROGRESS_FILE);
    const userProgress = data[userId] || {};
    const pages = Object.entries(userProgress).map(([pagePath, info]) => ({
      pagePath, ...info,
    })).sort((a, b) => (b.lastRead || '').localeCompare(a.lastRead || ''));
    const totalRead = pages.filter(p => p.progress >= 100).length;
    const inProgress = pages.filter(p => p.progress > 0 && p.progress < 100).length;
    return json(res, 200, {pages, totalRead, inProgress, totalTracked: pages.length});
  }

  // ── Content changelog ──
  if (req.method === 'GET' && pathname === '/api/changelog') {
    try {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const events = [];
      const comments = loadJSON(COMMENTS_FILE);
      for (const [page, pageComments] of Object.entries(comments)) {
        if (Array.isArray(pageComments)) {
          for (const c of pageComments) {
            events.push({type: 'comment', page, author: c.author, text: c.text?.slice(0, 100), timestamp: c.createdAt});
          }
        }
      }
      const discData = loadJSON(DISCUSSIONS_FILE);
      for (const [channelId, msgs] of Object.entries(discData.messages || {})) {
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            events.push({type: 'message', channel: channelId, author: m.author, text: m.text?.slice(0, 100), timestamp: m.createdAt});
          }
        }
      }
      events.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      return json(res, 200, {events: events.slice(0, limit), total: events.length});
    } catch {
      return json(res, 500, {error: 'Changelog failed'});
    }
  }

  // ── Reference impact scoring ──
  if (req.method === 'GET' && pathname === '/api/references/impact') {
    try {
      const impact = cached('ref-impact', 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;
        const citeCounts = {};
        function scanCites(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanCites(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              CITE_RE.lastIndex = 0;
              let m;
              while ((m = CITE_RE.exec(content)) !== null) {
                const keys = m[1].split(/\s*;\s*/).map(k => k.replace(/^@/, ''));
                for (const key of keys) {
                  citeCounts[key] = (citeCounts[key] || 0) + 1;
                }
              }
            } catch {}
          }
        }
        scanCites(contentDir);
        const TOP_VENUES = new Set(['NeurIPS','ICML','ICLR','CVPR','ACL','EMNLP','AAAI','Nature','Science']);
        const scores = [];
        for (const [key, entry] of Object.entries(refs)) {
          const citations = citeCounts[key] || 0;
          const venueBonus = TOP_VENUES.has(entry.venue) ? 2 : 0;
          const recencyBonus = entry.year >= 2022 ? 1 : entry.year >= 2020 ? 0.5 : 0;
          const score = Math.round((citations * 3 + venueBonus + recencyBonus) * 10) / 10;
          scores.push({key, title: entry.title, year: entry.year, venue: entry.venue, citations, score});
        }
        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, 50);
      });
      return json(res, 200, {references: impact, total: impact.length});
    } catch {
      return json(res, 500, {error: 'Impact scoring failed'});
    }
  }

  // ── Shared annotations feed ──
  if (req.method === 'GET' && pathname === '/api/annotations/shared') {
    try {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const annotations = loadJSON(ANNOTATIONS_FILE);
      const all = [];
      for (const [page, pageAnnotations] of Object.entries(annotations)) {
        if (Array.isArray(pageAnnotations)) {
          for (const ann of pageAnnotations) {
            all.push({...ann, page});
          }
        }
      }
      all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return json(res, 200, {annotations: all.slice(0, limit), total: all.length});
    } catch {
      return json(res, 500, {error: 'Failed to load shared annotations'});
    }
  }

  // ── Co-author network ──
  if (req.method === 'GET' && pathname === '/api/references/co-authors') {
    try {
      const network = cached('co-author-network', 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
        const coauthorCounts = {};
        for (const entry of Object.values(refs)) {
          const authors = entry.author || [];
          for (let i = 0; i < authors.length; i++) {
            for (let j = i + 1; j < authors.length; j++) {
              const pair = [authors[i], authors[j]].sort().join('::');
              coauthorCounts[pair] = (coauthorCounts[pair] || 0) + 1;
            }
          }
        }
        const edges = Object.entries(coauthorCounts)
          .filter(([, count]) => count >= 2)
          .map(([pair, count]) => {
            const [a, b] = pair.split('::');
            return {author1: a, author2: b, papers: count};
          })
          .sort((a, b) => b.papers - a.papers)
          .slice(0, 50);
        const authorSet = new Set();
        for (const edge of edges) { authorSet.add(edge.author1); authorSet.add(edge.author2); }
        return {edges, authors: [...authorSet], totalPairs: Object.keys(coauthorCounts).length};
      });
      return json(res, 200, network);
    } catch {
      return json(res, 500, {error: 'Co-author network failed'});
    }
  }

  // ── Content freshness scoring ──
  if (req.method === 'GET' && pathname === '/api/content-freshness') {
    try {
      const freshness = cached('content-freshness', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const now = Date.now();
        const files = [];
        function scanFreshness(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanFreshness(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const stat = fs.statSync(fp);
              const ageMs = now - stat.mtimeMs;
              const ageDays = Math.floor(ageMs / 86400000);
              const content = fs.readFileSync(fp, 'utf-8');
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              if (fmMatch) {
                const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                if (tm) title = tm[1];
              }
              const wordCount = content.split(/\s+/).filter(Boolean).length;
              files.push({
                path: path.relative(PROJECT_ROOT, fp),
                title, ageDays, wordCount,
                lastModified: stat.mtime.toISOString(),
                freshness: ageDays <= 7 ? 'fresh' : ageDays <= 30 ? 'recent' : ageDays <= 90 ? 'aging' : 'stale',
              });
            } catch {}
          }
        }
        scanFreshness(contentDir);
        files.sort((a, b) => b.ageDays - a.ageDays);
        const counts = {fresh: 0, recent: 0, aging: 0, stale: 0};
        for (const f of files) counts[f.freshness]++;
        return {files: files.slice(0, 50), counts, totalFiles: files.length};
      });
      return json(res, 200, freshness);
    } catch {
      return json(res, 500, {error: 'Freshness scoring failed'});
    }
  }

  // ── Content duplicate detection ──
  if (req.method === 'GET' && pathname === '/api/content-duplicates') {
    try {
      const duplicates = cached('content-duplicates', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const files = [];
        function collectFiles(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              collectFiles(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                let title = entry.name.replace(/\.(mdx?|md)$/, '');
                if (fmMatch) {
                  const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                  if (titleMatch) title = titleMatch[1];
                }
                files.push({
                  path: path.relative(PROJECT_ROOT, fullPath),
                  title,
                  titleLower: title.toLowerCase().trim(),
                });
              } catch {}
            }
          }
        }
        collectFiles(contentDir);
        const groups = {};
        for (const f of files) {
          if (!groups[f.titleLower]) groups[f.titleLower] = [];
          groups[f.titleLower].push(f);
        }
        return Object.values(groups)
          .filter(g => g.length > 1)
          .map(g => ({title: g[0].title, files: g.map(f => f.path)}));
      });
      return json(res, 200, {duplicates, count: duplicates.length});
    } catch {
      return json(res, 500, {error: 'Duplicate detection failed'});
    }
  }

  // ── Content stats timeline ──
  if (req.method === 'GET' && pathname === '/api/stats/timeline') {
    try {
      const timeline = cached('stats:timeline', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
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

  // ── Content health check ──
  if (req.method === 'GET' && pathname === '/api/content-health') {
    try {
      const health = cached('content-health', 60000, () => {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        const pages = new Map();
        const allLinks = [];
        let draftCount = 0;

        function scanHealth(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              scanHealth(fullPath);
            } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
              const relPath = path.relative(path.join(PROJECT_ROOT, 'content'), fullPath);
              let id = relPath.replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
              if (id.endsWith('/index')) id = id.slice(0, -6);
              const content = fs.readFileSync(fullPath, 'utf-8');
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
              let title = entry.name.replace(/\.(mdx?|md)$/, '');
              if (fmMatch) {
                const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
                if (titleMatch) title = titleMatch[1];
                if (/^draft:\s*true/m.test(fmMatch[1])) draftCount++;
              }
              pages.set(id, {title, path: relPath});
              WIKI_LINK_RE.lastIndex = 0;
              let m;
              while ((m = WIKI_LINK_RE.exec(content)) !== null) {
                allLinks.push({source: id, target: m[1].trim(), type: 'wiki'});
              }
              const MD_LINK_RE = /\[([^\]]*)\]\(\/([^)#?]+)\)/g;
              while ((m = MD_LINK_RE.exec(content)) !== null) {
                allLinks.push({source: id, target: m[2].trim(), type: 'markdown'});
              }
            }
          }
        }
        scanHealth(contentDir);

        const pageIds = new Set(pages.keys());
        const brokenLinks = [];
        const incomingLinks = new Map();
        for (const link of allLinks) {
          const target = link.target;
          const found = pageIds.has(target) || [...pageIds].some(id => id.endsWith(target) || id.endsWith('/' + target));
          if (!found) {
            brokenLinks.push({source: link.source, target, type: link.type || 'wiki'});
          } else {
            const resolvedTarget = pageIds.has(target) ? target : [...pageIds].find(id => id.endsWith(target) || id.endsWith('/' + target));
            if (resolvedTarget) {
              incomingLinks.set(resolvedTarget, (incomingLinks.get(resolvedTarget) || 0) + 1);
            }
          }
        }

        const orphanPages = [];
        for (const [id, info] of pages) {
          if (!incomingLinks.has(id) && !id.includes('index')) {
            orphanPages.push({id, title: info.title});
          }
        }

        return {
          totalPages: pages.size,
          draftCount,
          brokenLinks: brokenLinks.slice(0, 50),
          brokenLinkCount: brokenLinks.length,
          orphanPages: orphanPages.slice(0, 30),
          orphanPageCount: orphanPages.length,
          totalLinks: allLinks.length,
        };
      });
      return json(res, 200, health);
    } catch {
      return json(res, 500, {error: 'Content health check failed'});
    }
  }

  // ── Scheduled publishing ──
  if (pathname === '/api/schedule') {
    if (req.method === 'POST') {
      if (!rateLimit(`schedule:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const body = await readBody(req);
        const {path: filePath, publishAt} = body;
        if (!filePath || !publishAt) return json(res, 400, {error: 'Missing path or publishAt'});
        if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
        const fullPath = path.join(PROJECT_ROOT, filePath);
        if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'File not found'});
        const publishDate = new Date(publishAt);
        if (isNaN(publishDate.getTime())) return json(res, 400, {error: 'Invalid publishAt date'});
        const schedules = Array.isArray(loadJSON(SCHEDULES_FILE)) ? loadJSON(SCHEDULES_FILE) : [];
        const existing = schedules.findIndex(s => s.path === filePath);
        if (existing !== -1) schedules.splice(existing, 1);
        schedules.push({path: filePath, publishAt: publishDate.toISOString(), createdAt: new Date().toISOString()});
        saveJSON(SCHEDULES_FILE, schedules);
        return json(res, 200, {success: true, schedule: schedules[schedules.length - 1]});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }
    if (req.method === 'GET') {
      const schedules = Array.isArray(loadJSON(SCHEDULES_FILE)) ? loadJSON(SCHEDULES_FILE) : [];
      return json(res, 200, {schedules});
    }
    if (req.method === 'DELETE') {
      try {
        const body = await readBody(req);
        const {path: filePath} = body;
        if (!filePath) return json(res, 400, {error: 'Missing path'});
        const schedules = Array.isArray(loadJSON(SCHEDULES_FILE)) ? loadJSON(SCHEDULES_FILE) : [];
        const idx = schedules.findIndex(s => s.path === filePath);
        if (idx === -1) return json(res, 404, {error: 'Schedule not found'});
        schedules.splice(idx, 1);
        saveJSON(SCHEDULES_FILE, schedules);
        return json(res, 200, {success: true});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }
  }

  // ── Create snapshot ──
  if (req.method === 'POST' && pathname === '/api/snapshots') {
    if (!rateLimit(`snapshots:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: filePath, name} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      if (!name || typeof name !== 'string') return json(res, 400, {error: 'Name is required'});
      const fullPath = path.join(PROJECT_ROOT, filePath);
      if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'File not found'});
      const content = fs.readFileSync(fullPath, 'utf-8');
      const snapshots = loadJSON(SNAPSHOTS_FILE);
      if (!snapshots[filePath]) snapshots[filePath] = [];
      const snapshot = {
        id: crypto.randomUUID(),
        name: sanitizeText(name).slice(0, 200),
        content,
        createdAt: new Date().toISOString(),
      };
      snapshots[filePath].push(snapshot);
      if (snapshots[filePath].length > 10) {
        snapshots[filePath] = snapshots[filePath].slice(-10);
      }
      saveJSON(SNAPSHOTS_FILE, snapshots);
      return json(res, 200, {success: true, snapshot: {id: snapshot.id, name: snapshot.name, createdAt: snapshot.createdAt}});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── List snapshots for a file ──
  if (req.method === 'GET' && pathname === '/api/snapshots') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    const snapshots = loadJSON(SNAPSHOTS_FILE);
    const fileSnapshots = (snapshots[filePath] || []).map(s => ({id: s.id, name: s.name, createdAt: s.createdAt}));
    return json(res, 200, {snapshots: fileSnapshots});
  }

  // ── Restore file from snapshot ──
  if (req.method === 'POST' && pathname === '/api/snapshots/restore') {
    if (!rateLimit(`snapshots-restore:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: filePath, snapshotId} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      if (!snapshotId || typeof snapshotId !== 'string') return json(res, 400, {error: 'snapshotId is required'});
      const fullPath = path.join(PROJECT_ROOT, filePath);
      if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'File not found'});
      const snapshots = loadJSON(SNAPSHOTS_FILE);
      const fileSnapshots = snapshots[filePath] || [];
      const snapshot = fileSnapshots.find(s => s.id === snapshotId);
      if (!snapshot) return json(res, 404, {error: 'Snapshot not found'});
      fs.writeFileSync(fullPath, snapshot.content, 'utf-8');
      invalidateCache('search');
      return json(res, 200, {success: true, restored: {id: snapshot.id, name: snapshot.name}});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Delete snapshot ──
  if (req.method === 'DELETE' && pathname === '/api/snapshots') {
    if (!rateLimit(`snapshots-delete:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: filePath, snapshotId} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      if (!snapshotId || typeof snapshotId !== 'string') return json(res, 400, {error: 'snapshotId is required'});
      const snapshots = loadJSON(SNAPSHOTS_FILE);
      if (!snapshots[filePath]) return json(res, 404, {error: 'No snapshots for this file'});
      const idx = snapshots[filePath].findIndex(s => s.id === snapshotId);
      if (idx === -1) return json(res, 404, {error: 'Snapshot not found'});
      snapshots[filePath].splice(idx, 1);
      if (snapshots[filePath].length === 0) delete snapshots[filePath];
      saveJSON(SNAPSHOTS_FILE, snapshots);
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Whiteboard ──
  if (pathname === '/api/whiteboard') {
    if (req.method === 'POST') {
      if (!rateLimit(`whiteboard:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const body = await readBody(req);
        const {id, elements} = body;
        if (!id || typeof id !== 'string') return json(res, 400, {error: 'Missing id'});
        if (!Array.isArray(elements)) return json(res, 400, {error: 'elements must be an array'});
        const safeId = sanitizeText(id).slice(0, 200);
        const safeElements = elements.slice(0, 500).map(el => ({
          type: sanitizeText(String(el.type || 'note')).slice(0, 50),
          x: typeof el.x === 'number' ? el.x : 0,
          y: typeof el.y === 'number' ? el.y : 0,
          w: typeof el.w === 'number' ? el.w : 160,
          h: typeof el.h === 'number' ? el.h : 100,
          text: sanitizeText(String(el.text || '')).slice(0, 1000),
          color: /^#[0-9a-fA-F]{3,8}$/.test(el.color) ? el.color : '#fef3c7',
        }));
        const whiteboards = loadJSON(WHITEBOARDS_FILE);
        whiteboards[safeId] = {id: safeId, elements: safeElements, updatedAt: new Date().toISOString()};
        saveJSON(WHITEBOARDS_FILE, whiteboards);
        return json(res, 200, {success: true, whiteboard: whiteboards[safeId]});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }
    if (req.method === 'GET') {
      const id = url.searchParams.get('id');
      const whiteboards = loadJSON(WHITEBOARDS_FILE);
      if (id) {
        const wb = whiteboards[id];
        if (!wb) return json(res, 404, {error: 'Whiteboard not found'});
        return json(res, 200, {whiteboard: wb});
      }
      return json(res, 400, {error: 'Missing id parameter. Use GET /api/whiteboards to list all.'});
    }
    if (req.method === 'DELETE') {
      if (!rateLimit(`whiteboard-del:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, {error: 'Missing id parameter'});
      const whiteboards = loadJSON(WHITEBOARDS_FILE);
      if (!whiteboards[id]) return json(res, 404, {error: 'Whiteboard not found'});
      delete whiteboards[id];
      saveJSON(WHITEBOARDS_FILE, whiteboards);
      return json(res, 200, {success: true});
    }
  }

  if (req.method === 'GET' && pathname === '/api/whiteboards') {
    const whiteboards = loadJSON(WHITEBOARDS_FILE);
    const list = Object.values(whiteboards).map(wb => ({id: wb.id, elementCount: (wb.elements || []).length, updatedAt: wb.updatedAt}));
    return json(res, 200, {whiteboards: list});
  }

  // ── Flashcards: get cards due for review (SM-2) ──
  // Uses per-user keyed structure consistent with other flashcard endpoints
  if (req.method === 'GET' && pathname === '/api/flashcards/review') {
    const userId = url.searchParams.get('userId') || 'default';
    const today = new Date().toISOString().slice(0, 10);
    const data = loadJSON(FLASHCARDS_FILE);
    const cards = (data[userId] || []).filter(c => c.nextReview <= today);
    cards.sort((a, b) => (a.nextReview || '').localeCompare(b.nextReview || ''));
    return json(res, 200, {cards, count: cards.length});
  }

  // ── Mindmap from headings ──
  if (req.method === 'GET' && pathname === '/api/file/mindmap') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    const fullPath = path.join(PROJECT_ROOT, filePath);
    let md;
    try {
      md = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
    // Strip frontmatter
    md = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
    // Parse headings
    const headings = [];
    for (const line of md.split('\n')) {
      const m = line.match(/^(#{1,4})\s+(.+)/);
      if (m) headings.push({level: m[1].length, text: m[2].replace(/[*_`\[\]]/g, '').trim()});
    }
    // Build tree
    const title = filePath.replace(/^.*\//, '').replace(/\.(md|mdx)$/, '');
    const root = {text: title, children: []};
    const stack = [{node: root, level: 0}];
    for (const h of headings) {
      const child = {text: h.text, children: []};
      while (stack.length > 1 && stack[stack.length - 1].level >= h.level) stack.pop();
      stack[stack.length - 1].node.children.push(child);
      stack.push({node: child, level: h.level});
    }
    return json(res, 200, {root});
  }

  // ── Tasks (Kanban) ──
  if (pathname === '/api/tasks') {
    if (req.method === 'POST') {
      if (!rateLimit(`tasks:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const body = await readBody(req);
        const {title, description, status, priority} = body;
        if (!title || typeof title !== 'string' || !title.trim()) return json(res, 400, {error: 'Missing title'});
        const validStatuses = ['todo', 'doing', 'done'];
        const safeStatus = validStatuses.includes(status) ? status : 'todo';
        const validPriorities = ['low', 'medium', 'high'];
        const safePriority = validPriorities.includes(priority) ? priority : 'medium';
        const data = loadJSON(TASKS_FILE);
        if (!data.tasks) data.tasks = [];
        const task = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          title: sanitizeText(title.trim()).slice(0, 200),
          description: description ? sanitizeText(String(description).trim()).slice(0, 2000) : '',
          status: safeStatus,
          priority: safePriority,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        data.tasks.push(task);
        saveJSON(TASKS_FILE, data);
        return json(res, 201, {success: true, task});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }
    if (req.method === 'GET') {
      const data = loadJSON(TASKS_FILE);
      const tasks = data.tasks || [];
      const grouped = {
        todo: tasks.filter(t => t.status === 'todo'),
        doing: tasks.filter(t => t.status === 'doing'),
        done: tasks.filter(t => t.status === 'done'),
      };
      return json(res, 200, {tasks, grouped, counts: {todo: grouped.todo.length, doing: grouped.doing.length, done: grouped.done.length}});
    }
    if (req.method === 'PUT') {
      if (!rateLimit(`tasks:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const body = await readBody(req);
        const {id, status, title, description, priority} = body;
        if (!id || typeof id !== 'string') return json(res, 400, {error: 'Missing id'});
        const data = loadJSON(TASKS_FILE);
        if (!data.tasks) data.tasks = [];
        const task = data.tasks.find(t => t.id === id);
        if (!task) return json(res, 404, {error: 'Task not found'});
        const validStatuses = ['todo', 'doing', 'done'];
        const validPriorities = ['low', 'medium', 'high'];
        if (status !== undefined && validStatuses.includes(status)) task.status = status;
        if (title !== undefined && typeof title === 'string' && title.trim()) task.title = sanitizeText(title.trim()).slice(0, 200);
        if (description !== undefined) task.description = sanitizeText(String(description).trim()).slice(0, 2000);
        if (priority !== undefined && validPriorities.includes(priority)) task.priority = priority;
        task.updatedAt = new Date().toISOString();
        saveJSON(TASKS_FILE, data);
        return json(res, 200, {success: true, task});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }
    if (req.method === 'DELETE') {
      if (!rateLimit(`tasks-del:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
      try {
        const body = await readBody(req);
        const {id} = body;
        if (!id || typeof id !== 'string') return json(res, 400, {error: 'Missing id'});
        const data = loadJSON(TASKS_FILE);
        if (!data.tasks) data.tasks = [];
        const idx = data.tasks.findIndex(t => t.id === id);
        if (idx === -1) return json(res, 404, {error: 'Task not found'});
        data.tasks.splice(idx, 1);
        saveJSON(TASKS_FILE, data);
        return json(res, 200, {success: true});
      } catch {
        return json(res, 400, {error: 'Invalid request'});
      }
    }
  }

  // ── Writing goals ──
  if (req.method === 'POST' && pathname === '/api/goals') {
    if (!rateLimit(`goals:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {type, target, userId} = body;
      if (!type || !['daily', 'weekly'].includes(type)) return json(res, 400, {error: 'type must be "daily" or "weekly"'});
      if (typeof target !== 'number' || target <= 0) return json(res, 400, {error: 'target must be a positive number'});
      const uid = userId || 'default';
      // Compute baseline words from content stats
      const contentDir = path.join(PROJECT_ROOT, 'content');
      let baselineWords = 0;
      function countWordsForGoal(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.')) continue;
          if (entry.isDirectory()) countWordsForGoal(path.join(dir, entry.name));
          else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
            baselineWords += fs.readFileSync(path.join(dir, entry.name), 'utf-8').split(/\s+/).filter(Boolean).length;
          }
        }
      }
      try { countWordsForGoal(contentDir); } catch {}
      const now = new Date().toISOString();
      const goal = {
        id: 'goal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        type, target, userId: uid,
        startDate: now.slice(0, 10),
        baselineWords,
        createdAt: now,
      };
      const data = loadJSON(GOALS_FILE);
      if (!Array.isArray(data.goals)) data.goals = [];
      // Replace existing goal of same type+userId
      data.goals = data.goals.filter(g => !(g.type === type && g.userId === uid));
      data.goals.push(goal);
      saveJSON(GOALS_FILE, data);
      return json(res, 201, goal);
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/goals') {
    const uid = url.searchParams.get('userId') || 'default';
    const data = loadJSON(GOALS_FILE);
    const goals = Array.isArray(data.goals) ? data.goals.filter(g => g.userId === uid) : [];
    // Compute current total words
    const contentDir = path.join(PROJECT_ROOT, 'content');
    let currentWords = 0;
    function countWordsForGoalGet(dir) {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) countWordsForGoalGet(path.join(dir, entry.name));
        else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
          currentWords += fs.readFileSync(path.join(dir, entry.name), 'utf-8').split(/\s+/).filter(Boolean).length;
        }
      }
    }
    try { countWordsForGoalGet(contentDir); } catch {}
    const today = new Date().toISOString().slice(0, 10);
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const weekStartStr = weekStart.toISOString().slice(0, 10);
    const result = goals.map(g => {
      const wordsWritten = Math.max(0, currentWords - g.baselineWords);
      const isExpired = g.type === 'daily' ? g.startDate < today : g.startDate < weekStartStr;
      const progress = Math.min(1, wordsWritten / g.target);
      return {...g, currentWords, wordsWritten, progress: Math.round(progress * 100) / 100, isExpired};
    });
    return json(res, 200, {goals: result});
  }

  if (req.method === 'PUT' && pathname === '/api/goals') {
    if (!rateLimit(`goals-update:${req.socket.remoteAddress}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {id, target} = body;
      if (!id || typeof id !== 'string') return json(res, 400, {error: 'Missing or invalid id'});
      const data = loadJSON(GOALS_FILE);
      if (!Array.isArray(data.goals)) return json(res, 404, {error: 'No goals found'});
      const goal = data.goals.find(g => g.id === id);
      if (!goal) return json(res, 404, {error: 'Goal not found'});
      if (typeof target === 'number' && target > 0) goal.target = target;
      saveJSON(GOALS_FILE, data);
      return json(res, 200, goal);
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Citation graph (nodes + edges for visualization) ──
  if (req.method === 'GET' && pathname === '/api/references/citation-graph') {
    try {
      const graph = cached('citation-graph-viz', 60000, () => {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
        const contentDir = path.join(PROJECT_ROOT, 'content');
        const CITE_RE = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;

        // Track which refs appear on each page
        const pageCiteSets = [];
        const citedKeys = new Set();

        function scanDir(dir) {
          for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanDir(fp); continue; }
            if (!ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) continue;
            try {
              const content = fs.readFileSync(fp, 'utf-8');
              CITE_RE.lastIndex = 0;
              const pageCites = new Set();
              let m;
              while ((m = CITE_RE.exec(content)) !== null) {
                for (const k of m[1].split(/\s*;\s*/).map(s => s.replace(/^@/, ''))) {
                  if (refs[k]) { pageCites.add(k); citedKeys.add(k); }
                }
              }
              if (pageCites.size > 1) pageCiteSets.push(pageCites);
            } catch {}
          }
        }
        scanDir(contentDir);

        // Build nodes from cited references only
        const nodes = [...citedKeys].map(key => ({
          id: key,
          title: refs[key]?.title || key,
          year: refs[key]?.year || null,
          authors: Array.isArray(refs[key]?.author)
            ? refs[key].author.slice(0, 3).join(', ')
            : (refs[key]?.author || ''),
        }));

        // Build edges from co-citations (papers cited on the same page)
        const edgeMap = {};
        for (const cites of pageCiteSets) {
          const arr = [...cites].sort();
          for (let i = 0; i < arr.length; i++) {
            for (let j = i + 1; j < arr.length; j++) {
              const eid = arr[i] + '::' + arr[j];
              edgeMap[eid] = (edgeMap[eid] || 0) + 1;
            }
          }
        }
        const edges = Object.entries(edgeMap).map(([eid, weight]) => {
          const [source, target] = eid.split('::');
          return {source, target, type: 'cites', weight};
        }).sort((a, b) => b.weight - a.weight);

        return {nodes, edges, totalReferences: Object.keys(refs).length};
      });
      return json(res, 200, graph);
    } catch {
      return json(res, 500, {error: 'Citation graph build failed'});
    }
  }

  // ── Backup: export all user data ──
  if (req.method === 'GET' && pathname === '/api/backup') {
    try {
      const bundle = {
        comments: loadJSON(COMMENTS_FILE),
        notes: loadJSON(NOTES_FILE),
        discussions: loadJSON(DISCUSSIONS_FILE),
        bookmarks: loadJSON(BOOKMARKS_FILE),
        readingLists: loadJSON(READING_LISTS_FILE),
        glossary: loadJSON(GLOSSARY_FILE),
        flashcards: loadJSON(FLASHCARDS_FILE),
        tasks: loadJSON(TASKS_FILE),
        analytics: loadJSON(ANALYTICS_FILE),
        goals: loadJSON(GOALS_FILE),
        streaks: loadJSON(STREAKS_FILE),
        annotations: loadJSON(ANNOTATIONS_FILE),
        exportedAt: new Date().toISOString(),
      };
      return json(res, 200, bundle);
    } catch (err) {
      return json(res, 500, {error: 'Backup export failed', detail: err.message});
    }
  }

  // ── Backup: restore all user data from bundle ──
  if (req.method === 'POST' && pathname === '/api/backup/restore') {
    if (!rateLimit(`backup-restore:${req.socket.remoteAddress}`, 5)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') {
        return json(res, 400, {error: 'Invalid backup bundle'});
      }
      const mapping = {
        comments: COMMENTS_FILE,
        notes: NOTES_FILE,
        discussions: DISCUSSIONS_FILE,
        bookmarks: BOOKMARKS_FILE,
        readingLists: READING_LISTS_FILE,
        glossary: GLOSSARY_FILE,
        flashcards: FLASHCARDS_FILE,
        tasks: TASKS_FILE,
        analytics: ANALYTICS_FILE,
        goals: GOALS_FILE,
        streaks: STREAKS_FILE,
        annotations: ANNOTATIONS_FILE,
      };
      const restored = [];
      for (const [key, filePath] of Object.entries(mapping)) {
        if (body[key] !== undefined) {
          saveJSON(filePath, body[key]);
          restored.push(key);
        }
      }
      if (restored.length === 0) {
        return json(res, 400, {error: 'No recognizable data keys in bundle'});
      }
      return json(res, 200, {success: true, restored, restoredAt: new Date().toISOString()});
    } catch (err) {
      return json(res, 500, {error: 'Backup restore failed', detail: err.message});
    }
  }

  // ── Batch export: export an entire directory as a single HTML document ──
  if (req.method === 'GET' && pathname === '/api/export/batch') {
    const dir = url.searchParams.get('dir');
    const format = url.searchParams.get('format') || 'html';
    if (!isValidDir(dir)) return json(res, 400, {error: 'Invalid directory. Must start with content/'});
    if (format !== 'html') return json(res, 400, {error: 'Only html format is currently supported'});

    const fullDir = path.join(PROJECT_ROOT, dir);
    try {
      if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) {
        return json(res, 404, {error: 'Directory not found'});
      }

      // Recursively find all .md files in the directory
      const mdFiles = [];
      function walkDirBatch(d) {
        const entries = fs.readdirSync(d, {withFileTypes: true});
        for (const entry of entries) {
          const fullPath = path.join(d, entry.name);
          if (entry.isDirectory()) {
            walkDirBatch(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            mdFiles.push(fullPath);
          }
        }
      }
      walkDirBatch(fullDir);

      if (mdFiles.length === 0) return json(res, 404, {error: 'No markdown files found in directory'});

      // Sort by relative path for consistent ordering
      mdFiles.sort((a, b) => a.localeCompare(b));

      // Limit to 100 files to avoid overload
      const filesToExport = mdFiles.slice(0, 100);

      // Parse each file
      const sections = [];
      for (const fp of filesToExport) {
        try {
          let content = fs.readFileSync(fp, 'utf-8');
          const relPath = path.relative(PROJECT_ROOT, fp);
          let title = path.basename(fp, '.md');

          // Strip frontmatter and extract title
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
          if (fmMatch) {
            const fm = fmMatch[1];
            const tm = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
            if (tm) title = tm[1];
            content = content.slice(fmMatch[0].length);
          }

          // Convert markdown to HTML
          let html = content;
          html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
            const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escaped}</code></pre>`;
          });
          html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
          html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
          html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
          html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
          html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
          html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
          html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
          html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
          html = html.replace(/(^- .+$(\n- .+$)*)/gm, (match) => {
            const items = match.split('\n').map(line => `<li>${line.slice(2)}</li>`).join('\n');
            return `<ul>\n${items}\n</ul>`;
          });
          html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
          html = html.replace(/^(?!<[a-z/])((?!\s*$).+)$/gm, '<p>$1</p>');
          html = html.replace(/\n{3,}/g, '\n\n');

          sections.push({title, html: html.trim(), relPath});
        } catch {}
      }

      if (sections.length === 0) return json(res, 500, {error: 'Failed to parse any files'});

      const dirName = path.basename(dir);
      const safeDirName = dirName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      // Build table of contents
      const tocItems = sections.map((s, i) => {
        const safeTitle = s.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<li><a href="#section-${i}">${safeTitle}</a> <span class="toc-path">${s.relPath.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span></li>`;
      }).join('\n');

      // Build section HTML with page breaks
      const sectionsHtml = sections.map((s, i) => {
        const safeTitle = s.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<section id="section-${i}" class="file-section">
<h1 class="section-title">${safeTitle}</h1>
<p class="section-path">${s.relPath.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>
${s.html}
</section>`;
      }).join('\n');

      const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Batch Export: ${safeDirName}</title>
<style>
@page { size: A4; margin: 2cm; }
@media print {
  body { max-width: none; padding: 0; }
  .file-section { page-break-before: always; }
  .file-section:first-of-type { page-break-before: avoid; }
  #toc { page-break-after: always; }
  a { color: inherit; text-decoration: none; }
  .toc-path { display: inline; }
  pre { border: 1px solid #ccc; }
}
body {
  max-width: 750px;
  margin: 0 auto;
  padding: 2rem 1rem;
  font-family: "Times New Roman", Georgia, serif;
  font-size: 12pt;
  line-height: 1.8;
  color: #111;
}
h1 { font-size: 20pt; margin-top: 0; }
h2 { font-size: 16pt; margin-top: 1.5em; color: #222; }
h3 { font-size: 13pt; margin-top: 1.2em; color: #333; }
h4 { font-size: 11pt; margin-top: 1em; color: #444; }
.cover-title {
  font-size: 28pt;
  text-align: center;
  border-bottom: 3px solid #333;
  padding-bottom: 12px;
  margin-bottom: 0.5em;
}
.cover-meta {
  text-align: center;
  color: #666;
  font-size: 11pt;
  margin-bottom: 2em;
}
#toc { margin: 1em 0; }
#toc h2 { font-size: 18pt; border-bottom: 1px solid #ccc; padding-bottom: 6px; }
#toc ol {
  list-style: decimal;
  padding-left: 1.5em;
  line-height: 2;
}
#toc li { margin: 4px 0; }
#toc a { color: #1a0dab; text-decoration: none; }
#toc a:hover { text-decoration: underline; }
.toc-path { color: #999; font-size: 9pt; margin-left: 0.5em; }
.section-title {
  font-size: 20pt;
  border-bottom: 2px solid #333;
  padding-bottom: 8px;
  margin-bottom: 0.2em;
}
.section-path {
  font-size: 9pt;
  color: #999;
  margin-top: 0;
  margin-bottom: 1.5em;
}
pre { background: #f5f5f5; padding: 12px; overflow-x: auto; border: 1px solid #ddd; font-size: 10pt; border-radius: 3px; }
code { background: #f0f0f0; padding: 1px 4px; border-radius: 2px; font-size: 10pt; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #999; margin-left: 0; padding-left: 1rem; color: #555; font-style: italic; }
a { color: #1a0dab; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
th { background: #f5f5f5; font-weight: bold; }
ul, ol { margin: 0.5em 0 0.5em 1.5em; }
li { margin: 3px 0; }
strong { color: #111; }
</style>
</head>
<body>
<h1 class="cover-title">${safeDirName}</h1>
<p class="cover-meta">${sections.length} files &mdash; Exported from Mochi Lab on ${new Date().toLocaleDateString()}</p>

<nav id="toc">
<h2>Table of Contents</h2>
<ol>
${tocItems}
</ol>
</nav>

${sectionsHtml}

<footer style="margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #ccc; font-size: 9pt; color: #888; text-align: center;">
Generated from Mochi Lab &mdash; ${new Date().toLocaleDateString()}
</footer>
</body>
</html>`;

      const exportName = dirName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'batch';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportName}-batch.html"`,
        'Access-Control-Allow-Origin': CORS_ORIGIN,
      });
      return res.end(fullHtml);
    } catch (err) {
      return json(res, 500, {error: 'Batch export failed', detail: err.message});
    }
  }

  // ── Debug: list all registered route patterns ──
  if (req.method === 'GET' && pathname === '/api/debug/routes') {
    return json(res, 200, {
      totalHandlers: _routeDiagnostics.totalHandlers,
      uniqueRoutes: _routeDiagnostics.uniqueRoutes,
      duplicateCount: _routeDiagnostics.duplicateCount,
      deadCodeLines: _routeDiagnostics.deadCodeLines,
      startupMs: _routeDiagnostics.startupMs,
      memoryAtStartupMB: _routeDiagnostics.memoryAtStartupMB,
      routes: _routeDiagnostics.routes,
      duplicates: _routeDiagnostics.duplicates,
    });
  }

  // ── Quick Note: fast capture to markdown file ──
  if (req.method === 'POST' && pathname === '/api/quicknote') {
    if (!rateLimit(`quicknote:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {text, title} = body;
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return json(res, 400, {error: 'Missing or empty text'});
      }
      if (text.length > MAX_TEXT_LENGTH) {
        return json(res, 400, {error: 'Text too long'});
      }

      const now = new Date();
      const datePrefix = now.toISOString().slice(0, 10); // YYYY-MM-DD
      const cleanTitle = title && typeof title === 'string' && title.trim().length > 0
        ? title.trim()
        : null;

      // Build slug from title or timestamp
      let slug;
      if (cleanTitle) {
        slug = cleanTitle
          .toLowerCase()
          .replace(/[^a-z0-9一-鿿]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60) || `note-${Date.now()}`;
      } else {
        slug = `note-${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
      }

      const filename = `${datePrefix}-${slug}.md`;
      const blogDir = path.join(PROJECT_ROOT, 'content', 'posts', 'blog');
      const filePath = path.join(blogDir, filename);

      // Ensure blog directory exists
      if (!fs.existsSync(blogDir)) {
        fs.mkdirSync(blogDir, {recursive: true});
      }

      // Avoid overwriting existing files
      let finalPath = filePath;
      let finalFilename = filename;
      if (fs.existsSync(filePath)) {
        const suffix = `_${Date.now().toString(36)}`;
        finalFilename = `${datePrefix}-${slug}${suffix}.md`;
        finalPath = path.join(blogDir, finalFilename);
      }

      const frontmatterTitle = cleanTitle || `Quick Note ${datePrefix}`;
      const content = [
        '---',
        `slug: ${slug}`,
        `title: "${frontmatterTitle.replace(/"/g, '\\"')}"`,
        `authors: [zeyu]`,
        `tags: [quick-note]`,
        `draft: true`,
        '---',
        '',
        sanitizeText(text.trim()),
        '',
      ].join('\n');

      fs.writeFileSync(finalPath, content, 'utf-8');
      const relativePath = path.relative(PROJECT_ROOT, finalPath);
      return json(res, 200, {success: true, path: relativePath, filename: finalFilename});
    } catch (err) {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/quicknote') {
    try {
      const blogDir = path.join(PROJECT_ROOT, 'content', 'posts', 'blog');
      if (!fs.existsSync(blogDir)) {
        return json(res, 200, {notes: [], total: 0});
      }
      const files = fs.readdirSync(blogDir)
        .filter(f => f.endsWith('.md'))
        .sort((a, b) => b.localeCompare(a)); // newest first by filename (date-prefixed)

      const notes = [];
      for (const file of files) {
        if (notes.length >= 10) break;
        try {
          const raw = fs.readFileSync(path.join(blogDir, file), 'utf-8');
          // Check if it's a quick note (has quick-note tag)
          if (!raw.includes('quick-note')) continue;
          // Extract title from frontmatter
          const titleMatch = raw.match(/^title:\s*"?(.+?)"?\s*$/m);
          const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
          // Extract body (after frontmatter)
          const bodyMatch = raw.match(/---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)/);
          notes.push({
            filename: file,
            title: titleMatch ? titleMatch[1] : file,
            date: dateMatch ? dateMatch[1] : null,
            preview: bodyMatch ? bodyMatch[1].trim().slice(0, 200) : '',
            path: `content/posts/blog/${file}`,
          });
        } catch {}
      }
      return json(res, 200, {notes, total: notes.length});
    } catch {
      return json(res, 200, {notes: [], total: 0});
    }
  }

  // ── Content quality scoring ──
  if (req.method === 'GET' && pathname === '/api/file/quality') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
      const suggestions = [];

      // 1. Word count score (max 25)
      const bodyText = content.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/```[\s\S]*?```/g, '').replace(/!?\[.*?\]\(.*?\)/g, '');
      const words = bodyText.split(/\s+/).filter(Boolean).length;
      let wordsScore = 0;
      if (words >= 1000) wordsScore = 25;
      else if (words >= 500) wordsScore = 20;
      else if (words >= 200) wordsScore = 15;
      else if (words >= 100) wordsScore = 10;
      else wordsScore = 5;
      if (words < 500) suggestions.push('Add more content — aim for at least 500 words for a substantive document');

      // 2. Frontmatter structure (max 15)
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      let structureFmScore = 0;
      if (fm) {
        structureFmScore += 5;
        if (/^title:/m.test(fm[1])) structureFmScore += 5;
        else suggestions.push('Add a title field to frontmatter');
        if (/^date:/m.test(fm[1])) structureFmScore += 5;
        else suggestions.push('Add a date field to frontmatter');
      } else {
        suggestions.push('Add YAML frontmatter with title and date fields');
      }

      // 3. Heading structure (max 20)
      const h1s = (content.match(/^# .+$/gm) || []).length;
      const h2s = (content.match(/^## .+$/gm) || []).length;
      const h3s = (content.match(/^### .+$/gm) || []).length;
      const totalHeadings = h1s + h2s + h3s;
      let structureHdScore = 0;
      if (totalHeadings >= 5) structureHdScore = 20;
      else if (totalHeadings >= 3) structureHdScore = 15;
      else if (totalHeadings >= 1) structureHdScore = 10;
      else structureHdScore = 0;
      if (totalHeadings === 0) suggestions.push('Add headings (##, ###) to organize content');
      else if (h2s === 0 && h3s === 0) suggestions.push('Add sub-headings (##, ###) for better structure');

      const structureScore = structureFmScore + structureHdScore;

      // 4. Citations (max 10)
      const citationMatches = content.match(/\[@[^\]]+\]/g) || [];
      const citationsCount = citationMatches.length;
      let citationsScore = Math.min(10, citationsCount * 2);
      if (citationsCount === 0) suggestions.push('Add citations [@key] to reference sources');

      // 5. Media — images (max 10)
      const imageMatches = content.match(/!\[[^\]]*\]\([^)]+\)/g) || [];
      const imageCount = imageMatches.length;
      let mediaScore = Math.min(10, imageCount * 3);
      if (imageCount === 0) suggestions.push('Add images to enhance visual engagement');

      // 6. Code blocks (max 10)
      const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
      const codeCount = codeBlocks.length;
      mediaScore = Math.min(10, mediaScore + Math.min(5, codeCount * 2));
      if (codeCount === 0 && /technical|code|programming|algorithm/i.test(content)) {
        suggestions.push('Add code blocks to illustrate technical concepts');
      }

      // 7. Readability — average sentence length (max 10)
      const sentences = bodyText.replace(/\n/g, ' ').split(/[.!?]+/).filter(s => s.trim().length > 5);
      const avgSentenceLen = sentences.length > 0 ? sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) / sentences.length : 0;
      let readabilityScore = 0;
      if (sentences.length === 0) {
        readabilityScore = 0;
      } else if (avgSentenceLen <= 15) {
        readabilityScore = 10;
      } else if (avgSentenceLen <= 20) {
        readabilityScore = 8;
      } else if (avgSentenceLen <= 25) {
        readabilityScore = 5;
      } else {
        readabilityScore = 2;
        suggestions.push('Shorten sentences for better readability — aim for 15-20 words per sentence');
      }

      // 8. Total
      const totalScore = Math.max(0, Math.min(100, wordsScore + structureScore + citationsScore + mediaScore + readabilityScore));
      const level = totalScore >= 80 ? 'excellent' : totalScore >= 60 ? 'good' : totalScore >= 40 ? 'adequate' : totalScore >= 20 ? 'needs-improvement' : 'minimal';

      return json(res, 200, {
        path: filePath,
        score: totalScore,
        level,
        breakdown: {
          words: {score: wordsScore, max: 25, wordCount: words},
          structure: {score: structureScore, max: 35, frontmatter: structureFmScore, headings: structureHdScore, headingCounts: {h1: h1s, h2: h2s, h3: h3s}},
          citations: {score: citationsScore, max: 10, count: citationsCount},
          media: {score: mediaScore, max: 10, images: imageCount, codeBlocks: codeCount},
          readability: {score: readabilityScore, max: 10, avgSentenceLength: Math.round(avgSentenceLen * 10) / 10, sentenceCount: sentences.length},
        },
        suggestions,
      });
    } catch { return json(res, 404, {error: 'File not found'}); }
  }

  // ── Content suggestions: references & wiki links while typing ──
  if (req.method === 'GET' && pathname === '/api/suggest') {
    try {
      const text = (url.searchParams.get('text') || '').trim();
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '5', 10), 1), 20);
      if (!text) return json(res, 200, {references: [], pages: []});

      // Extract keywords from last 50 words
      const stopWords = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had',
        'do','does','did','will','would','shall','should','may','might','must','can','could',
        'and','but','or','nor','not','so','yet','for','of','in','on','at','to','by','with',
        'from','as','into','about','between','through','after','before','during','without',
        'this','that','these','those','it','its','he','she','they','we','you','i','me','my',
        'his','her','our','their','your','which','what','who','whom','how','when','where','why']);
      const words = text.split(/\s+/).slice(-50);
      const keywords = words
        .map(w => w.toLowerCase().replace(/[^a-z0-9一-鿿]/g, ''))
        .filter(w => w.length > 2 && !stopWords.has(w));
      if (keywords.length === 0) return json(res, 200, {references: [], pages: []});

      // 1. Search references.yaml for matching titles/authors
      const matchedRefs = [];
      try {
        const yaml = require('js-yaml');
        const refs = yaml.load(fs.readFileSync(path.join(PROJECT_ROOT, 'references.yaml'), 'utf8')) || {};
        for (const [key, entry] of Object.entries(refs)) {
          const title = (entry.title || '').toLowerCase();
          const authors = (Array.isArray(entry.author) ? entry.author.join(' ') : (entry.author || '')).toLowerCase();
          const haystack = title + ' ' + authors + ' ' + key.toLowerCase();
          let relevance = 0;
          for (const kw of keywords) {
            if (haystack.includes(kw)) relevance++;
          }
          if (relevance > 0) {
            matchedRefs.push({key, title: entry.title || key, relevance});
          }
        }
      } catch { /* references.yaml missing or invalid */ }
      matchedRefs.sort((a, b) => b.relevance - a.relevance);

      // 2. Search content files for matching headings
      const matchedPages = [];
      try {
        const contentDir = path.join(PROJECT_ROOT, 'content');
        if (fs.existsSync(contentDir)) {
          const mdFiles = flatFiles(contentDir).filter(f => f.name.endsWith('.md') || f.name.endsWith('.mdx'));
          for (const file of mdFiles) {
            try {
              const content = fs.readFileSync(path.join(PROJECT_ROOT, file.path), 'utf-8');
              // Extract title from frontmatter or first heading
              let pageTitle = '';
              const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
              if (fmMatch) {
                const titleMatch = fmMatch[1].match(/^title:\s*['"]?(.+?)['"]?\s*$/m);
                if (titleMatch) pageTitle = titleMatch[1];
              }
              if (!pageTitle) {
                const h1Match = content.match(/^#\s+(.+)/m);
                if (h1Match) pageTitle = h1Match[1];
              }
              if (!pageTitle) pageTitle = file.name.replace(/\.(md|mdx)$/, '');

              // Match against headings and title
              const headings = (content.match(/^#{1,3}\s+.+/gm) || []).map(h => h.replace(/^#+\s+/, ''));
              const haystack = (pageTitle + ' ' + headings.join(' ')).toLowerCase();
              let relevance = 0;
              for (const kw of keywords) {
                if (haystack.includes(kw)) relevance++;
              }
              if (relevance > 0) {
                matchedPages.push({path: file.path, title: pageTitle, relevance});
              }
            } catch { /* skip unreadable files */ }
          }
        }
      } catch { /* content dir missing */ }
      matchedPages.sort((a, b) => b.relevance - a.relevance);

      return json(res, 200, {
        references: matchedRefs.slice(0, limit),
        pages: matchedPages.slice(0, limit),
      });
    } catch {
      return json(res, 500, {error: 'Failed to generate suggestions'});
    }
  }

  json(res, 404, {error: 'Not found', path: pathname, hint: 'GET /api/health for server status'});

});

// ── Route diagnostics: scan the server source to report handler stats ──
const _routeDiagnostics = (function analyzeRoutes() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf-8');
  const lines = src.split('\n');
  const handlerRe = /req\.method === '([A-Z]+)' && pathname === '(\/api\/[^']+)'/;
  const anyRe = /pathname === '(\/api\/[^']+)'/;

  const handlers = []; // {line, method, path}
  for (let i = 0; i < lines.length; i++) {
    const m1 = handlerRe.exec(lines[i]);
    if (m1) {
      handlers.push({line: i + 1, method: m1[1], path: m1[2]});
    } else if (lines[i].includes("pathname === '") && lines[i].includes('/api/')) {
      const m2 = anyRe.exec(lines[i]);
      if (m2) handlers.push({line: i + 1, method: 'ANY', path: m2[1]});
    }
  }

  const seen = {};
  const duplicates = [];
  for (const h of handlers) {
    const key = `${h.method} ${h.path}`;
    if (seen[key]) {
      duplicates.push({route: key, firstLine: seen[key], duplicateLine: h.line});
    } else {
      seen[key] = h.line;
    }
  }

  // Estimate dead code lines per duplicate (span until next handler)
  const handlerLines = handlers.map(h => h.line);
  let deadCodeLines = 0;
  for (const dup of duplicates) {
    const idx = handlerLines.indexOf(dup.duplicateLine);
    const nextHandler = idx < handlerLines.length - 1 ? handlerLines[idx + 1] : lines.length;
    deadCodeLines += nextHandler - dup.duplicateLine;
  }

  const uniquePaths = new Set(handlers.map(h => h.path));

  return {
    totalHandlers: handlers.length,
    uniqueRoutes: Object.keys(seen).length,
    uniquePaths: uniquePaths.size,
    duplicateCount: duplicates.length,
    deadCodeLines,
    startupMs: null, // filled in on listen
    memoryAtStartupMB: null,
    routes: Object.keys(seen).sort(),
    duplicates,
  };
})();

server.listen(PORT, () => {
  const startupNs = process.hrtime.bigint() - _startupTime;
  const startupMs = Number(startupNs / 1_000_000n);
  const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  _routeDiagnostics.startupMs = startupMs;
  _routeDiagnostics.memoryAtStartupMB = parseFloat(memMB);

  console.log(`\n  Mochi Lab Editor API`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Startup: ${startupMs}ms | Heap: ${memMB} MB`);
  console.log(`  Handlers: ${_routeDiagnostics.totalHandlers} total, ${_routeDiagnostics.uniqueRoutes} unique routes, ${_routeDiagnostics.uniquePaths} unique paths`);
  console.log(`  Duplicates: ${_routeDiagnostics.duplicateCount} duplicate handlers (${_routeDiagnostics.deadCodeLines} lines of dead code)`);
  if (_routeDiagnostics.duplicates.length > 0) {
    console.log(`  Duplicate details:`);
    for (const d of _routeDiagnostics.duplicates) {
      console.log(`    ${d.route}: line ${d.firstLine} (active) -> line ${d.duplicateLine} (dead)`);
    }
  }
  console.log(`  Debug endpoint: GET /api/debug/routes\n`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
