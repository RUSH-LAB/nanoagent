/**
 * RUSH Lab API server. Exposes a REST API on port 3001 (or EDITOR_PORT) for
 * file CRUD, references, analytics, snapshots, and more.
 * All routes live under /api/* and return JSON with CORS headers.
 */
const _startupTime = process.hrtime.bigint();
const http = require('http');
const fs = require('fs');
const path = require('path');
const {URL} = require('url');
const {execFileSync} = require('child_process');
const {platformConfig} = require('../platform');
const {
  isValidFilePath, isValidDir, resolveContentPath, contentPathToUrl, sanitizeText,
  ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH,
} = require('./server-utils');

const {PROJECT_ROOT, dataFile, TRASH_DIR, LOGS_DIR} = require('./paths');
const {makeSignature} = require('better-auth/crypto');
const {auth, AUTH_SECRET, SITE_URL, tenancy, githubUsers, resolveIdentity, isPublicPath, productionAuthError} = require('./auth');
const {INSTALL_SCRIPTS} = require('./lab-install');
const {servedApp} = require('./lab-app');
const {asksForSession, redirectFor} = require('../utils/signIn');
const {createAiMeter} = require('./ai-metering');
const {
  createWorkspaceContextResolver, matchWorkspaceApiPath, storageScope,
  workspaceDispatchPath,
  isGlobalApiPath,
  normalizeWorkspaceRole, requirePermission: requireWorkspacePermission,
} = require('./workspace-context');
const postgresDatabase = require('./postgres/database');
const postgresServices = postgresDatabase.enabled ? require('./postgres/services') : null;
const {contextualChat, contextualOrg} = require('./context-services');
// Site-wide roles, on ctx like every other dependency a route module needs, so
// a test can substitute an in-memory implementation instead of a real database.
const roles = postgresServices?.roles ?? require('./roles');
const chat = contextualChat(postgresServices?.chat ?? require('./chat'));
const org = contextualOrg(postgresServices?.org ?? require('./org'));
// Mochi's own NanoAgent: the marketplace's plugin packages only. Every run, install and
// plugin page is on the member's own computer (server/runner.js).
const ai = require('./ai');
const {createGithub} = require('./github');
// Every assistant call is checked against its workspace's budget and charged to it.
const aiMeter = createAiMeter(tenancy);
const {createAgentSync} = require('./fs/agent-sync');
const {createWorkspaceApps} = require('./workspace-apps');
const {createAppRuns} = require('./app-runs');
const {createRunners} = require('./runner');
const {createOpenRouterKeys, TOTAL} = require('./openrouter-keys');
// The per-workspace data layer. See server/store/index.js: the only way a route
// module is allowed to reach the thirteen features' data, because it is the
// only way that applies the organization and the owner without being asked to.
const store = postgresServices?.store ?? require('./store');
// Content as rows, and the compiler that renders one when it is asked for.
// Both on ctx rather than required by the route, for the same reason as
// everything else here: a test substitutes them.
const documents = postgresServices?.documents ?? require('./documents');
const preferences = postgresServices?.preferences ?? require('./preferences');
// The OpenRouter key Mochi gives each member's computer, on its own account: production's in its
// own OpenRouter workspace, any other site's (npm start's) in another.
if (!process.env.OPENROUTER_MANAGEMENT_KEY?.trim()) {
  throw new Error('Mochi requires OPENROUTER_MANAGEMENT_KEY: it gives each member\'s computer its OpenRouter key.');
}
const openrouterKeys = createOpenRouterKeys({
  managementKey: process.env.OPENROUTER_MANAGEMENT_KEY.trim(),
  production: process.env.NODE_ENV === 'production',
});
// Members' own computers, which run every NanoAgent call of theirs.
const runners = createRunners({resolveIdentity, openrouterKeys});
const aiSettings = require('./ai-settings');
const workspaceSettings = postgresServices?.workspaceSettings ?? require('./workspace-settings');
const {createObjectStorage} = require('./object-storage');
const {createLegacyAssetStore} = require('./asset-store');
const {createObjectDeletionQueue, drainObjectDeletions} = require('./object-deletions');
const {serveStaticSite} = require('./static-site');
const {servePublicPage} = require('./public-pages');
const {resolveWorkspaceSite} = require('./workspace-site');
const objectStorage = createObjectStorage(process.env, {pool: postgresDatabase.pool});
const assets = postgresServices?.assets ?? require('./assets');
// Uploads: the workspace file system with PostgreSQL, else the legacy store (see asset-store.js).
const assetStore = postgresServices?.assetStore ?? createLegacyAssetStore({assets, objectStorage});
const objectDeletions = postgresServices?.objectDeletions
  ?? createObjectDeletionQueue({db: require('./db').db});
const {compileDocument, compileMarkdown, parseFrontmatter, splitBlogPost} = require('./mdx');
const workspaceContexts = postgresServices?.workspaceContexts ?? createWorkspaceContextResolver();
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
  buildCitation: () => '',
  cleanBibtexValue: value => String(value ?? ''),
  openPapers: () => null,
  paperForStorage: value => value,
});
const {toNodeHandler} = require('better-auth/node');
const rootProvisioning = postgresDatabase.enabled
  ? require('./postgres-root-user')
  : require('./root-user');
const {ensureRootUser} = rootProvisioning;
const PORT = process.env.EDITOR_PORT || process.env.PORT || 3001;
const {name: platformName} = platformConfig();

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

/**
 * The workspace and person a handler's store calls act as RequestContext.
 *
 * Built from `req.auth` and from nothing else, which is what makes it not
 * forgeable: there is no query parameter or body field it consults, so a client
 * has no way to express somebody else. The same rule, and the same reason, as
 * the workspace URL resolver above.
 *
 * A request without a RequestContext resolved from its URL has no workspace.
 */
function scopeFor(req) {
  if (req?.context) return storageScope(req.context);
  const auth = req?.auth;
  return {
    workspaceId: null,
    userId: auth?.userId ?? null,
    membershipId: null,
    role: null,
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
 * `handbook/intro.md` may be a path that exists in more than one workspace.
 *
 * The `org:` prefix is not decoration. invalidateCache matches by substring, so
 * a bare `<slug>:` prefix would let the pattern for a workspace called `lab`
 * also clear one called `mochi-lab`; with `org:` in front, the delimiter has to
 * line up.
 */
function cacheKey(orgId, name) {
  return `workspace:${orgId || 'none'}:${name}`;
}

// Production is same-origin by default. Development keeps the permissive
// origin echo for clients served from elsewhere; the development site itself
// is same-origin through its /api proxy (docusaurus.config.js).
const CORS_ORIGIN = process.env.CORS_ORIGIN
  || (process.env.NODE_ENV === 'production' ? process.env.SITE_URL : '*');

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
    // Keep Authorization for non-browser tooling; browser sessions use cookies.
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
    // A stable protocol identifier, unlike the deployment's display name.
    'X-Powered-By': 'RUSH Lab',
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
  if (data && typeof data.then === 'function') {
    data.catch(() => {
      if (cache[key]?.data === data) delete cache[key];
    });
  }
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

const presenceCleanupTimer = setInterval(cleanStalePresence, 30000);
presenceCleanupTimer.unref?.();

// ── Rate limits ──
// With PostgreSQL the counters live in the database, shared by every process
// and kept across restarts (postgres/tenancy.js). Without it, in this process.
async function rateLimit(key, maxPerMinute) {
  if (tenancy) return (await tenancy.consume(`api:${key}`, {window: 60, max: maxPerMinute})).allowed;
  return memoryRateLimit(key, maxPerMinute);
}

const rateLimits = {};
const MAX_RATE_LIMIT_KEYS = 10000;
function memoryRateLimit(key, maxPerMinute) {
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

const cacheCleanupTimer = setInterval(() => {
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
cacheCleanupTimer.unref?.();

const rateLimitSweepTimer = tenancy ? setInterval(() => {
  tenancy.sweepRateLimits().catch(error => console.error('[rate-limit] Sweep failed:', error.message));
}, 10 * 60_000) : null;
rateLimitSweepTimer?.unref?.();

let objectCleanupRunning = false;
async function cleanPendingObjects() {
  if (objectCleanupRunning) return {processed: 0, removed: 0, failed: 0};
  objectCleanupRunning = true;
  try {
    return await drainObjectDeletions(objectDeletions, objectStorage);
  } finally {
    objectCleanupRunning = false;
  }
}
const objectCleanupTimer = setInterval(() => {
  cleanPendingObjects().catch(error => console.error('[objects] Cleanup failed:', error.message));
}, 60000);
objectCleanupTimer.unref?.();

// Publish due documents once per minute.
const scheduledPublishingTimer = setInterval(async () => {
  const now = new Date();
  for (const {id: workspaceId, ownerId = null} of await org.allOrganizations()) {
    const scope = {workspaceId, userId: ownerId, membershipId: null, role: 'owner', kind: 'system'};
    let due;
    try {
      due = (await store.collection('schedule').list(scope))
        .filter(({value}) => value.status !== 'published' && new Date(value.publishAt) <= now);
    } catch (err) {
      console.error(`[schedule] Could not read the schedule of ${workspaceId}:`, err.message);
      continue;
    }
    if (due.length === 0) continue;

    let published = 0;
    for (const {key, value: schedule} of due) {
      try {
        if (!isValidFilePath(schedule.path)) {
          console.error(`[schedule] Refusing ${schedule.path}: not a content path`);
          continue;
        }
        const documentScope = {
          workspaceId,
          userId: schedule.createdBy ?? ownerId,
          membershipId: null,
          role: 'editor',
          kind: 'system',
        };
        const document = await documents.get(documentScope, schedule.path);
        if (!document) {
          console.log(`[schedule] Skipping ${schedule.path}: file not found`);
          continue;
        }
        let content = document.markdown;
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
        await documents.save(documentScope, schedule.path, content);
        await store.collection('schedule').put(scope, key, {
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
      invalidateCache(cacheKey(workspaceId, ''));
    }
  }
}, 60000);
scheduledPublishingTimer.unref?.();

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
// Plugin runs work on a copy of the member's folder for the plugin (fs/agent-sync.js), and
// outlive their pages and this process (app-runs.js): each computer that says
// hello hands over the runs it holds that no call here has.
const appRuns = postgresServices?.fs
  ? createAppRuns({sessions: postgresServices.sessions, agentSync: createAgentSync({fs: postgresServices.fs}), runners, aiMeter})
  : null;
if (appRuns) {
  runners.onRuns((userId, ids) => appRuns.adopt(userId, ids).catch(error => console.error('[apps] Could not take up runs:', error.message)));
}

const ctx = {
  appendAccessLog, json, readBody, readRawBody, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, cacheKey, isValidFilePath, isValidDir, resolveContentPath, contentPathToUrl, sanitizeText, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS,
  roles,
  chat,
  org,
  ai,
  // The NanoAgent a member's runs go to: their own computer's (server/runner.js).
  aiFor: runners.aiFor,
  runners,
  // The OpenRouter keys Mochi gives members' computers, or null (openrouter-keys.js).
  openrouterKeys,
  // What a member chose in Settings → AI (ai-settings.js).
  aiSettings: async userId => aiSettings.stored(userId ? (await preferences.get(userId)).ai : null),
  aiMeter,
  // Sign-up policy, limits, usage, and platform administration; null without PostgreSQL.
  tenancy,
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
  storageScope,
  normalizeWorkspaceRole,
  requireWorkspacePermission,
  workspaceContexts,
  documents,
  preferences,
  workspaceSettings,
  objectStorage,
  cleanPendingObjects,
  assets,
  assetStore,
  githubUsers,
  // The workspace file system; PostgreSQL only.
  workspaceFs: postgresServices?.fs ?? null,
  publicFs: postgresServices?.publicFs ?? null,
  crdt: postgresServices?.crdt ?? null,
  fsHub: postgresServices?.fsHub ?? null,
  // The plugin marketplace's uploads; PostgreSQL only.
  market: postgresServices?.market ?? null,
  // RUSH Lab, the app (routes/lab.js): its downloads, PostgreSQL only; the secret its connect
  // links are signed with; the scheme of the app serving this site; and the token its uploads carry.
  lab: {
    bundles: postgresServices?.labBundles ?? null,
    secret: AUTH_SECRET,
    siteUrl: SITE_URL,
    scheme: servedApp().scheme,
    uploadToken: process.env.LAB_UPLOAD_TOKEN || null,
    // The member's GitHub login, which names their files' folder on their computer; null when
    // there is no such member any more.
    findMember: async userId => {
      const {internalAdapter} = await auth.$context;
      const user = await internalAdapter.findUserById(userId);
      return user ? {login: user.githubLogin} : null;
    },
    // A Better Auth session for the member, as the device grant makes one (its token), and their
    // GitHub login; null when there is no such member any more.
    createSession: async userId => {
      const {internalAdapter} = await auth.$context;
      const user = await internalAdapter.findUserById(userId);
      if (!user) return null;
      return {token: (await internalAdapter.createSession(userId)).token, login: user.githubLogin};
    },
    // The Set-Cookie header that signs a browser in with the session `token`, as Better Auth's
    // own sign-in sets it.
    sessionCookie: async token => {
      const context = await auth.$context;
      const {name, attributes} = context.authCookies.sessionToken;
      const signed = `${token}.${await makeSignature(token, context.secret)}`;
      return [
        `${name}=${encodeURIComponent(signed)}`, `Path=${attributes.path ?? '/'}`, `Max-Age=${attributes.maxAge}`,
        'HttpOnly', `SameSite=${attributes.sameSite ?? 'Lax'}`, ...(attributes.secure ? ['Secure'] : []),
      ].join('; ');
    },
  },
  // What members submit to their workspace; PostgreSQL only.
  submissions: postgresServices?.submissions ?? null,
  // Plugin sessions and what their runs cost; PostgreSQL only.
  sessions: postgresServices?.sessions ?? null,
  // The plugins each member installed from the marketplace, run from NanoAgent's installs; PostgreSQL only.
  workspaceApps: postgresServices
    ? createWorkspaceApps({ai, market: postgresServices.market, plugins: postgresServices.userPlugins})
    : null,
  // Where the marketplace fetches a plugin's source.
  github: createGithub(),
  // The plugin runs going on, each its session's until its turn is in it; PostgreSQL only.
  appRuns,
  compileDocument,
  compileMarkdown,
  parseFrontmatter,
  splitBlogPost,
  // What the installed plugins lend. ctx.references comes from the bibliography
  // plugin, and falls back to an empty one, because a core handler that reads
  // the bibliography must survive the plugin being removed.
  ...providedByPlugins,
  references: providedByPlugins.references || NO_REFERENCES,
  _routeDiagnostics: null,
};

const workspaceRoutes = require('./routes/workspaces');
const routeModules = [
  require('./routes/workspace-settings'),
  // Content from the database, compiled per request.
  require('./routes/content'),
  require('./routes/assets'),
  // The workspace file system; PostgreSQL only.
  require('./routes/fs'),
  // What workspaces publish, for anyone.
  require('./routes/public'),
  require('./routes/content-stats'),
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
  require('./routes/signup-policy'),
  require('./routes/agents'),
  require('./routes/ai'),
  require('./routes/apps'),
  require('./routes/market'),
  require('./routes/lab'),
  require('./routes/submissions'),
  // Plugin endpoints run after the core ones. A plugin extends the site; it
  // does not get to shadow the routes the site is made of. Each is wrapped so
  // that what reaches it is the narrow plugin API, never this ctx.
  ...serverPlugins.map(p => asRouteModule(p, () => providedByPlugins)),
];

// Built once: toNodeHandler wraps the Better Auth fetch handler for node's
// http server, and rebuilding it per request would re-wrap on every call.
const authHandler = toNodeHandler(auth);

async function handleRequest(req, res) {
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

  // A production process serves the Docusaurus application shell and API from
  // one origin, so the session cookie never has to be exposed to JavaScript.
  // RUSH Lab's install scripts are the server's to write, with its SITE_URL (routes/lab.js).
  if (pathname !== '/api' && !pathname.startsWith('/api/') && !INSTALL_SCRIPTS.has(pathname) && process.env.NODE_ENV === 'production') {
    const root = path.join(PROJECT_ROOT, 'build');
    // A page that needs a session is never sent to a visitor without one, who
    // goes to the sign-in page instead of seeing the page and then losing it.
    const redirect = asksForSession(req) && redirectFor(req, (await resolveIdentity(req)).ok);
    if (redirect) {
      res.writeHead(302, {Location: redirect, 'Cache-Control': 'no-store'});
      return res.end();
    }
    // A published document's page carries its title and content as HTML.
    if (await servePublicPage(req, res, {
      root, publicFs: postgresServices?.publicFs, compileMarkdown, parseFrontmatter, resolveWorkspaceSite,
    })) return;
    if (serveStaticSite(req, res, {root})) return;
  }

  // ── Sign-up, sign-in, sign-out, organizations ──
  // Better Auth owns everything under /api/auth/ and answers on its own. It
  // runs before the identity gate below, because this is where a caller with no
  // session goes to get one.
  if (pathname.startsWith('/api/auth/')) {
    for (const [name, value] of Object.entries(corsHeaders(req))) {
      res.setHeader(name, value);
    }
    // Better Auth rate-limits by the address in cf-connecting-ip or x-real-ip,
    // which the proxies in front of a deployment set. A request with neither
    // came straight to this server, so its address is the socket's.
    if (!req.headers['cf-connecting-ip'] && !req.headers['x-real-ip']) {
      req.headers['x-real-ip'] = req.socket.remoteAddress;
    }
    return authHandler(req, res);
  }

  // ── Identity ──
  // Resolved once, before any handler runs, and attached to the request rather
  // than to `ctx`: `ctx` is a single module-level object shared by every
  // in-flight request, so an identity parked there would leak across
  // concurrent callers. Handlers read `req.auth` and nothing else; a `userId`
  // in a query string or body is now ignored wherever it still appears.
  const resolved = await resolveIdentity(req);
  // The session's refreshed snapshot goes back with the answer, so the next
  // request is identified without a query. Public answers may be cached, so
  // they carry no cookie.
  if (!isPublicPath(pathname)) {
    for (const cookie of resolved.cookies) res.appendHeader('Set-Cookie', cookie);
  }
  if (!resolved.ok && pathname.startsWith('/api/') && !isPublicPath(pathname)) {
    return json(res, resolved.status, {error: resolved.error});
  }
  req.auth = resolved.ok ? resolved.identity : null;
  // Who a rate limit counts against: the account, or before sign-in the client
  // address. Behind Cloudflare and Railway the socket address is the proxy's,
  // which would put every visitor in one bucket.
  req.caller = req.auth?.userId
    ?? String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown');

  // Operational diagnostics are platform-wide rather than workspace data.
  // They belong to the separate platform-admin role and never follow a
  // workspace owner/editor role.
  if (['/api/logs', '/api/perf', '/api/debug/memory', '/api/debug/routes'].includes(pathname)) {
    if (!await roles.isAdmin(req.auth?.userId)) {
      return json(res, 403, {error: 'Only platform administrators can view operational diagnostics'});
    }
  }

  // The path names the workspace. Membership is rechecked for every scoped
  // request; activeOrganizationId is not consulted here.
  const workspaceRequest = matchWorkspaceApiPath(pathname);
  if (workspaceRequest) {
    const requestContext = await workspaceContexts.byId(req.auth?.userId, workspaceRequest.workspaceId);
    if (!requestContext) return json(res, 404, {error: 'Workspace not found'});
    req.context = requestContext;
    req.workspacePath = workspaceRequest.workspacePath;
  }

  // All business APIs are workspace scoped unless they are explicitly listed
  // as account/platform/pre-authentication endpoints. This closes the last
  // route by which activeOrganizationId could silently choose authorization.
  if (pathname.startsWith('/api/') && !workspaceRequest && !isGlobalApiPath(pathname)) {
    return json(res, 404, {error: 'Workspace not found'});
  }

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

  // User-global workspace discovery and the workspace root retain their public
  // path. Every nested workspace endpoint is translated only after the
  // membership check above, so existing handlers cannot accidentally accept an
  // unverified workspace id.
  await workspaceRoutes(req, res, url, pathname, ctx);
  if (res.writableEnded) return;

  const dispatchPathname = workspaceRequest
    ? workspaceDispatchPath(workspaceRequest.workspacePath)
    : pathname;

  // ── Domain route modules (see server/routes/). First to send a response wins. ──
  for (const route of routeModules) {
    await route(req, res, url, dispatchPathname, ctx);
    if (res.writableEnded) return;
  }

  json(res, 404, {error: 'Not found', path: pathname, hint: 'GET /api/health for server status'});

}

/**
 * The answer to a request whose handler threw. A refusal that carries its own
 * status (a permission or tenancy limit) is sent as such; anything else is
 * logged and answered 500. Either way the failure stays with this request: an
 * unhandled rejection would shut the server down for every workspace.
 */
function failRequest(req, res, error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  if (status === 500) console.error(`[server] ${req.method} ${req.url} failed:`, error);
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  json(res, status, status === 500
    ? {error: 'The server could not complete that request'}
    : {error: error.message, ...(error.code ? {code: error.code} : {})});
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => failRequest(req, res, error));
});
server.on('upgrade', (req, socket, head) => {
  runners.upgrade(req, socket, head).catch(() => socket.destroy());
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

// The root account exists before the first request, so root's first GitHub
// sign-in finds it. A server that cannot provision its administrator does not
// start.
postgresDatabase.ready.then(() => ensureRootUser(auth)).then(root => server.listen(PORT, async () => {
  const startupNs = process.hrtime.bigint() - _startupTime;
  const startupMs = Number(startupNs / 1_000_000n);
  const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  _routeDiagnostics.startupMs = startupMs;
  _routeDiagnostics.memoryAtStartupMB = parseFloat(memMB);

  console.log(`\n  ${platformName} Editor API`);
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

  const catalog = ai.describe();
  console.log(catalog.available ? '  Plugin catalog: NanoAgent' : `  Plugin catalog: unavailable. ${catalog.reason}`);
  console.log(`  OpenRouter keys: each member's computer is given one, $${TOTAL} for every member together (${openrouterKeys.workspace})`);

  cleanPendingObjects().catch(error => console.error('[objects] Cleanup failed:', error.message));
  console.log(`  Root: GitHub ${root.login} (owner)${root.created ? ', account created' : ''}`);
  const {workspace} = root;
  if (workspace?.error) console.log(`  Workspace: none (${workspace.error})`);
  else if (workspace?.created) console.log(`  Workspace: "${workspace.name}" ready, with #${workspace.channel}`);
  console.log('');
})).catch(error => {
  console.error(`\n  Startup failed: ${error.message}\n`);
  process.exit(1);
});

let shutdownPromise = null;

function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  clearInterval(presenceCleanupTimer);
  clearInterval(cacheCleanupTimer);
  clearInterval(objectCleanupTimer);
  clearInterval(scheduledPublishingTimer);

  shutdownPromise = new Promise(resolve => {
    const finish = async () => {
      try {
        await postgresDatabase.close();
      } catch (error) {
        console.error('Database shutdown failed:', error.message);
        exitCode = 1;
      }
      resolve();
      process.exit(exitCode);
    };

    if (!server.listening) {
      void finish();
      return;
    }

    runners.close();
    const forceTimer = setTimeout(() => server.closeAllConnections?.(), 10_000);
    forceTimer.unref?.();
    server.close(error => {
      clearTimeout(forceTimer);
      if (error) {
        console.error('HTTP shutdown failed:', error.message);
        exitCode = 1;
      }
      void finish();
    });
    server.closeIdleConnections?.();
  });
  return shutdownPromise;
}

process.once('SIGINT', () => {
  console.log('\nShutting down...');
  void shutdown(0);
});

process.once('SIGTERM', () => {
  void shutdown(0);
});

process.once('uncaughtException', err => {
  console.error('Uncaught exception:', err);
  void shutdown(1);
});

process.once('unhandledRejection', reason => {
  console.error('Unhandled rejection:', reason);
  void shutdown(1);
});
