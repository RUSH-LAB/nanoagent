/**
 * Shared harness for the server route test suites.
 *
 * Every route module in server/routes/ exports one async function with the
 * signature (req, res, url, pathname, ctx). server/index.js builds `ctx` once and
 * hands the same object to all of them, so a route test needs three things:
 * the real module, a ctx that looks like the production one, and a way to drive
 * a single request through it and capture the reply.
 *
 * This file provides exactly those three things:
 *
 *   loadRoute(name)   the real CommonJS route module, via createRequire
 *   makeCtx(over)     a production shaped ctx with in-memory stores; every
 *                     field is overridable, and ctx.calls records what the
 *                     handler asked for
 *   invoke(routes, o) build req/res/url, run the handler, return the reply
 *   mockFs(tree)      an in-memory fs subset for the handlers that read disk
 *
 * The validators, parsers and limits come from the real server/server-utils.js
 * rather than being restubbed, so a test exercises genuine input handling. The
 * stateful pieces (JSON stores, TTL cache, rate limiter, presence) are
 * in-memory reimplementations that match server/index.js semantics.
 */
import {createRequire} from 'node:module';
import nodePath from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

/** The real shared helpers, exposed so suites can assert against them. */
export const utils = require('../../src/server/server-utils.js');

/** Builds the narrow object a plugin's handler is handed. */
const {buildPluginApi} = require('../../src/server/plugin-api.js');

/**
 * What the bibliography plugin lends the server, taken from the plugin itself
 * rather than reimplemented here.
 *
 * A core handler's ctx really does carry this in production: server/plugins.js
 * merges each plugin's `provides` onto ctx, and seven core handlers read the
 * bibliography through it. Using the plugin's own object means a suite that
 * seeds references.yaml into mockFs exercises the real loader, and a change to
 * what the plugin provides fails here rather than silently in production.
 */
const bibliographyProvides = require('../../plugins/bibliography/server.js').provides;

/** Stand-in repo root. Never touched on disk; only joined into paths. */
export const PROJECT_ROOT = '/fake/root';

const DATA_FILES = [
  'COMMENTS_FILE:comments', 'NOTES_FILE:notes', 'ANALYTICS_FILE:analytics',
  'BOOKMARKS_FILE:bookmarks',
  'READING_LISTS_FILE:reading-lists', 'STREAKS_FILE:streaks',
  'ANNOTATIONS_FILE:annotations', 'SNAPSHOTS_FILE:snapshots',
  'SCHEDULE_FILE:schedule', 'WHITEBOARDS_FILE:whiteboards',
  'FLASHCARDS_FILE:flashcards', 'GLOSSARY_FILE:glossary', 'TASKS_FILE:tasks',
  'GOALS_FILE:goals', 'TARGETS_FILE:targets',
];

/**
 * The data-file path tokens, resolved exactly as server/index.js resolves them
 * (PROJECT_ROOT/data/<name>.json). Suites key store fixtures off these.
 */
export const FILES = Object.fromEntries(
  DATA_FILES.map(spec => {
    const [key, base] = spec.split(':');
    return [key, nodePath.join(PROJECT_ROOT, 'var', 'data', `${base}.json`)];
  })
);

/**
 * The workspace every suite acts as, and its content root.
 *
 * Content is one tree per organization now, so a fixture lives at
 * `${CONTENT_DIR}/books/math/x.md` and the path a request carries is the
 * `books/math/x.md` part: the organization comes from the session, never from
 * the wire, so there is nowhere in a request to put one.
 */
export const ORG_SLUG = 'mochi';
export const CONTENT_DIR = nodePath.join(PROJECT_ROOT, 'content', ORG_SLUG);

/** A fixture path inside that tree: at('books/math/x.md'). */
export const at = (...parts) => nodePath.join(CONTENT_DIR, ...parts);

/**
 * A cache key as the server builds it. Every cached value is derived from one
 * workspace's content, so every key carries the workspace: bare keys served one
 * organization's search index to another.
 */
export const key = name => `org:${ORG_SLUG}:${name}`;

export const TRASH_DIR = nodePath.join(PROJECT_ROOT, 'var', 'trash');
export const LOGS_DIR = nodePath.join(PROJECT_ROOT, 'var', 'logs');
export const ACCESS_LOG = nodePath.join(LOGS_DIR, 'access.log');

/** Load a real route module by bare name, e.g. loadRoute('study-knowledge'). */
export function loadRoute(name) {
  return require(`../../src/server/routes/${name}.js`);
}

/** Load any other real server module, e.g. loadServer('data-store'). */
export function loadServer(name) {
  return require(`../../src/server/${name}.js`);
}

// ── In-memory fs ──────────────────────────────────────────────────────────

function direntsOf(files, dir) {
  const prefix = dir.endsWith(nodePath.sep) ? dir : dir + nodePath.sep;
  const seen = new Map();
  for (const full of files.keys()) {
    if (!full.startsWith(prefix)) continue;
    const rest = full.slice(prefix.length);
    const slash = rest.indexOf(nodePath.sep);
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (!seen.has(name)) seen.set(name, slash !== -1);
  }
  return [...seen].map(([name, isDir]) => ({
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => false,
  }));
}

/**
 * An in-memory fs subset covering the calls the route handlers make.
 *
 * `tree` maps absolute path to file content; directories are inferred from the
 * paths, so listing works without declaring them. `overrides` replaces or adds
 * individual methods, which is how a suite makes one call throw.
 *
 * Timestamps are deterministic: each write bumps a counter used as mtimeMs, so
 * ordering assertions hold without depending on the wall clock.
 */
export function mockFs(tree = {}, overrides = {}) {
  const files = new Map(Object.entries(tree));
  const dirs = new Set();
  let clock = 1_700_000_000_000;
  const times = new Map([...files.keys()].map(k => [k, clock++]));

  const isDir = p => dirs.has(p) || [...files.keys()].some(f => f.startsWith(p + nodePath.sep));
  const enoent = p => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), {code: 'ENOENT'});

  const fs = {
    _files: files,
    _dirs: dirs,
    existsSync: p => files.has(p) || isDir(p),
    readFileSync(p) {
      if (!files.has(p)) throw enoent(p);
      return files.get(p);
    },
    writeFileSync(p, data) {
      files.set(p, String(data));
      times.set(p, clock++);
    },
    appendFileSync(p, data) {
      files.set(p, (files.get(p) || '') + String(data));
      times.set(p, clock++);
    },
    readdirSync(p, opts) {
      if (!isDir(p)) throw enoent(p);
      const entries = direntsOf(files, p);
      return opts?.withFileTypes ? entries : entries.map(e => e.name);
    },
    statSync(p) {
      if (files.has(p)) {
        const content = files.get(p);
        const mtimeMs = times.get(p);
        return {
          size: Buffer.byteLength(content),
          mtimeMs,
          mtime: new Date(mtimeMs),
          birthtime: new Date(mtimeMs),
          isDirectory: () => false,
          isFile: () => true,
        };
      }
      if (isDir(p)) {
        return {
          size: 0, mtimeMs: clock, mtime: new Date(clock), birthtime: new Date(clock),
          isDirectory: () => true, isFile: () => false,
        };
      }
      throw enoent(p);
    },
    mkdirSync(p) { dirs.add(p); },
    rmdirSync(p) {
      if (!isDir(p)) throw enoent(p);
      dirs.delete(p);
    },
    rmSync(p) {
      files.delete(p);
      for (const k of [...files.keys()]) if (k.startsWith(p + nodePath.sep)) files.delete(k);
      dirs.delete(p);
    },
    unlinkSync(p) {
      if (!files.delete(p)) throw enoent(p);
    },
    renameSync(from, to) {
      if (!files.has(from)) throw enoent(from);
      files.set(to, files.get(from));
      times.set(to, clock++);
      files.delete(from);
    },
    copyFileSync(from, to) {
      if (!files.has(from)) throw enoent(from);
      files.set(to, files.get(from));
      times.set(to, clock++);
    },
  };
  fs.lstatSync = fs.statSync;
  return Object.assign(fs, overrides);
}

// ── ctx ───────────────────────────────────────────────────────────────────

// Sentinel so invoke() can tell an untouched default readBody from one a suite
// supplied deliberately, and only install the request body on the former.
const DEFAULT_READ_BODY = Symbol('defaultReadBody');

/**
 * Build a production shaped ctx.
 *
 * Recognised options, all optional:
 *   store           map of data-file path to parsed value, backing load/saveJSON
 *   fs              an fs implementation, default an empty mockFs()
 *   rateLimitAllow  boolean or (key, max) => boolean, default true (allow)
 *   PROJECT_ROOT    override the repo root token
 *   users           accounts to seed the in-memory role store with, as
 *                   [{id, username, email, name, role}]
 *   roles           a whole roles implementation, if the default will not do
 * Any other key is copied onto the ctx verbatim, replacing the default.
 *
 * ctx.calls records loadJSON/saveJSON/rateLimit/invalidateCache/json activity
 * and ctx.store is the live backing map, so a test can assert both what the
 * handler read and what it persisted.
 */
/**
 * An in-memory stand-in for server/roles.js, matching its semantics: an unknown
 * user reads as a viewer, setRole refuses a user who does not exist (the real
 * one is refused by a foreign key), and listUsers reports every account whether
 * or not it has been given a role.
 *
 * Seed it through makeCtx({users: [{id, username, email, name, role}]}).
 */
export function makeRoles(seed = []) {
  const users = new Map();
  const assigned = new Map();
  for (const u of seed) {
    users.set(u.id, {id: u.id, username: u.username, email: u.email, name: u.name, createdAt: u.createdAt ?? 0});
    if (u.role) assigned.set(u.id, {role: u.role, addedAt: u.addedAt ?? '2026-01-01T00:00:00.000Z'});
  }
  const ROLES = ['owner', 'editor', 'viewer'];
  const DEFAULT_ROLE = 'viewer';
  const api = {
    ROLES,
    DEFAULT_ROLE,
    _users: users,
    _assigned: assigned,
    isValidRole: role => typeof role === 'string' && ROLES.includes(role),
    getRole: userId => assigned.get(userId)?.role ?? DEFAULT_ROLE,
    setRole(userId, role) {
      if (!api.isValidRole(role)) throw new Error(`Invalid role: ${role}`);
      if (!users.has(userId)) return false;
      assigned.set(userId, {role, addedAt: '2026-01-01T00:00:00.000Z'});
      return true;
    },
    listUsers: () => [...users.values()].map(u => ({
      ...u,
      role: assigned.get(u.id)?.role ?? DEFAULT_ROLE,
      addedAt: assigned.get(u.id)?.addedAt,
    })),
    isOwner: userId => api.getRole(userId) === 'owner',
    ownerCount: () => [...assigned.values()].filter(r => r.role === 'owner').length,
  };
  return api;
}

export function makeCtx(overrides = {}) {
  const {
    store = {},
    fs = mockFs(),
    rateLimitAllow = true,
    PROJECT_ROOT: root = PROJECT_ROOT,
    users = [],
    roles = makeRoles(users),
    ...rest
  } = overrides;

  const calls = {json: [], loadJSON: [], saveJSON: [], rateLimit: [], invalidateCache: [], cached: [], ai: []};
  const cache = {};
  const rateLimits = {};
  const presenceStore = {};
  const perfMetrics = {};

  const hasAllowedExt = name => utils.ALLOWED_EXTS.some(ext => name.endsWith(ext));

  // (dir, base = dir), matching server/index.js: paths come back relative to
  // the base, which is the caller's content root, so what a listing returns is
  // what the read endpoint will accept back.
  function walkDir(dir, base = dir) {
    const result = [];
    for (const entry of ctx.fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = nodePath.join(dir, entry.name);
      const relPath = nodePath.relative(base, fullPath);
      if (entry.isDirectory()) {
        result.push({name: entry.name, path: relPath, type: 'directory', children: walkDir(fullPath, base)});
      } else if (hasAllowedExt(entry.name)) {
        const stat = ctx.fs.statSync(fullPath);
        result.push({name: entry.name, path: relPath, type: 'file', mtime: stat.mtimeMs, size: stat.size});
      }
    }
    return result;
  }

  function flatFiles(dir, base = dir) {
    const result = [];
    (function walk(d) {
      for (const entry of ctx.fs.readdirSync(d, {withFileTypes: true})) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = nodePath.join(d, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (hasAllowedExt(entry.name)) result.push({name: entry.name, path: nodePath.relative(base, fullPath)});
      }
    })(dir);
    return result;
  }

  const ctx = {
    ...FILES,
    roles,
    ...bibliographyProvides,
    // The assistant, which in a route test is only ever a thing that was asked
    // something. What it was asked is recorded in calls.ai. A test that needs a
    // refusal replaces the whole object, as makeCtx does for every override:
    // makeCtx({ai: {complete: async () => ({error: '...', status: 503})}}).
    ai: {
      complete: async (request) => {
        calls.ai.push(request);
        return {text: 'a completion'};
      },
      // The streaming twin, which reports the same answer in two pieces so a
      // suite can assert the frames without writing its own provider.
      stream: async (request) => {
        calls.ai.push(request);
        request.onDelta?.('a ');
        request.onDelta?.('completion');
        return {text: 'a completion'};
      },
      describe: () => ({available: true, provider: 'api', model: 'test-model'}),
    },
    PROJECT_ROOT: root,
    /**
     * The caller's content root. Ignores the organization id in production
     * only in the sense that these suites all act as one workspace; a suite
     * that needs two overrides this to tell them apart.
     */
    orgSlugFor: () => ORG_SLUG,
    cacheKey: (orgId, name) => `org:${ORG_SLUG}:${name}`,
    contentRootFor: () => nodePath.join(root, 'content', ORG_SLUG),
    PORT: 3001,
    TRASH_DIR: nodePath.join(root, 'var', 'trash'),
    LOGS_DIR: nodePath.join(root, 'var', 'logs'),
    ACCESS_LOG: nodePath.join(root, 'var', 'logs', 'access.log'),
    ACCESS_LOG_MAX_LINES: 5000,
    ACCESS_LOG_KEEP_LINES: 1000,
    CORS_ORIGIN: '*',

    path: nodePath,
    crypto,
    URL,
    fs,
    http: {},
    execFileSync() { throw new Error('execFileSync is not stubbed in this ctx'); },

    // Real validators, parsers and limits.
    isValidFilePath: utils.isValidFilePath,
    isValidDir: utils.isValidDir,
    resolveContentPath: utils.resolveContentPath,
    // The real transform, not a stub: the feeds and the sitemap are assertions
    // about the URLs this produces, so a stub would be asserting the stub.
    contentPathToUrl: utils.contentPathToUrl,
    sanitizeText: utils.sanitizeText,
    parseBibtex: utils.parseBibtex,
    parseBibtexAuthors: utils.parseBibtexAuthors,
    mapBibtexEntryType: utils.mapBibtexEntryType,
    ALLOWED_EXTS: utils.ALLOWED_EXTS,
    IMAGE_EXTS: utils.IMAGE_EXTS,
    MAX_BODY_SIZE: utils.MAX_BODY_SIZE,
    MAX_TEXT_LENGTH: utils.MAX_TEXT_LENGTH,
    MAX_PRESENCE_FILES: utils.MAX_PRESENCE_FILES,
    MAX_PRESENCE_USERS_PER_FILE: utils.MAX_PRESENCE_USERS_PER_FILE,

    walkDir,
    flatFiles,
    appendAccessLog() {},
    cleanStalePresence() {},
    recordPerfMetric() {},

    loadJSON(file) {
      calls.loadJSON.push(file);
      const value = store[file];
      return value === undefined ? {} : structuredClone(value);
    },
    saveJSON(file, data) {
      calls.saveJSON.push({file, data});
      store[file] = structuredClone(data);
    },
    cached(key, ttlMs, fn) {
      calls.cached.push(key);
      if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key].data;
      const data = fn();
      cache[key] = {data, time: 0};
      return data;
    },
    invalidateCache(pattern) {
      calls.invalidateCache.push(pattern);
      for (const key of Object.keys(cache)) if (!pattern || key.includes(pattern)) delete cache[key];
    },
    rateLimit(key, maxPerMinute) {
      calls.rateLimit.push({key, maxPerMinute});
      return typeof rateLimitAllow === 'function' ? rateLimitAllow(key, maxPerMinute) : rateLimitAllow;
    },
    json(res, status, payload, opts) {
      const reply = {status, payload, opts};
      calls.json.push(reply);
      if (res) res.writableEnded = true;
      return reply;
    },
    readBody: DEFAULT_READ_BODY,
    readRawBody: DEFAULT_READ_BODY,

    cache,
    MAX_CACHE_ENTRIES: 200,
    presenceStore,
    rateLimits,
    MAX_RATE_LIMIT_KEYS: 10000,
    perfMetrics,
    PERF_MAX_ENTRIES: 100,
    PERF_MAX_ENDPOINTS: 200,
    _routeDiagnostics: null,

    ...rest,
  };

  ctx.calls = calls;
  ctx.store = store;
  return ctx;
}

// ── invoke ────────────────────────────────────────────────────────────────

/**
 * The event methods a handler expects on a request or a response.
 *
 * Small on purpose: 'close' is the only event any handler here listens for, and
 * it is how a streaming handler learns that the caller hung up. A suite calls
 * `res.emit('close')` to be that caller.
 */
function emitter() {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return this;
    },
    off(event, fn) {
      listeners.set(event, (listeners.get(event) ?? []).filter(f => f !== fn));
      return this;
    },
    emit(event, ...args) {
      const list = [...(listeners.get(event) ?? [])];
      for (const fn of list) fn(...args);
      return list.length > 0;
    },
  };
}

/**
 * The identity server/index.js would have attached after verifying a session
 * token. Suites that do not care who is calling get this one; suites that do
 * pass their own via invoke's `auth` option.
 */
export const TEST_IDENTITY = Object.freeze({
  userId: 'test-user',
  orgId: null,
  orgRole: null,
  sessionId: null,
});

/**
 * Drive one request through a route module.
 *
 * Options:
 *   method   HTTP verb, default 'GET'
 *   path     pathname, e.g. '/api/glossary'
 *   query    string ('?a=1') or object, appended to the URL
 *   body     parsed value the default readBody resolves to. Pass a string to
 *            get production's parse behaviour: valid JSON resolves, anything
 *            else rejects with Error('Invalid JSON'), which is what the
 *            malformed-body arms of the handlers catch.
 *   ctx      a makeCtx() result; one is created if omitted
 *   headers  request headers, default {}
 *   auth     the resolved identity the dispatcher attaches as req.auth, default
 *            TEST_IDENTITY. Handlers read the caller from here and nowhere
 *            else, so a suite that needs two distinct users passes a different
 *            userId per invoke rather than a different query parameter.
 *
 * Returns {status, payload, replies, ctx, res}. `status`/`payload` are the
 * first reply, which is the one the dispatcher would have sent; `replies` is
 * every json() call, so a test can assert a success reply was never emitted.
 */
export async function invoke(routes, opts = {}) {
  const {
    method = 'GET',
    path: pathname = '/',
    query = '',
    body,
    ctx = makeCtx(),
    headers = {},
    auth = TEST_IDENTITY,
    // Called with the pair this invoke built, just before the handler runs. A
    // suite that needs to act on the connection while the handler is still
    // working (res.emit('close') for a caller who hung up) has no other way to
    // reach it: invoke does not return until the handler is done.
    onRequest,
    // A plugin's handler takes the narrow API from src/server/plugin-api.js,
    // not ctx. Pass the capabilities its plugin.json asks for and this builds
    // the same object the server would, out of the same ctx, so a suite proves
    // the plugin works through the boundary rather than around it.
    plugin = null,
  } = opts;

  const search = typeof query === 'string'
    ? query
    : (() => {
        const qs = new URLSearchParams(query).toString();
        return qs ? `?${qs}` : '';
      })();

  const url = new URL(`http://localhost:3001${pathname}${search}`);

  // A few handlers (the RSS and Atom feeds, file downloads) stream a non-JSON
  // body straight through writeHead/end instead of calling json(). Record those
  // on res.written so a test can assert the status, headers and body.
  //
  // A streaming handler writes many times before it ends, so every chunk is
  // recorded on res.writes as well. Note that writableEnded stays false through
  // all of them, exactly as it does on a real ServerResponse: that is the
  // property the dispatcher reads, and the reason a stream must await its work
  // and call end() rather than return.
  const res = {
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    written: null,
    writes: [],
    headers: {},
    ...emitter(),
    writeHead(status, respHeaders) {
      this.statusCode = status;
      this.written = {status, headers: respHeaders, body: undefined};
      return this;
    },
    write(chunk) {
      this.writes.push(String(chunk));
      return true;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    flushHeaders() {},
    end(body) {
      if (this.written) this.written.body = body;
      this.writableEnded = true;
      return this;
    },
  };
  const req = {
    method, url: pathname + search, headers, socket: {remoteAddress: '127.0.0.1'}, auth,
    ...emitter(),
  };
  res.req = req;

  if (ctx.readBody === DEFAULT_READ_BODY) {
    ctx.readBody = async () => {
      if (typeof body === 'string') {
        try { return JSON.parse(body); } catch { throw new Error('Invalid JSON'); }
      }
      if (body === undefined) throw new Error('Invalid JSON');
      return structuredClone(body);
    };
  }
  if (ctx.readRawBody === DEFAULT_READ_BODY) {
    ctx.readRawBody = async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? ''));
  }

  // ctx.calls.json accumulates across every invoke sharing this ctx, which the
  // cache tests deliberately do, so snapshot the length first and report only
  // the replies this call produced.
  const before = ctx.calls.json.length;
  onRequest?.(req, res);
  let last = ctx;
  if (plugin) {
    const api = buildPluginApi({
      name: plugin.name ?? 'test-plugin',
      requires: plugin.requires ?? [],
      ctx: {...ctx, pluginProvides: plugin.shared ?? {}},
      req,
    });
    // A test replaces a capability by handing over a different one, the way the
    // server hands over the real one. `fetch: () => ...` is how a suite pins
    // what a plugin does with an upstream that is down. Passing a function
    // instead receives the real capabilities, for the common case of wanting
    // one method of one of them to misbehave and the rest to work.
    const over = typeof plugin.capabilities === 'function' ? plugin.capabilities(api) : plugin.capabilities;
    last = Object.assign(api, over ?? {});
  }
  await routes(req, res, url, pathname, last);

  const replies = ctx.calls.json.slice(before);
  const first = replies[0];
  return {
    status: first?.status,
    payload: first?.payload,
    replies,
    written: res.written,
    ctx,
    res,
    req,
    url,
  };
}

/**
 * Assert-friendly shorthand: run a request and return only the reply pair.
 * Suites that only care about {status, payload} use this to stay one line.
 */
export async function call(routes, opts) {
  const {status, payload} = await invoke(routes, opts);
  return {status, payload};
}
