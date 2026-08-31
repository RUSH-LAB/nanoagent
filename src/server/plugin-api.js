/**
 * What a plugin is handed instead of the server's insides.
 *
 * Core route modules receive `ctx`: sixty-odd fields including `fs`,
 * `execFileSync` and `PROJECT_ROOT`. That is fine for code that ships with the
 * server, and wrong for code that does not, for two reasons. A plugin holding
 * `fs` can read anything in the repository, so installing one from someone else
 * is running their program as this server. And a plugin reaching into `ctx` is
 * coupled to the server's internals, so a rename in core breaks it silently;
 * that is bearable while every plugin lives in this repository and unbearable
 * the moment one does not.
 *
 * So a plugin gets this instead: a small named surface, and only the parts of
 * it that its plugin.json asks for.
 *
 *   always        respond, readBody, rateLimit, caller, shared
 *   "cache"       cache, invalidateCache
 *   "content:read"   content.read, content.list
 *   "content:write"  content.write  (implies content:read)
 *   "network"     fetch
 *   "storage"     storage.read, storage.write, scoped to this plugin alone
 *
 * A capability the manifest did not ask for is simply absent, so a plugin that
 * reaches for one fails loudly on its own first request rather than quietly
 * acquiring reach nobody granted it.
 *
 * `apiVersion` in the manifest is the promise this file makes. Adding to the
 * surface leaves it alone; removing or changing anything already here raises it.
 */
const fs = require('fs');
const path = require('path');
const {PROJECT_ROOT, CONTENT_DIR, VAR_DIR} = require('./paths');
const {numericParam} = require('./server-utils');

/** The surface this file currently implements. */
const API_VERSION = 1;

const CAPABILITIES = Object.freeze(['cache', 'content:read', 'content:write', 'network', 'storage']);

/** Text longer than this is not a field value, it is an accident or an attack. */
const MAX_WRITE_BYTES = 5 * 1024 * 1024;

/**
 * Resolve `relative` inside `root`, or throw.
 *
 * The guard is on the resolved path rather than on the string, because
 * '../../etc/passwd' and 'a/../../../etc/passwd' are both fine as strings and
 * neither is inside the directory once resolved.
 */
function within(root, relative, what) {
  const resolved = path.resolve(root, String(relative ?? ''));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`${what} is outside the directory this plugin may use: ${relative}`);
  }
  return resolved;
}

/**
 * Read and write files under content/, and nothing else.
 *
 * The filesystem and the root come from the server's ctx rather than from a
 * `require('fs')` here, so that whatever the server considers the filesystem to
 * be is what a plugin sees: the real one in production, and the in-memory one a
 * test injects. The plugin still cannot reach either directly.
 */
function contentCapability(writable, {fs, CONTENT_DIR, onWrite}) {
  const read = (relative) => {
    try {
      return fs.readFileSync(within(CONTENT_DIR, relative, 'path'), 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };
  const list = (relative = '.') => {
    try {
      return fs.readdirSync(within(CONTENT_DIR, relative, 'path'), {withFileTypes: true})
        .map(e => ({name: e.name, directory: e.isDirectory()}));
    } catch {
      return [];
    }
  };
  /**
   * Size and modification time, or null when the file is not there.
   *
   * A read capability that cannot tell you whether a file changed forces every
   * caller to re-read and re-parse it; the bibliography memoizes a 250 KB YAML
   * on exactly this.
   */
  const stat = (relative) => {
    try {
      const {mtimeMs, size} = fs.statSync(within(CONTENT_DIR, relative, 'path'));
      return {mtimeMs, size};
    } catch {
      return null;
    }
  };

  /**
   * Every file under `relative`, depth first, as content-relative paths.
   * Dotfiles and underscore-prefixed drafts are skipped, matching the site's
   * own walk, and `extensions` narrows it to the ones worth reading.
   */
  const walk = (relative = '.', {extensions = null} = {}) => {
    const out = [];
    const visit = (rel) => {
      for (const entry of list(rel)) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
        const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
        if (entry.directory) visit(child);
        else if (!extensions || extensions.some(e => entry.name.endsWith(e))) out.push(child);
      }
    };
    visit(relative);
    return out;
  };

  const api = {read, list, stat, walk, exists: rel => fs.existsSync(within(CONTENT_DIR, rel, 'path'))};
  if (!writable) return Object.freeze(api);

  api.write = (relative, text) => {
    const target = within(CONTENT_DIR, relative, 'path');
    const body = String(text);
    if (Buffer.byteLength(body) > MAX_WRITE_BYTES) throw new Error('content write is too large');
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, body, 'utf-8');
    // The server caches things it derives from content, and only the server
    // knows which. A plugin that writes should not have to name them, and
    // should not be able to reach for any other key to do it.
    onWrite();
  };
  return Object.freeze(api);
}

/**
 * A plugin's own corner of var/, created on first write.
 *
 * Namespaced by plugin name, so two plugins cannot collide over a filename and
 * neither has to invent a convention to avoid it.
 */
function storageCapability(name, {fs, VAR_DIR}) {
  const root = path.join(VAR_DIR, 'plugins', name);
  const fileFor = key => within(root, `${String(key).replace(/[^\w.-]/g, '_')}.json`, 'key');
  return Object.freeze({
    dir: root,
    read(key, fallback = null) {
      try {
        return JSON.parse(fs.readFileSync(fileFor(key), 'utf-8'));
      } catch {
        return fallback;
      }
    },
    write(key, value) {
      const target = fileFor(key);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      // Written beside and renamed, so a crash mid-write cannot leave a
      // half-serialized file where a whole one used to be.
      const temporary = `${target}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf-8');
      fs.renameSync(temporary, target);
    },
  });
}

/**
 * Outbound HTTP, which is `fetch` with a timeout attached.
 *
 * A plugin that wants the network gets this rather than `execFileSync`, which
 * is how one of them was shelling out to curl. Requests to this server's own
 * API are refused: a plugin should call its own code, not loop back through the
 * router and around whatever the caller was allowed to do.
 */
function networkCapability({timeoutMs = 10_000} = {}) {
  return async function pluginFetch(url, init = {}) {
    const target = new URL(String(url));
    if (!/^https?:$/.test(target.protocol)) throw new Error(`unsupported protocol: ${target.protocol}`);
    // URL keeps the brackets on an IPv6 literal, so http://[::1]/ arrives as
    // '[::1]' and would otherwise walk past a list written the obvious way.
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host) || host.startsWith('127.')) {
      throw new Error('a plugin may not call back into this server');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? timeoutMs);
    try {
      return await fetch(target, {...init, signal: controller.signal});
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Build one plugin's API.
 *
 * `ctx` is the server's own object, read here and never handed on. `shared` is
 * what the installed plugins publish for each other, which is how the seven core
 * handlers and any plugin reach the bibliography without requiring its files.
 */
function buildPluginApi({name, requires = [], ctx, req}) {
  const asked = new Set(requires);
  const unknown = [...asked].filter(c => !CAPABILITIES.includes(c));
  if (unknown.length) {
    console.error(`[plugins] ${name} asks for unknown capabilities: ${unknown.join(', ')}`);
  }

  const api = {
    /** The plugin's own name, for log lines and cache keys. */
    name,
    apiVersion: API_VERSION,

    /** Answer the request. The only way to reply, other than a stream. */
    respond: (res, status, body) => ctx.json(res, status, body),

    /**
     * Answer with something that is not JSON: a BibTeX file, an XML document.
     * Headers are merged over the CORS set, so a plugin cannot forget them and
     * cannot widen them either.
     */
    stream: (res, {status = 200, headers = {}, body}) => {
      res.writeHead(status, {...headers, 'Access-Control-Allow-Origin': ctx.CORS_ORIGIN});
      res.end(body);
    },

    /** The parsed JSON body, or a rejection the caller turns into a 400. */
    readBody: () => ctx.readBody(req),

    /**
     * Rate limit, under a key this plugin cannot use to collide with another's.
     */
    rateLimit: (key, perMinute) => ctx.rateLimit(`${name}:${key}`, perMinute),

    /** Who is asking, as the verified session says. Never what they claim. */
    caller: Object.freeze({
      userId: req?.auth?.userId ?? null,
      orgId: req?.auth?.orgId ?? null,
      orgRole: req?.auth?.orgRole ?? null,
    }),

    /** What the other installed plugins publish. */
    shared: ctx.pluginProvides ?? {},

    /** Trim and bound a string that came from a request. */
    sanitize: ctx.sanitizeText,
    maxTextLength: ctx.MAX_TEXT_LENGTH,
  };

  if (asked.has('cache')) {
    // Keys are namespaced for the same reason the rate limiter's are.
    api.cache = (key, ttlMs, compute) => ctx.cached(`${name}:${key}`, ttlMs, compute);
    api.invalidateCache = key => ctx.invalidateCache(`${name}:${key}`);
  }
  // Where the plugin's two directories are, according to the server. A test
  // that moves PROJECT_ROOT moves them with it.
  const root = ctx.PROJECT_ROOT ?? PROJECT_ROOT;
  const files = {
    fs: ctx.fs ?? fs,
    onWrite: () => {
      ctx.invalidateCache('stats');
      ctx.invalidateCache('search');
    },
    CONTENT_DIR: root === PROJECT_ROOT ? CONTENT_DIR : path.join(root, 'content'),
    VAR_DIR: root === PROJECT_ROOT ? VAR_DIR : path.join(root, 'var'),
  };

  if (asked.has('content:read') || asked.has('content:write')) {
    api.content = contentCapability(asked.has('content:write'), files);
  }
  if (asked.has('network')) api.fetch = networkCapability();
  if (asked.has('storage')) api.storage = storageCapability(name, files);

  return api;
}

module.exports = {
  API_VERSION, CAPABILITIES, buildPluginApi, within, PROJECT_ROOT,
  /**
   * Pure helpers a plugin may import directly rather than receive. They read
   * nothing and reach nowhere, so there is no capability to gate: clamping a
   * query parameter is not a privilege.
   */
  numericParam,
};
