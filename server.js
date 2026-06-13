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
} = require('./server/server-utils');

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
const TARGETS_FILE = path.join(PROJECT_ROOT, 'data', 'targets.json');
const TRASH_DIR = path.join(PROJECT_ROOT, '.trash');

// ── Access log file setup ──
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');
const ACCESS_LOG = path.join(LOGS_DIR, 'access.log');
const ACCESS_LOG_MAX_LINES = 5000;
const ACCESS_LOG_KEEP_LINES = 1000;

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, {recursive: true});

// Rotate access log on startup if it exceeds the threshold
(function rotateAccessLog() {
  try {
    if (!fs.existsSync(ACCESS_LOG)) return;
    const content = fs.readFileSync(ACCESS_LOG, 'utf-8');
    const lines = content.split('\n').filter(l => l.length > 0);
    if (lines.length > ACCESS_LOG_MAX_LINES) {
      const trimmed = lines.slice(-ACCESS_LOG_KEEP_LINES).join('\n') + '\n';
      fs.writeFileSync(ACCESS_LOG, trimmed, 'utf-8');
    }
  } catch { /* ignore rotation errors */ }
})();

function appendAccessLog(line) {
  try {
    fs.appendFileSync(ACCESS_LOG, line + '\n', 'utf-8');
  } catch { /* ignore write errors */ }
}


function hasAllowedExt(name) {
  return ALLOWED_EXTS.some(ext => name.endsWith(ext));
}

function walkDir(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(PROJECT_ROOT, fullPath);
    if (entry.isDirectory()) {
      result.push({name: entry.name, path: relPath, type: 'directory', children: walkDir(fullPath)});
    } else if (hasAllowedExt(entry.name)) {
      const stat = fs.statSync(fullPath);
      result.push({name: entry.name, path: relPath, type: 'file', mtime: stat.mtimeMs, size: stat.size});
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
      } else if (hasAllowedExt(entry.name)) {
        result.push({name: entry.name, path: relPath});
      }
    }
  }
  walk(dir);
  return result;
}

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const crypto = require('crypto');

// Send a JSON response with the standard header set. For a GET that returns 200
// this also computes an ETag and short-circuits to a 304 on a matching
// if-none-match. Pass opts.cacheControl to override the default 'no-cache' on
// that GET-200 ETag branch; all other responses are unaffected.
function json(res, status, data, opts) {
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
    headers['Cache-Control'] = opts?.cacheControl ?? 'no-cache';
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

// JSON persistence: atomic writes + an mtime/size aware read cache.
// See server/data-store.js. Routes call these unchanged via the ctx object.
const {loadJSON, saveJSON} = require('./server/data-store');

// ── Simple TTL cache for expensive endpoints ──
const cache = {};
const MAX_CACHE_ENTRIES = 200;
function cached(key, ttlMs, fn) {
  const entry = cache[key];
  if (entry && Date.now() - entry.time < ttlMs) return entry.data;
  // Evict oldest entries if cache is at capacity
  const keys = Object.keys(cache);
  if (keys.length >= MAX_CACHE_ENTRIES) {
    const sorted = keys.sort((a, b) => cache[a].time - cache[b].time);
    const toRemove = sorted.slice(0, Math.floor(MAX_CACHE_ENTRIES * 0.25));
    for (const k of toRemove) delete cache[k];
  }
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
const MAX_RATE_LIMIT_KEYS = 10000;
function rateLimit(key, maxPerMinute) {
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = [];
  rateLimits[key] = rateLimits[key].filter(t => now - t < 60000);
  if (rateLimits[key].length >= maxPerMinute) return false;
  // Cap total number of tracked keys to prevent memory exhaustion
  const keys = Object.keys(rateLimits);
  if (keys.length >= MAX_RATE_LIMIT_KEYS) {
    // Remove keys with no recent activity first
    for (const k of keys) {
      if (rateLimits[k].length === 0) delete rateLimits[k];
    }
    // If still over limit, drop oldest half
    const remaining = Object.keys(rateLimits);
    if (remaining.length >= MAX_RATE_LIMIT_KEYS) {
      const oldest = remaining
        .map(k => ({k, oldest: Math.min(...rateLimits[k])}))
        .sort((a, b) => a.oldest - b.oldest);
      for (let i = 0; i < Math.floor(remaining.length / 2); i++) {
        delete rateLimits[oldest[i].k];
      }
    }
  }
  rateLimits[key].push(now);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateLimits)) {
    rateLimits[key] = rateLimits[key].filter(t => now - t < 60000);
    if (rateLimits[key].length === 0) delete rateLimits[key];
  }
  // Always evict stale cache entries (older than 5 minutes)
  for (const key of Object.keys(cache)) {
    if (now - cache[key].time > 300000) delete cache[key];
  }
  // Cap perfMetrics endpoints during periodic cleanup
  const perfKeys = Object.keys(perfMetrics);
  if (perfKeys.length > PERF_MAX_ENDPOINTS) {
    const sorted = perfKeys
      .map(k => {
        const arr = perfMetrics[k];
        return {k, last: arr.length > 0 ? arr[arr.length - 1] : 0};
      })
      .sort((a, b) => a.last - b.last);
    for (let i = 0; i < sorted.length - PERF_MAX_ENDPOINTS; i++) {
      delete perfMetrics[sorted[i].k];
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

// ── Performance metrics: in-memory response time tracking (last 100 per endpoint) ──
const perfMetrics = {}; // { '/api/foo': [ms, ms, ...] }
const PERF_MAX_ENTRIES = 100;
const PERF_MAX_ENDPOINTS = 200;

function recordPerfMetric(endpoint, ms) {
  if (!perfMetrics[endpoint]) {
    // Cap total number of tracked endpoints
    const keys = Object.keys(perfMetrics);
    if (keys.length >= PERF_MAX_ENDPOINTS) {
      // Drop the endpoint with the oldest last entry
      let oldestKey = keys[0], oldestTime = Infinity;
      for (const k of keys) {
        const arr = perfMetrics[k];
        const lastEntry = arr.length > 0 ? arr[arr.length - 1] : 0;
        if (arr.length === 0 || lastEntry < oldestTime) {
          oldestTime = lastEntry;
          oldestKey = k;
        }
      }
      delete perfMetrics[oldestKey];
    }
    perfMetrics[endpoint] = [];
  }
  const arr = perfMetrics[endpoint];
  arr.push(ms);
  if (arr.length > PERF_MAX_ENTRIES) arr.shift();
}

let requestCounter = 0;

// ── Shared context handed to every route module in server/routes/ ──
const ctx = {
  appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS,
  _routeDiagnostics: null,
};

const routeModules = [
  require('./server/routes/files'),
  require('./server/routes/comments-notes'),
  require('./server/routes/feeds'),
  require('./server/routes/references'),
  require('./server/routes/analytics-users'),
  require('./server/routes/discussions'),
  require('./server/routes/research-tools'),
  require('./server/routes/graph-trash-files'),
  require('./server/routes/content-analysis-a'),
  require('./server/routes/content-analysis-b'),
  require('./server/routes/content-analysis-c'),
  require('./server/routes/study-knowledge'),
  require('./server/routes/file-tools'),
  require('./server/routes/bookmarks-reading-lists'),
  require('./server/routes/analysis-admin'),
  require('./server/routes/misc-tools'),
];

const server = http.createServer(async (req, res) => {
  req.setTimeout(30000);
  const reqId = ++requestCounter;
  const start = Date.now();
  const origEnd = res.end.bind(res);
  res.end = function (...args) {
    const ms = Date.now() - start;
    if (req.url !== '/api/health' && req.method !== 'OPTIONS') {
      console.log(`[${reqId}] ${req.method} ${req.url} ${res.statusCode} ${ms}ms`);
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-';
      appendAccessLog(`${new Date().toISOString()} | ${req.method} | ${req.url} | ${res.statusCode} | ${ms} | ${ip}`);
      // Record response time for perf tracking. Reuse the dispatch's already
      // parsed pathname (URL.pathname ignores the host/port base, so this is
      // identical to re-parsing req.url) to drop one WHATWG URL parse per request.
      try {
        const ep = pathname;
        if (ep.startsWith('/api/')) recordPerfMetric(`${req.method} ${ep}`, ms);
      } catch { /* ignore malformed URLs */ }
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

  // ── Memory debug endpoint ──
  if (req.method === 'GET' && pathname === '/api/debug/memory') {
    const mem = process.memoryUsage();
    return json(res, 200, {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      cacheEntries: Object.keys(cache).length,
      rateLimitEntries: Object.keys(rateLimits).length,
      presenceEntries: Object.keys(presenceStore).length,
      perfMetricsEndpoints: Object.keys(perfMetrics).length,
    });
  }

  // ── Access logs ──
  if (req.method === 'GET' && pathname === '/api/logs') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 50, 1), 500);
    try {
      const content = fs.existsSync(ACCESS_LOG) ? fs.readFileSync(ACCESS_LOG, 'utf-8') : '';
      const lines = content.split('\n').filter(l => l.length > 0);
      const recent = lines.slice(-limit);
      return json(res, 200, {total: lines.length, returned: recent.length, logs: recent});
    } catch {
      return json(res, 500, {error: 'Failed to read access log'});
    }
  }

  // ── Domain route modules (see server/routes/). First to send a response wins. ──
  for (const route of routeModules) {
    await route(req, res, url, pathname, ctx);
    if (res.writableEnded) return;
  }


  json(res, 404, {error: 'Not found', path: pathname, hint: 'GET /api/health for server status'});

});

// ── Route diagnostics: scan the server source to report handler stats ──
const _routeDiagnostics = (function analyzeRoutes() {
  let src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf-8');
  try {
    const routesDir = path.join(__dirname, 'server', 'routes');
    for (const f of fs.readdirSync(routesDir)) {
      if (f.endsWith('.js')) src += '\n' + fs.readFileSync(path.join(routesDir, f), 'utf-8');
    }
  } catch { /* routes dir optional */ }
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

ctx._routeDiagnostics = _routeDiagnostics;

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
