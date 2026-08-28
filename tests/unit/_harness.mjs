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

/** Stand-in repo root. Never touched on disk; only joined into paths. */
export const PROJECT_ROOT = '/fake/root';

const DATA_FILES = [
  'COMMENTS_FILE:comments', 'NOTES_FILE:notes', 'ANALYTICS_FILE:analytics',
  'USERS_FILE:users', 'BOOKMARKS_FILE:bookmarks',
  'READING_LISTS_FILE:reading-lists', 'STREAKS_FILE:streaks',
  'ANNOTATIONS_FILE:annotations', 'SNAPSHOTS_FILE:snapshots',
  'SCHEDULES_FILE:schedules', 'WHITEBOARDS_FILE:whiteboards',
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
 * Any other key is copied onto the ctx verbatim, replacing the default.
 *
 * ctx.calls records loadJSON/saveJSON/rateLimit/invalidateCache/json activity
 * and ctx.store is the live backing map, so a test can assert both what the
 * handler read and what it persisted.
 */
export function makeCtx(overrides = {}) {
  const {
    store = {},
    fs = mockFs(),
    rateLimitAllow = true,
    PROJECT_ROOT: root = PROJECT_ROOT,
    ...rest
  } = overrides;

  const calls = {json: [], loadJSON: [], saveJSON: [], rateLimit: [], invalidateCache: [], cached: []};
  const cache = {};
  const rateLimits = {};
  const presenceStore = {};
  const perfMetrics = {};

  const hasAllowedExt = name => utils.ALLOWED_EXTS.some(ext => name.endsWith(ext));

  function walkDir(dir) {
    const result = [];
    for (const entry of ctx.fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = nodePath.join(dir, entry.name);
      const relPath = nodePath.relative(root, fullPath);
      if (entry.isDirectory()) {
        result.push({name: entry.name, path: relPath, type: 'directory', children: walkDir(fullPath)});
      } else if (hasAllowedExt(entry.name)) {
        const stat = ctx.fs.statSync(fullPath);
        result.push({name: entry.name, path: relPath, type: 'file', mtime: stat.mtimeMs, size: stat.size});
      }
    }
    return result;
  }

  function flatFiles(dir) {
    const result = [];
    (function walk(d) {
      for (const entry of ctx.fs.readdirSync(d, {withFileTypes: true})) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = nodePath.join(d, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (hasAllowedExt(entry.name)) result.push({name: entry.name, path: nodePath.relative(root, fullPath)});
      }
    })(dir);
    return result;
  }

  const ctx = {
    ...FILES,
    PROJECT_ROOT: root,
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
  const res = {
    writableEnded: false,
    statusCode: 200,
    written: null,
    writeHead(status, respHeaders) {
      this.statusCode = status;
      this.written = {status, headers: respHeaders, body: undefined};
      return this;
    },
    end(body) {
      if (this.written) this.written.body = body;
      this.writableEnded = true;
      return this;
    },
  };
  const req = {method, url: pathname + search, headers, socket: {remoteAddress: '127.0.0.1'}};
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
  await routes(req, res, url, pathname, ctx);

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
