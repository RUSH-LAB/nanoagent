'use strict';

/**
 * Compatibility routes for the old file-shaped API.
 *
 * These endpoints keep their old response shapes while reading and writing
 * `document` rows. Remaining React screens can migrate independently without
 * restoring the filesystem as a second source of truth. The dispatcher only
 * reaches them through an explicit `/api/workspaces/:id/...` request with a
 * verified RequestContext.
 */

function documentTree(rows) {
  const root = [];
  for (const row of rows) {
    const parts = row.path.split('/').filter(Boolean);
    let children = root;
    let current = '';
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index];
      current = current ? `${current}/${name}` : name;
      if (index === parts.length - 1) {
        children.push({name, path: row.path, type: 'file', mtime: Date.parse(row.updatedAt) || 0});
        continue;
      }
      let directory = children.find(item => item.type === 'directory' && item.name === name);
      if (!directory) {
        directory = {name, path: current, type: 'directory', children: []};
        children.push(directory);
      }
      children = directory.children;
    }
  }
  return root;
}

function directoryContents(tree, dir) {
  if (!dir) return tree;
  let children = tree;
  for (const segment of dir.split('/').filter(Boolean)) {
    const found = children.find(item => item.type === 'directory' && item.name === segment);
    if (!found) return null;
    children = found.children;
  }
  return children;
}

function fail(json, res, error, fallback) {
  if (error?.status) {
    return json(res, error.status, {error: error.message, ...(error.code ? {code: error.code} : {})});
  }
  return json(res, 400, {error: fallback});
}

module.exports = async function files_routes(req, res, url, pathname, ctx) {
  const {
    json, readBody, rateLimit, cached, invalidateCache, cacheKey,
    isValidFilePath, isValidDir, scopeFor, documents, collection,
    requireWorkspacePermission,
  } = ctx;

  const handled = pathname === '/api/file' || pathname === '/api/files'
    || pathname === '/api/files/search' || pathname === '/api/stats';
  if (!handled) return;

  // Never infer authorization from activeOrganizationId. Old callers may keep
  // the suffix, but must reach it through /api/workspaces/:id/....
  if (!req.context) return json(res, 404, {error: 'Workspace not found'});
  const scope = scopeFor(req);
  const permit = permission => requireWorkspacePermission(req.context, permission);
  const clearContentCaches = () => {
    invalidateCache(cacheKey(req.context.workspaceId, 'stats'));
    invalidateCache(cacheKey(req.context.workspaceId, 'search'));
  };

  if (req.method === 'GET' && pathname === '/api/file') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    try {
      permit('content:read');
      const document = await documents.get(scope, filePath);
      return document
        ? json(res, 200, {content: document.markdown})
        : json(res, 404, {error: 'File not found'});
    } catch (error) {
      return fail(json, res, error, 'Invalid path');
    }
  }

  if (req.method === 'GET' && pathname === '/api/files') {
    const dir = url.searchParams.get('dir') || '';
    if (!isValidDir(dir)) return json(res, 400, {error: 'Invalid directory'});
    try {
      permit('content:read');
      const files = directoryContents(documentTree(await documents.list(scope)), dir);
      return files === null
        ? json(res, 404, {error: 'Directory not found'})
        : json(res, 200, {files});
    } catch (error) {
      return fail(json, res, error, 'Could not list files');
    }
  }

  if (req.method === 'GET' && pathname === '/api/files/search') {
    const query = (url.searchParams.get('q') || '').toLowerCase();
    try {
      permit('content:read');
      const all = await cached(cacheKey(req.context.workspaceId, 'search:list'), 30000, async () =>
        (await documents.list(scope)).map(document => ({
          name: document.path.split('/').pop(),
          path: document.path,
          title: document.title,
        })),
      );
      const files = query
        ? all.filter(file => [file.name, file.path, file.title].some(value => String(value).toLowerCase().includes(query)))
        : all;
      return json(res, 200, {files});
    } catch (error) {
      return fail(json, res, error, 'Search failed');
    }
  }

  if (req.method === 'GET' && pathname === '/api/stats') {
    try {
      permit('content:read');
      const stats = await cached(cacheKey(req.context.workspaceId, 'content-stats'), 30000, async () => {
        const rows = await documents.list(scope);
        const byDirectory = {};
        let totalWords = 0;
        for (const row of rows) {
          const words = (await documents.get(scope, row.path))?.markdown.split(/\s+/).filter(Boolean).length ?? 0;
          const directory = row.path.includes('/') ? row.path.split('/')[0] : '(root)';
          totalWords += words;
          byDirectory[directory] ??= {files: 0, words: 0};
          byDirectory[directory].files++;
          byDirectory[directory].words += words;
        }
        const references = await collection('plugin:bibliography:papers').count(scope);
        return {totalFiles: rows.length, totalWords, references, byDirectory};
      });
      return json(res, 200, stats, {cacheControl: 'private, max-age=30'});
    } catch (error) {
      return fail(json, res, error, 'Stats failed');
    }
  }
};

module.exports.documentTree = documentTree;
module.exports.directoryContents = directoryContents;
