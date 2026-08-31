/**
 * Mochi Lab API server. Exposes a REST API on port 3001 (or EDITOR_PORT) for
 * file CRUD, references, analytics, snapshots, and more.
 * All routes live under /api/* and return JSON with CORS headers.
 */
const _startupTime = process.hrtime.bigint();
const http = require('http');
const fs = require('fs');
const path = require('path');
const {URL} = require('url');
const {execFileSync} = require('child_process');
const {
  isValidFilePath, isValidDir, resolveContentPath, contentPathToUrl, sanitizeText,
  ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH,
} = require('./server-utils');

const {PROJECT_ROOT, PRIMARY_ORG_SLUG, contentDirFor, dataFile, TRASH_DIR, LOGS_DIR} = require('./paths');
const {auth, resolveIdentity, isPublicPath, productionAuthError} = require('./auth');
// Site-wide roles, on ctx like every other dependency a route module needs, so
// a test can substitute an in-memory implementation instead of a real database.
const roles = require('./roles');
const chat = require('./chat');
const org = require('./org');
const ai = require('./ai');
// The per-workspace data layer. See server/store/index.js: the only way a route
// module is allowed to reach the thirteen features' data, because it is the
// only way that applies the organization and the owner without being asked to.
const store = require('./store');
// Content as rows, and the compiler that renders one when it is asked for.
// Both on ctx rather than required by the route, for the same reason as
// everything else here: a test substitutes them.
const documents = require('./documents');
const {compileDocument} = require('./mdx');
const {loadServerPlugins, collectProvides, asRouteModule} = require('./plugins');
// The tools in plugins/, each contributing its endpoints and whatever it lends
// the rest of the server. Loaded here, above ctx, because ctx spreads what they
// provide and the route list spreads their handlers.
const serverPlugins = loadServerPlugins();
const providedByPlugins = collectProvides(serverPlugins);

/**
 * What a core handler sees when it asks for the bibliography and no plugin is
 * providing one. An empty bibliography rather than a crash: a citation graph
 * with nothing in it is the right answer when there is nothing in it, and the
 * startup banner says which plugins loaded.
 */
const NO_REFERENCES = Object.freeze({
  load: () => ({}),
  buildCitation: () => '',
  cleanBibtexValue: value => String(value ?? ''),
});

/**
 * Adapt a plugin's reader-shaped loader to the (fs, path, root) call the core
 * handlers make.
 *
 * The plugin cannot touch the filesystem, so it asks for `read` and `stat` and
 * lets whoever calls it supply them. Core has fs, and its tests supply a mock
 * one, so the adaptation belongs here rather than in the plugin.
 *
 * `root` is now the caller's own content root rather than the repository root,
 * because a bibliography belongs to a workspace: two research groups do not
 * share one references.yaml, and the plugin's relative `bibliography/
 * references.yaml` resolves inside whichever tree it is given.
 */
function referencesForCore(provided) {
  if (!provided) return NO_REFERENCES;
  const readerFor = (fs, path, contentRoot) => {
    const at = relative => path.join(contentRoot, relative);
    return {
      read(relative) {
        try {
          return fs.readFileSync(at(relative), 'utf-8');
        } catch {
          return null;
        }
      },
      stat(relative) {
        try {
          const {mtimeMs, size} = fs.statSync(at(relative));
          return {mtimeMs, size};
        } catch {
          return null;
        }
      },
    };
  };
  return {
    ...provided,
    load: (fs, path, root) => provided.load(readerFor(fs, path, root)),
  };
}
const {toNodeHandler} = require('better-auth/node');
const {DEV_AUTOLOGIN, ensureRootUser, handleDevLogin, ROOT_USERNAME} = require('./dev-auth');
const PORT = process.env.EDITOR_PORT || 3001;

// ── Access log file setup ──

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

/**
 * The absolute content root of one organization.
 *
 * A function of the caller's organization rather than a constant on ctx,
 * because ctx is one object shared by every in-flight request and a root parked
 * there would be whichever request wrote it last. The organization comes from
 * `req.auth`, which comes from the verified session, so a handler calls this
 * with `req.auth.orgId` and cannot be handed another workspace's tree.
 *
 * Falls back to the primary organization when there is no session at all, which
 * is the case for the two public feeds and for the whole server when
 * ENABLE_AUTH is off (the tests, and `npm run start:noauth`).
 */
function orgSlugFor(orgId) {
  return org.slugForOrg(orgId) || PRIMARY_ORG_SLUG;
}

function contentRootFor(orgId) {
  return contentDirFor(orgSlugFor(orgId));
}

/**
 * The workspace and person a handler's store calls act as: `{orgId, userId}`.
 *
 * Built from `req.auth` and from nothing else, which is what makes it not
 * forgeable: there is no query parameter or body field it consults, so a client
 * has no way to express somebody else. The same rule, and the same reason, as
 * contentRootFor above.
 *
 * A caller with no active workspace falls back to the primary one, which is
 * what the public feeds need and what keeps the whole server working with
 * ENABLE_AUTH off. When the primary workspace does not exist either, the scope
 * carries a null and server/store raises the 409 rather than this guessing.
 */
function scopeFor(req) {
  const auth = req?.auth;
  return {
    orgId: auth?.orgId || org.primaryOrgId(),
    userId: auth?.userId ?? null,
  };
}

/**
 * A cache key belonging to one organization.
 *
 * Every derived thing the server caches is derived from one workspace's
 * content: the search index, the graph, the stats, the feeds, the per-file
 * analyses. The keys used to be bare, which was correct while there was one
 * tree and became a cross-tenant read the moment there were two, silently and
 * with a sixty-second memory. The per-file keys leak the same way, because
 * `books/math/0-intro.md` is now a path that exists in more than one workspace.
 *
 * The `org:` prefix is not decoration. invalidateCache matches by substring, so
 * a bare `<slug>:` prefix would let the pattern for a workspace called `lab`
 * also clear one called `mochi-lab`; with `org:` in front, the delimiter has to
 * line up.
 */
function cacheKey(orgId, name) {
  return `org:${orgSlugFor(orgId)}:${name}`;
}

/**
 * The file tree under `dir`, with every path relative to `base`.
 *
 * `base` is the caller's content root, so the paths that go out on the wire are
 * `books/math/0-intro.md` and never `content/mochi/books/math/0-intro.md`. That
 * is the whole of the isolation story for content: with no organization in the
 * wire format, a request has nowhere to put one, so asking for another
 * workspace's file is not a thing a client can express rather than a thing the
 * server has to remember to refuse.
 */
function walkDir(dir, base = dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(base, fullPath);
    if (entry.isDirectory()) {
      result.push({name: entry.name, path: relPath, type: 'directory', children: walkDir(fullPath, base)});
    } else if (hasAllowedExt(entry.name)) {
      const stat = fs.statSync(fullPath);
      result.push({name: entry.name, path: relPath, type: 'file', mtime: stat.mtimeMs, size: stat.size});
    }
  }
  return result;
}

/** The same tree, flattened to files, likewise relative to `base`. */
function flatFiles(dir, base = dir) {
  const result = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, {withFileTypes: true})) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(d, entry.name);
      const relPath = path.relative(base, fullPath);
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

/**
 * The CORS header set for a request.
 *
 * The caller's own origin is echoed back rather than answering '*'. A browser
 * rejects any credentialed response whose Allow-Origin is '*', and the auth
 * client sends credentialed requests, so '*' meant the preflight failed and the
 * real request was never sent: sign-in stored a working token and the session
 * lookup silently never happened. Vary: Origin keeps a shared cache from
 * handing one origin's response to another.
 */
function corsHeaders(req) {
  const origin = req?.headers?.origin;
  return {
    'Access-Control-Allow-Origin': CORS_ORIGIN === '*' ? (origin || '*') : CORS_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, PATCH, OPTIONS',
    // Authorization so the preflight lets the session token through.
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

const crypto = require('crypto');

// Send a JSON response with the standard header set. For a GET that returns 200
// this also computes an ETag and short-circuits to a 304 on a matching
// if-none-match. Pass opts.cacheControl to override the default 'no-cache' on
// that GET-200 ETag branch; all other responses are unaffected.
function json(res, status, data, opts) {
  const body = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json',
    ...corsHeaders(res.req),
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
const {loadJSON, saveJSON} = require('./data-store');

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
//
// This had never run. It read var/data/schedules.json, and the store the API
// wrote was var/data/schedule.json, so loadJSON returned {} on every tick for
// as long as the loop had existed. It also expected a bare array where the API
// wrote {items: [...]}, so correcting only the filename would have left it
// doing nothing, and correcting only the shape would have left it reading a
// file that is not there.
//
// The defect worth naming is the third: it joined `schedule.path` onto the repo
// root and wrote to it, with no validation. That field arrives from the body of
// POST /api/schedule, where it is passed through sanitizeText, which strips
// control characters and does not care about `../`. Had either of the other two
// bugs ever been fixed on its own, this loop would have been an
// arbitrary-file-write primitive reachable by any signed-in caller. The check
// below is the same isValidFilePath every file handler already uses, and the
// root it resolves against is the owning workspace's content tree, not the
// repository, which is the fourth thing that was wrong once content moved to
// one directory per organization.
//
// The loop belongs to no caller, so it cannot take a scope from a request. It
// asks every workspace what it has due, in turn, and acts inside each one: the
// paths, the caches it drops and the rows it updates are all that workspace's.
//
// Published items keep their row with status 'published', rather than being
// dropped, so that GET /api/schedule can still account for them; that endpoint
// already models an item's life as a status rather than as presence in a list.
setInterval(() => {
  const now = new Date();
  for (const {id: orgId} of org.allOrganizations()) {
    // The schedule is the workspace's, so the scope needs no user. A workspace
    // with nothing scheduled costs one indexed read and no further work.
    const scope = {orgId, userId: null};
    let due;
    try {
      due = store.collection('schedule').list(scope)
        .filter(({value}) => value.status !== 'published' && new Date(value.publishAt) <= now);
    } catch (err) {
      console.error(`[schedule] Could not read the schedule of ${orgId}:`, err.message);
      continue;
    }
    if (due.length === 0) continue;

    const contentRoot = contentRootFor(orgId);
    let published = 0;
    for (const {key, value: schedule} of due) {
      try {
        if (!isValidFilePath(schedule.path)) {
          console.error(`[schedule] Refusing ${schedule.path}: not a content path`);
          continue;
        }
        const fullPath = path.join(contentRoot, schedule.path);
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
        store.collection('schedule').put(scope, key, {
          ...schedule,
          status: 'published',
          publishedAt: now.toISOString(),
        });
        published++;
        console.log(`[schedule] Published ${schedule.path} (was scheduled for ${schedule.publishAt})`);
      } catch (err) {
        console.error(`[schedule] Failed to publish ${schedule.path}:`, err.message);
      }
    }

    if (published > 0) {
      // That workspace's frontmatter changed, so anything derived from its tree
      // is one publish behind. Its caches only: another workspace's search index
      // is not stale because this one published.
      invalidateCache(cacheKey(orgId, 'search'));
      invalidateCache(cacheKey(orgId, 'stats'));
    }
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
  appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, orgSlugFor, contentRootFor, cacheKey, isValidFilePath, isValidDir, resolveContentPath, contentPathToUrl, sanitizeText, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS,
  roles,
  chat,
  org,
  ai,
  // Where the per-workspace features keep their data. The collection factory
  // rather than the whole store module, because it is the only part of it a
  // handler has any business with: the rest is how a store gets built, and a
  // route does not build one. On ctx like every other dependency, so a test
  // drives a throwaway database rather than the real one.
  //
  // `scopeFor` is beside it because the two are only ever used together: a
  // handler asks for the caller's scope and hands it to a collection, and there
  // is no collection method that works without one.
  collection: store.collection,
  scopeFor,
  documents,
  compileDocument,
  // What the installed plugins lend. ctx.references comes from the bibliography
  // plugin, and falls back to an empty one, because a core handler that reads
  // the bibliography must survive the plugin being removed.
  ...providedByPlugins,
  references: referencesForCore(providedByPlugins.references),
  _routeDiagnostics: null,
};

const routeModules = [
  // Content from the database, compiled per request. Ahead of ./routes/files,
  // which is the same content read off disk, because /api/content is the path
  // that knows who is asking.
  require('./routes/content'),
  require('./routes/files'),
  require('./routes/comments-notes'),
  require('./routes/feeds'),
  require('./routes/analytics-users'),
  require('./routes/research-tools'),
  require('./routes/graph-trash-files'),
  require('./routes/study-knowledge'),
  require('./routes/file-tools'),
  require('./routes/bookmarks-reading-lists'),
  require('./routes/analysis-admin'),
  require('./routes/misc-tools'),
  require('./routes/stats'),
  require('./routes/chat'),
  require('./routes/org'),
  require('./routes/ai'),
  // Plugin endpoints run after the core ones. A plugin extends the site; it
  // does not get to shadow the routes the site is made of. Each is wrapped so
  // that what reaches it is the narrow plugin API, never this ctx.
  ...serverPlugins.map(p => asRouteModule(p, () => providedByPlugins)),
];

// Built once: toNodeHandler wraps the Better Auth fetch handler for node's
// http server, and rebuilding it per request would re-wrap on every call.
const authHandler = toNodeHandler(auth);

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

  // ── Sign-up, sign-in, sign-out, organizations ──
  // Better Auth owns everything under /api/auth/ and answers on its own. It
  // runs before the identity gate below, because this is where a caller with no
  // session goes to get one.
  if (pathname.startsWith('/api/auth/')) {
    for (const [name, value] of Object.entries(corsHeaders(req))) {
      res.setHeader(name, value);
    }
    // The bearer plugin returns a new session token in this header, and a
    // cross-origin caller cannot read a response header unless it is exposed.
    res.setHeader('Access-Control-Expose-Headers', 'set-auth-token');
    return authHandler(req, res);
  }

  // ── Passwordless local sign-in ──
  // Development only, and guarded again inside: the handler answers 404 unless
  // DEV_AUTOLOGIN is set outside production, and 403 to anything off loopback.
  if (req.method === 'POST' && pathname === '/api/dev-login') {
    return handleDevLogin(req, res, auth, json);
  }

  // ── Identity ──
  // Resolved once, before any handler runs, and attached to the request rather
  // than to `ctx`: `ctx` is a single module-level object shared by every
  // in-flight request, so an identity parked there would leak across
  // concurrent callers. Handlers read `req.auth` and nothing else; a `userId`
  // in a query string or body is now ignored wherever it still appears.
  const resolved = await resolveIdentity(req);
  if (!resolved.ok && pathname.startsWith('/api/') && !isPublicPath(pathname)) {
    return json(res, resolved.status, {error: resolved.error});
  }
  req.auth = resolved.ok ? resolved.identity : null;

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
  let src = fs.readFileSync(__filename, 'utf-8');
  try {
    const routesDir = path.join(__dirname, 'routes');
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

// Before the socket opens, not after: a server that authenticates nobody
// should never have accepted the first request. See productionAuthError.
const _authRefusal = productionAuthError();
if (_authRefusal) {
  console.error(`\n  ${_authRefusal}\n`);
  process.exit(1);
}

// Create the root account and make it an owner. Does nothing unless
// DEV_AUTOLOGIN is on, so a production database never grows a well-known
// account just because this module loaded.
const rootReady = ensureRootUser(auth).catch(err => {
  console.error(`\n  ${err.message}\n`);
  return null;
});

server.listen(PORT, async () => {
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
  console.log(`  Debug endpoint: GET /api/debug/routes`);

  const assistant = ai.describe();
  console.log(assistant.available
    ? `  Assistant: ${assistant.provider} (${assistant.model})`
    : `  Assistant: unavailable. ${assistant.reason}`);

  const root = await rootReady;
  if (root) {
    console.log(`  Dev sign-in: one click as "${root.username}" (owner)${root.created ? ', account created' : ''}`);
    console.log(`  Root password: ${root.passwordFile}`);
    const {workspace, demo} = root;
    if (workspace?.error) console.log(`  Workspace: none (${workspace.error})`);
    else if (workspace?.created) console.log(`  Workspace: "${workspace.name}" ready, with #${workspace.channel}`);
    if (demo?.error) console.log(`  Second workspace: none (${demo.error})`);
    else if (demo?.name) console.log(`  Second workspace: "${demo.name}", empty, to switch to from the navbar`);
  }
  console.log('');
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
