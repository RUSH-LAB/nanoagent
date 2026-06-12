'use strict';
// Route module organized from server.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server.js detects a sent response via res.writableEnded.

// Object keys that must never be used as map keys in the analytics/user stores,
// since assigning them can pollute Object.prototype. Hoisted and frozen so the
// pageview, set-role, and presence handlers below share one immutable, read-only guard list.
const PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

// Set-role route matcher for PUT /api/users/:id/role. Hoisted to module scope so
// the RegExp is built once at module load instead of re-allocated on every request
// that falls through the earlier handlers to the set-role dispatch check below. The
// pattern is stateless (no /g, no /y), and .test() on a non-global regex never reads
// or mutates lastIndex, so one shared instance returns the same boolean every call.
const SET_ROLE_RE = /^\/api\/users\/[^/]+\/role$/;

module.exports = async function analytics_users_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, collectFeedItems, parseFeedItem, cached, invalidateCache, cleanStalePresence, rateLimit, formatAuthorAPA, formatAuthorMLA, formatAuthorIEEE, formatCitation, recordPerfMetric, PROJECT_ROOT, PORT, COMMENTS_FILE, NOTES_FILE, ANALYTICS_FILE, DISCUSSIONS_FILE, USERS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, ANNOTATIONS_FILE, SNAPSHOTS_FILE, SCHEDULES_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, isValidFilePath, isValidDir, sanitizeText, parseBibtex, parseBibtexAuthors, mapBibtexEntryType, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // ── Analytics: record pageview ──
  if (req.method === 'POST' && pathname === '/api/analytics/pageview') {
    if (!rateLimit(`pageview:${req.socket.remoteAddress}`, 60)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: pagePath, referrer, userAgent} = body;
      if (!pagePath || typeof pagePath !== 'string') return json(res, 400, {error: 'Missing path'});
      if (pagePath.length > 500) return json(res, 400, {error: 'Path too long'});
      if (PROTO_KEYS.includes(pagePath)) return json(res, 400, {error: "Invalid path"});
      if (referrer !== undefined && typeof referrer !== "string") return json(res, 400, {error: "referrer must be a string"});
      if (userAgent !== undefined && typeof userAgent !== "string") return json(res, 400, {error: "userAgent must be a string"});
      const analytics = loadJSON(ANALYTICS_FILE);
      if (!analytics.counts) analytics.counts = {};
      if (!analytics.recent) analytics.recent = [];
      const safePath = sanitizeText(pagePath);
      analytics.counts[safePath] = (analytics.counts[safePath] || 0) + 1;
      analytics.recent.unshift({
        path: safePath,
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
    // Only treat an OWN key as a real user. A request-controlled id such as
    // `__proto__` or `constructor` resolves to a truthy inherited value, which
    // would otherwise leak {role:undefined,...} instead of the viewer default.
    const user = Object.hasOwn(users, userId) ? users[userId] : undefined;
    if (user) {
      return json(res, 200, {role: user.role, email: user.email, name: user.name});
    }
    return json(res, 200, {role: 'viewer'});
  }

  // ── Users: set role ──
  if (req.method === 'PUT' && SET_ROLE_RE.test(pathname)) {
    if (!rateLimit(`set-role:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      const userId = parts[3]; // /api/users/:id/role
      const body = await readBody(req);
      const {role, email, name, requesterId} = body;
      const validRoles = ['owner', 'editor', 'viewer'];
      if (!role || typeof role !== 'string' || !validRoles.includes(role)) return json(res, 400, {error: 'Invalid role. Must be owner, editor, or viewer'});
      if (PROTO_KEYS.includes(userId)) return json(res, 400, {error: 'Invalid userId'});
      if (!requesterId || typeof requesterId !== 'string') return json(res, 403, {error: 'Missing or invalid requesterId'});
      if (PROTO_KEYS.includes(requesterId)) return json(res, 400, {error: "Invalid requesterId"});
      if (email !== undefined && typeof email !== "string") return json(res, 400, {error: "email must be a string"});
      if (name !== undefined && typeof name !== "string") return json(res, 400, {error: "name must be a string"});
      const users = loadJSON(USERS_FILE);
      const requester = users[requesterId];
      if (!requester || requester.role !== 'owner') {
        return json(res, 403, {error: 'Only owners can change roles'});
      }
      const existing = users[userId];
      users[userId] = {
        role,
        email: sanitizeText(email) || existing?.email || '',
        name: sanitizeText(name) || existing?.name || '',
        addedAt: existing?.addedAt || new Date().toISOString(),
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
      if (PROTO_KEYS.includes(presencePath) || PROTO_KEYS.includes(userId)) return json(res, 400, {error: 'Invalid filePath or userId'});
      // Treat only an OWN key as an initialized bucket. A request-controlled
      // filePath like `hasOwnProperty`/`toString`/`valueOf` (not screened by
      // PROTO_KEYS) is a truthy inherited member, so the old bare check skipped
      // this init and wrote the record onto Object.prototype instead of an own key.
      if (!Object.hasOwn(presenceStore, presencePath)) presenceStore[presencePath] = {};
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

};

// Set-role route matcher, exposed for direct unit testing (see
// tests/next-analyticsusers-setrole-re-hoist.test.mjs). The PUT /api/users/:id/role
// handler uses it to guard its dispatch.
module.exports.SET_ROLE_RE = SET_ROLE_RE;
