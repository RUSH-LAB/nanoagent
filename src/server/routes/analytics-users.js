'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.

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
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, NOTES_FILE, ANALYTICS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE, STREAKS_FILE, SNAPSHOTS_FILE, SCHEDULE_FILE, WHITEBOARDS_FILE, FLASHCARDS_FILE, GLOSSARY_FILE, TASKS_FILE, GOALS_FILE, TARGETS_FILE, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, orgSlugFor, contentRootFor, cacheKey, isValidFilePath, isValidDir, resolveContentPath, contentPathToUrl, sanitizeText, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, _routeDiagnostics
  } = ctx;

  // Site-wide roles (owner/editor/viewer), backed by the user_role table. Not
  // the organization roles Better Auth manages.
  const {getRole, setRole, listUsers, isOwner, isValidRole, ROLES, ownerCount} = ctx.roles;

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
    // Every account on the server, with its email, across every organization.
    // That is the site owner's view and nobody else's: a member of one
    // organization has no business reading the address book of another, and
    // this answered anyone with a session until it was closed. The roster a
    // member is entitled to is their own organization's, at GET /api/org/members.
    if (!isOwner(req.auth.userId)) {
      return json(res, 403, {error: 'Only owners can list every account', code: 'not-owner'});
    }
    // Keyed by id, the shape /admin already renders. The list comes from the
    // user table, so an account with no role assigned still appears, as a
    // viewer, which is how you give it one.
    const users = Object.fromEntries(
      listUsers().map(u => [u.id, {
        role: u.role,
        email: u.email,
        name: u.name,
        username: u.username,
        addedAt: u.addedAt,
      }]),
    );
    return json(res, 200, {users});
  }

  // ── Users: get current user's role ──
  if (req.method === 'GET' && pathname === '/api/users/me') {
    // The caller is whoever the session token says they are. The old
    // `?userId=` form let anyone read anyone's role by asking for it.
    const {userId, orgId, orgRole} = req.auth;
    return json(res, 200, {userId, orgId, orgRole, role: getRole(userId)});
  }

  // ── Users: set role ──
  if (req.method === 'PUT' && SET_ROLE_RE.test(pathname)) {
    if (!rateLimit(`set-role:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const parts = pathname.split('/');
      const userId = parts[3]; // /api/users/:id/role
      const body = await readBody(req);
      const {role} = body;
      if (!isValidRole(role)) return json(res, 400, {error: `Invalid role. Must be ${ROLES.join(', ')}`});
      // The requester is the session holder. It used to be `body.requesterId`,
      // so granting yourself ownership was a matter of naming an existing owner
      // in the JSON you posted.
      if (!isOwner(req.auth.userId)) {
        return json(res, 403, {error: 'Only owners can change roles'});
      }
      // Demoting the last owner would leave nobody able to promote anyone, and
      // no way back short of editing the database by hand.
      if (role !== 'owner' && getRole(userId) === 'owner' && ownerCount() <= 1) {
        return json(res, 409, {error: 'Cannot demote the last owner'});
      }
      // Email and name belong to the account, not the role, so they are no
      // longer writable here; the role table holds only the role.
      if (!setRole(userId, role)) return json(res, 404, {error: 'No such user'});
      return json(res, 200, {success: true, user: {userId, role}});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

};

// Set-role route matcher, exposed for direct unit testing (see
// tests/next-analyticsusers-setrole-re-hoist.test.mjs). The PUT /api/users/:id/role
// handler uses it to guard its dispatch.
module.exports.SET_ROLE_RE = SET_ROLE_RE;
