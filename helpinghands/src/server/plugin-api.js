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
 *   "content:read"   read-only database document view: content.read/list/stat/walk
 *   "network"     fetch
 *   "storage"     storage.read/storage.write, scoped to this plugin and workspace
 *   "records"     workspace-scoped database collections owned by the plugin
 *   "blobs"       workspace-scoped PostgreSQL assets owned by the plugin
 *   "ai"          the configured private agent runtime
 *   "process"     declared executables, rooted inside the plugin directory
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
const crypto = require('crypto');
const {spawn} = require('child_process');
const {PROJECT_ROOT, VAR_DIR} = require('./paths');
const {numericParam, within} = require('./server-utils');
const {memoryObjectStorage} = require('./object-storage');
const {fsBlobs} = require('./fs/assets');
const {budgetRefusal} = require('./ai-metering');

// One process-level fallback keeps non-PostgreSQL tests and explicitly
// no-database development coherent across requests without writing to disk.
const fallbackObjectStorage = memoryObjectStorage();

/** The surface this file currently implements. */
const API_VERSION = 1;

const CAPABILITIES = Object.freeze([
  'ai', 'blobs', 'cache', 'content:read', 'network',
  'process', 'records', 'storage',
]);


/**
 * Read the caller's database-backed documents, and nothing else.
 *
 * This deliberately does not accept a filesystem root. Runtime documents have
 * one source of truth, so plugins must see the same repository and verified
 * RequestContext as core routes. Every method is async because the production
 * repository is PostgreSQL even though the local adapter can answer
 * synchronously.
 */
function contentCapability({documents, scope}) {
  if (!documents || !scope?.workspaceId || !scope?.userId) {
    throw new Error('the server does not provide scoped documents');
  }

  let snapshot;
  const rows = async () => {
    if (!snapshot) {
      snapshot = Promise.resolve(
        documents.snapshot
          ? documents.snapshot(scope)
          : Promise.resolve(documents.list(scope)).then(async listed => Promise.all(
            listed.map(row => Promise.resolve(documents.get(scope, row.path))),
          )),
      ).then(values => values.filter(Boolean));
    }
    return snapshot;
  };
  const clean = (relative, {directory = false} = {}) => {
    const value = String(relative ?? (directory ? '.' : ''));
    if (directory && (value === '' || value === '.')) return '';
    if (!value || value.startsWith('/') || value.includes('\\') || value.split('/').includes('..')) {
      throw new Error(`path resolves outside the directory this plugin may use: ${value}`);
    }
    return value.replace(/^\.\//, '').replace(/\/$/, '');
  };
  const read = async relative => {
    const wanted = clean(relative);
    return (await rows()).find(row => row.path === wanted)?.markdown ?? null;
  };
  const list = async (relative = '.') => {
    const directory = clean(relative, {directory: true});
    const prefix = directory ? `${directory}/` : '';
    const entries = new Map();
    for (const row of await rows()) {
      if (!row.path.startsWith(prefix)) continue;
      const remainder = row.path.slice(prefix.length);
      if (!remainder) continue;
      const [name, ...rest] = remainder.split('/');
      entries.set(name, {name, directory: rest.length > 0});
    }
    return [...entries.values()];
  };
  const stat = async relative => {
    const wanted = clean(relative);
    const row = (await rows()).find(item => item.path === wanted);
    if (!row) return null;
    return {mtimeMs: Date.parse(row.updatedAt) || 0, size: Buffer.byteLength(String(row.markdown ?? ''), 'utf8')};
  };
  const walk = async (relative = '.', {extensions = null} = {}) => {
    const directory = clean(relative, {directory: true});
    const prefix = directory ? `${directory}/` : '';
    return (await rows())
      .map(row => row.path)
      .filter(documentPath => documentPath.startsWith(prefix))
      .filter(documentPath => documentPath.slice(prefix.length).split('/').every(name => !name.startsWith('.') && !name.startsWith('_')))
      .filter(documentPath => !extensions || extensions.some(extension => documentPath.endsWith(extension)));
  };

  return Object.freeze({
    read,
    list,
    stat,
    walk,
    exists: async relative => (await stat(relative)) !== null,
  });
}

/**
 * A plugin's own corner of var/, created on first write.
 *
 * Namespaced by plugin name, so two plugins cannot collide over a filename and
 * neither has to invent a convention to avoid it.
 */
function storageCapability(name, workspaceId, {fs, VAR_DIR}) {
  if (!workspaceId) throw new Error('workspace-scoped plugin storage requires a verified workspace');
  const safeWorkspace = String(workspaceId).replace(/[^\w.-]/g, '_');
  const root = path.join(VAR_DIR, 'plugins', name, 'workspaces', safeWorkspace);
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

/** Workspace-scoped JSON records backed by the selected database store. */
function recordsCapability(name, {collection, scope, onWrite = () => {}}) {
  if (typeof collection !== 'function' || !scope) {
    throw new Error('the server does not provide scoped records');
  }
  const collectionFor = raw => {
    const local = String(raw || '').trim();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(local)) throw new Error('invalid record collection');
    const source = collection(`plugin:${name}:${local}`);
    return Object.freeze({
      list: () => source.list(scope),
      values: () => source.values(scope),
      entries: () => source.entries(scope),
      get: key => source.get(scope, key),
      has: key => source.has(scope, key),
      put: (key, value) => { const result = source.put(scope, key, value); onWrite(); return result; },
      update: (key, transform) => { const result = source.update(scope, key, transform); onWrite(); return result; },
      remove: key => { const result = source.remove(scope, key); if (result) onWrite(); return result; },
      clear: () => { const result = source.clear(scope); if (result) onWrite(); return result; },
      count: () => source.count(scope),
      replaceAll: object => { const result = source.replaceAll(scope, object); onWrite(); return result; },
    });
  };
  return Object.freeze({collection: collectionFor});
}

/** Organization-scoped binary storage for PDFs and other plugin artifacts. */
function blobsCapability(name, {orgId, userId, objectStorage, assets}) {
  if (!orgId) {
    const error = new Error('This action needs an active workspace');
    error.status = 409;
    error.code = 'no-workspace';
    throw error;
  }
  const safeOrg = String(orgId).replace(/[^\w.-]/g, '_');
  const storage = objectStorage ?? fallbackObjectStorage;
  const prefix = `${safeOrg}/assets/`;
  const context = {workspaceId: orgId, userId};
  const transient = new Map();
  const metadata = async key => assets ? await assets.get(context, key) : transient.get(String(key)) ?? null;
  return Object.freeze({
    provider: storage.provider,
    async put(bytes, extension = '') {
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const suffix = /^\.[a-z0-9]{1,10}$/i.test(extension) ? extension.toLowerCase() : '';
      const id = crypto.randomUUID();
      const objectKey = `${prefix}${id}/${sha256}${suffix}`;
      const contentType = suffix === '.pdf' ? 'application/pdf' : 'application/octet-stream';
      await storage.put(objectKey, body, contentType);
      if (assets) await assets.create(context, {id, objectKey, contentType, byteSize: body.length, sha256});
      else transient.set(id, {id, objectKey, contentType, byteSize: body.length, sha256});
      return {key: id, sha256, size: body.length};
    },
    async read(key) {
      const asset = await metadata(key);
      return asset ? storage.get(asset.objectKey) : null;
    },
    async stat(key) {
      const asset = await metadata(key);
      return asset ? storage.stat(asset.objectKey) : null;
    },
    async remove(key) {
      const asset = await metadata(key);
      if (!asset) return false;
      const removed = await storage.remove(asset.objectKey);
      if (removed) {
        if (assets) await assets.remove(context, key);
        else transient.delete(String(key));
      }
      return removed;
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

/** A bounded subprocess rooted inside the requesting plugin's directory. */
function processCapability(pluginDir, commands, spawnImpl = spawn) {
  const allowed = new Set(commands);
  return async function execute(command, args = [], options = {}) {
    if (!allowed.has(command)) throw new Error(`command "${command}" is not declared by this plugin`);
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('command arguments must be strings');
    const cwd = within(pluginDir, options.cwd || '.', 'cwd');
    const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 30_000, 100), 180_000);
    const maxBytes = Math.min(Math.max(Number(options.maxBytes) || 1024 * 1024, 1024), 2 * 1024 * 1024);

    return new Promise(resolve => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let timer;
      const detached = process.platform !== 'win32';
      const child = spawnImpl(command, args, {cwd, detached, stdio: ['pipe', 'pipe', 'pipe']});
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const append = (current, chunk) => (current + String(chunk)).slice(0, maxBytes);
      child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
      child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
      child.on('error', error => finish({ok: false, code: null, stdout, stderr: error.message, timedOut}));
      child.on('close', code => finish({ok: code === 0 && !timedOut, code, stdout, stderr, timedOut}));
      timer = setTimeout(() => {
        timedOut = true;
        if (detached && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else {
          child.kill('SIGKILL');
        }
      }, timeoutMs);
      child.stdin?.end(String(options.input ?? ''));
    });
  };
}

/**
 * Build one plugin's API.
 *
 * `ctx` is the server's own object, read here and never handed on. `shared` is
 * what the installed plugins publish for each other, which is how the seven core
 * handlers and any plugin reach the bibliography without requiring its files.
 */
function buildPluginApi({name, dir, requires = [], commands = [], ctx, req}) {
  const asked = new Set(requires);
  const unknown = [...asked].filter(c => !CAPABILITIES.includes(c));
  if (unknown.length) {
    console.error(`[plugins] ${name} asks for unknown capabilities: ${unknown.join(', ')}`);
  }

  // Workspace authority must come from the URL-resolved RequestContext. The
  // session's activeOrganizationId is only a navigation preference and must
  // never silently scope a plugin request.
  const requestScope = req?.context ?? null;
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
      const requestOrigin = req?.headers?.origin;
      const allowedOrigin = ctx.CORS_ORIGIN === '*' ? (requestOrigin || '*') : ctx.CORS_ORIGIN;
      res.writeHead(status, {
        ...headers,
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Credentials': 'true',
        'Vary': 'Origin',
      });
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
      userId: req?.context?.userId ?? null,
      workspaceId: requestScope?.workspaceId ?? null,
      role: req?.context?.role ?? null,
    }),

    /** What the other installed plugins publish. */
    shared: ctx.pluginProvides ?? {},

    /** Trim and bound a string that came from a request. */
    sanitize: ctx.sanitizeText,
    maxTextLength: ctx.MAX_TEXT_LENGTH,
  };

  if (asked.has('cache')) {
    // Derived plugin data belongs to both the plugin and the active workspace.
    const prefix = `${name}:${api.caller.workspaceId ?? 'public'}:`;
    api.cache = (key, ttlMs, compute) => ctx.cached(`${prefix}${key}`, ttlMs, compute);
    api.invalidateCache = key => ctx.invalidateCache(`${prefix}${key}`);
  }
  // Where the plugin's two directories are, according to the server. A test
  // that moves PROJECT_ROOT moves them with it.
  const root = ctx.PROJECT_ROOT ?? PROJECT_ROOT;
  const files = {
    fs: ctx.fs ?? fs,
    onWrite: () => {
      // Scoped to the workspace whose file was written, so one plugin write
      // does not drop every other organization's derived caches.
      ctx.invalidateCache(ctx.cacheKey ? ctx.cacheKey(requestScope?.workspaceId, 'stats') : 'stats');
      ctx.invalidateCache(ctx.cacheKey ? ctx.cacheKey(requestScope?.workspaceId, 'search') : 'search');
    },
    VAR_DIR: root === PROJECT_ROOT ? VAR_DIR : path.join(root, 'var'),
  };

  if (asked.has('content:read')) api.content = contentCapability({
    documents: ctx.documents,
    scope: requestScope,
  });
  if (asked.has('network')) api.fetch = networkCapability();
  if (asked.has('storage')) api.storage = storageCapability(name, requestScope?.workspaceId, files);
  const recordScope = asked.has('records') || asked.has('blobs') ? requestScope : null;
  if (asked.has('records')) {
    api.records = recordsCapability(name, {
      collection: ctx.collection,
      scope: recordScope,
      onWrite: files.onWrite,
    });
  }
  if (asked.has('blobs')) {
    // With PostgreSQL a plugin's blobs are files in the workspace file system.
    api.blobs = ctx.workspaceFs
      ? fsBlobs(name, {orgId: recordScope.workspaceId, userId: recordScope.userId, fs: ctx.workspaceFs})
      : blobsCapability(name, {
        orgId: recordScope.workspaceId,
        userId: recordScope.userId,
        objectStorage: ctx.objectStorage,
        assets: ctx.assets,
      });
    api.readBytes = () => ctx.readRawBody(req);
  }
  if (asked.has('ai')) {
    api.ai = Object.freeze({
      // Charged to the workspace and member like any other assistant call. A
      // spent budget answers in ai.complete's own {error, status} shape.
      complete: async request => {
        const ai = await ctx.aiFor(requestScope?.userId);
        try {
          await ctx.aiMeter.assertAllowed(requestScope, ai);
        } catch (error) {
          const refusal = budgetRefusal(error);
          if (refusal) return {error: refusal.body.error, status: refusal.status};
          throw error;
        }
        const result = await ai.complete(request);
        await ctx.aiMeter.record(requestScope, 'plugin', result, {ran: Boolean(result.text), local: ai.local});
        return result;
      },
      describe: () => ctx.ai.describe(),
    });
  }
  if (asked.has('process')) {
    api.exec = processCapability(dir, commands, ctx.spawn ?? spawn);
  }

  return api;
}

module.exports = {
  API_VERSION, CAPABILITIES, buildPluginApi, processCapability,
  recordsCapability, blobsCapability, storageCapability, PROJECT_ROOT,
  /** Re-exported where it used to live, for the plugins that import it. */
  within,
  /**
   * Pure helpers a plugin may import directly rather than receive. They read
   * nothing and reach nowhere, so there is no capability to gate: clamping a
   * query parameter is not a privilege.
   */
  numericParam,
};
