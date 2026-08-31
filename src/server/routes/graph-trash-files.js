'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.

// ── /api/graph wiki-link regex (module scope, reused per request) ──
// Consumed only through WIKI_LINK_RE.exec(...) in a loop that runs to
// exhaustion, and collectGraphFiles resets WIKI_LINK_RE.lastIndex = 0 before
// each file's loop, so one shared instance is behavior-preserving across files
// and back-to-back requests.
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

// ── Export/bundle front-matter + title regexes (module scope, reused per request) ──
// Both are consumed only through String.prototype.match (no /g flag, no lastIndex
// state), so one shared instance each is behavior-preserving and rebuilt 0 times per
// request. The trailing "\n?" and the /m flag are preserved exactly, distinct from the
// no-suffix front-matter pattern used by the /api/graph handler.
const EXPORT_FM_RE = /^---\n([\s\S]*?)\n---\n?/;
const EXPORT_TITLE_RE = /^title:\s*["']?(.+?)["']?\s*$/m;


module.exports = async function graph_trash_files_routes(req, res, url, pathname, ctx) {
  const {
    appendAccessLog, walkDir, flatFiles, json, readBody, readRawBody, loadJSON, saveJSON, cached, invalidateCache, cleanStalePresence, rateLimit, recordPerfMetric, PROJECT_ROOT, PORT, TRASH_DIR, LOGS_DIR, ACCESS_LOG, ACCESS_LOG_MAX_LINES, ACCESS_LOG_KEEP_LINES, CORS_ORIGIN, http, fs, path, crypto, URL, execFileSync, orgSlugFor, contentRootFor, cacheKey, isValidFilePath, isValidDir, resolveContentPath, contentPathToUrl, sanitizeText, ALLOWED_EXTS, IMAGE_EXTS, MAX_BODY_SIZE, MAX_TEXT_LENGTH, cache, MAX_CACHE_ENTRIES, presenceStore, MAX_PRESENCE_FILES, MAX_PRESENCE_USERS_PER_FILE, rateLimits, MAX_RATE_LIMIT_KEYS, perfMetrics, PERF_MAX_ENTRIES, PERF_MAX_ENDPOINTS, collection, scopeFor, documents, requireWorkspacePermission, _routeDiagnostics
  } = ctx;

  // ── Graph: wiki link connections between all pages ──
  if (req.method === 'GET' && pathname === '/api/graph') {
    try {
      if (!req.context) return json(res, 404, {error: 'Workspace not found'});
      requireWorkspacePermission(req.context, 'content:read');
      const scope = scopeFor(req);
      // Param-free, deterministic scan (the exact sibling of the already-cached
      // GET /api/graph/export): memoize the whole {nodes, edges} computation under
      // one static key for the TTL while the json() write runs on every request.
      const result = await cached(cacheKey(req.context.workspaceId, 'graph-data'), 60000, async () => {
        const nodes = [];
        const edges = [];
        const nodeMap = {};

        for (const row of await documents.list(scope)) {
          const fileName = row.path.split('/').pop();
          if (fileName.startsWith('.') || fileName.startsWith('_') || !ALLOWED_EXTS.some(ext => fileName.endsWith(ext))) continue;
          const content = (await documents.get(scope, row.path))?.markdown ?? '';
          let id = row.path.replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
          if (id.endsWith('/index')) id = id.slice(0, -6);
          const strippedName = row.path.split('/').pop().replace(/\.(mdx?|md)$/, '');
          let title = row.title;
          if (title === strippedName) title = content.match(/^#\s+(.+)$/m)?.[1] ?? title;
          const parts = row.path.split('/');
          let category = parts.length > 1 ? parts[0] : '';
          if ((category === 'books' || category === 'posts') && parts.length > 2) category = parts[1];
          const node = {id, path: row.path, title, category};
          nodes.push(node);
          nodeMap[id] = node;
          WIKI_LINK_RE.lastIndex = 0;
          let match;
          while ((match = WIKI_LINK_RE.exec(content)) !== null) {
            edges.push({source: id, target: match[1].trim()});
          }
        }

        // Resolve edge targets: wiki links use route paths
        // Keep only edges where target matches a known node id (own key of nodeMap)
        const resolvedEdges = [];
        for (const edge of edges) {
          let targetId = edge.target;
          if (Object.prototype.hasOwnProperty.call(nodeMap, targetId)) {
            resolvedEdges.push({source: edge.source, target: targetId});
          } else {
            // Try matching against the last segment(s)
            const slashTarget = '/' + targetId;
            const found = nodes.find(n => n.id.endsWith(targetId) || n.id.endsWith(slashTarget));
            if (found) {
              resolvedEdges.push({source: edge.source, target: found.id});
            }
          }
        }

        return {nodes, edges: resolvedEdges};
      });
      return json(res, 200, result);
    } catch (err) {
      if (err?.status) return json(res, err.status, {error: err.message, ...(err.code ? {code: err.code} : {})});
      return json(res, 500, {error: 'Graph generation failed: ' + err.message});
    }
  }

  // ── Trash: permanently empty trash ──
  if (req.method === 'DELETE' && pathname === '/api/trash/empty') {
    if (!rateLimit(`trash-empty:${req.socket.remoteAddress}`, 2)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      if (!req.context) return json(res, 404, {error: 'Workspace not found'});
      requireWorkspacePermission(req.context, 'content:delete');
      const deleted = await documents.emptyTrash(scopeFor(req));
      return json(res, 200, {success: true, deleted});
    } catch (error) {
      return json(res, error.status || 500, {error: error.status ? error.message : 'Failed to empty trash'});
    }
  }

  // ── Backlinks: find pages that link to a given page ──
  if (req.method === 'GET' && pathname === '/api/backlinks') {
    const targetPath = url.searchParams.get('path');
    if (!targetPath) return json(res, 400, {error: 'Missing path param'});
    try {
      if (!req.context) return json(res, 404, {error: 'Workspace not found'});
      requireWorkspacePermission(req.context, 'content:read');
      const scope = scopeFor(req);
      const backlinks = await cached(cacheKey(req.context.workspaceId, `backlinks:${targetPath}`), 60000, async () => {
      const result = [];

      // Derive possible link targets from the file path
      // e.g. "books/math/algebra.md" => match [[algebra]], [[math/algebra]], etc.
      const baseName = path.basename(targetPath, path.extname(targetPath));
      const relFromContent = targetPath.replace(/\\/g, '/');
      const withoutExt = relFromContent.replace(/\.(md|mdx)$/, '');
      const withoutExtNoDocs = withoutExt.replace(/^docs\//, '');

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

      for (const row of await documents.list(scope)) {
        const sourcePath = row.path;
        const fileName = sourcePath.split('/').pop();
        if (sourcePath === targetPath || fileName.startsWith('.') || !ALLOWED_EXTS.some(ext => fileName.endsWith(ext))) continue;
        const content = (await documents.get(scope, sourcePath))?.markdown ?? '';
        const sourceTitle = extractTitle(content) || row.title;
        let match;
        wikiLinkRe.lastIndex = 0;
        while ((match = wikiLinkRe.exec(content)) !== null) {
          const linkTarget = match[1].split('|')[0].trim();
          if (linkTarget === baseName || linkTarget === withoutExt || linkTarget === withoutExtNoDocs) {
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
      }
      return result;
      });
      return json(res, 200, {backlinks});
    } catch (error) {
      if (error?.status) return json(res, error.status, {error: error.message, ...(error.code ? {code: error.code} : {})});
      return json(res, 500, {error: 'Backlinks scan failed'});
    }
  }

  // ── Folder: create ──
  if (req.method === 'POST' && pathname === '/api/folder') {
    if (!rateLimit(`create-folder:${req.socket.remoteAddress}`, 20)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: dirPath} = body;
      if (!isValidDir(dirPath)) return json(res, 400, {error: 'Invalid path'});
      if (!req.context) return json(res, 404, {error: 'Workspace not found'});
      requireWorkspacePermission(req.context, 'content:create');
      // Database document paths imply directories; there is no empty folder row
      // and therefore no filesystem operation to perform.
      return json(res, 201, {success: true, path: dirPath, virtual: true});
    } catch (error) {
      if (error?.status) return json(res, error.status, {error: error.message, ...(error.code ? {code: error.code} : {})});
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  // ── Folder: delete (empty only) ──
  if (req.method === 'DELETE' && pathname === '/api/folder') {
    if (!rateLimit(`del-folder:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {path: dirPath} = body;
      if (!isValidDir(dirPath)) return json(res, 400, {error: 'Invalid path'});
      if (!req.context) return json(res, 404, {error: 'Workspace not found'});
      requireWorkspacePermission(req.context, 'content:delete');
      const normalized = String(dirPath).replace(/\\/g, '/').replace(/\/+$/, '');
      if (normalized === '' || normalized === '.') return json(res, 400, {error: 'Cannot delete the root content directory'});
      const exists = (await documents.list(scopeFor(req))).some(document => document.path.startsWith(`${normalized}/`));
      if (exists) return json(res, 400, {error: 'Directory is not empty'});
      return json(res, 200, {success: true, virtual: true});
    } catch (err) {
      if (err.message === 'Invalid JSON') return json(res, 400, {error: 'Invalid request'});
      if (err?.status) return json(res, err.status, {error: err.message, ...(err.code ? {code: err.code} : {})});
      return json(res, 500, {error: 'Delete failed'});
    }
  }

};
