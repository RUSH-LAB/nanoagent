'use strict';
// Content, served from the database and compiled per request.
//
// A document is a row scoped by the RequestContext and compiled only when it
// is requested. That is what makes a page private, lets a newly-created
// workspace have pages immediately, and keeps workspace count out of the
// Docusaurus build. This module never touches the filesystem.

/** Turn a thrown status error into the response it describes. */
function fail(json, res, err, fallback) {
  if (err?.status && err?.code) return json(res, err.status, {error: err.message, code: err.code});
  return json(res, 400, {error: fallback});
}

module.exports = async function content_routes(req, res, url, pathname, ctx) {
  // documents and compileDocument come through ctx like every other dependency
  // a route module needs, so a test drives a throwaway database and its own
  // compiler rather than the real ones.
  const {
    json, readBody, rateLimit, scopeFor, documents, compileDocument, invalidateCache, cacheKey,
    requireWorkspacePermission,
  } = ctx;

  // New clients use /api/workspaces/:id/documents. The dispatcher has already
  // resolved that id into req.context and exposes the suffix as workspacePath.
  // /api/content remains temporarily available while older callers migrate.
  const contentPath = req.context && req.workspacePath?.startsWith('/documents')
    ? `/api/content${req.workspacePath.slice('/documents'.length)}`
    : pathname;
  if (!contentPath.startsWith('/api/content')) return;

  const scope = scopeFor(req);
  const clearContentCaches = () => {
    if (!req.context || !invalidateCache || !cacheKey) return;
    // A document mutation changes every derived view: feeds, sitemap, graph,
    // search, statistics, lint, related pages, and any future workspace cache.
    // Clearing the immutable workspace prefix is safer than maintaining a list
    // that inevitably misses a new derived cache.
    invalidateCache(cacheKey(req.context.workspaceId, ''));
  };
  const permit = permission => {
    if (req.context && requireWorkspacePermission) {
      requireWorkspacePermission(req.context, permission);
    }
  };

  // ── The tree: every document the caller may see, without their bodies ──
  //
  // Bodies are the whole cost of this read and a file tree renders none of
  // them, so the query does not select them. Titles come from a column derived
  // on write rather than from parsing several hundred documents per request.
  if (req.method === 'GET' && contentPath === '/api/content/tree') {
    try {
      permit('content:read');
      return json(res, 200, {documents: await documents.list(scope)});
    } catch (err) {
      return fail(json, res, err, 'Could not list the workspace');
    }
  }

  // ── One document, compiled ──
  //
  // The compiled body rather than the markdown, because the client renders it
  // through the site's own component registry and never sees a `<script>`. The
  // markdown comes too, for the editor, which is the one caller that wants the
  // source.
  if (req.method === 'GET' && contentPath === '/api/content') {
    const path = url.searchParams.get('path');
    if (!path) return json(res, 400, {error: 'Missing path'});
    let document;
    try {
      permit('content:read');
      // `resolve` rather than `get`, so a reader may ask for the URL they are
      // on (books/math/0-intro) instead of the filename behind it. An exact
      // path still matches first.
      document = await documents.resolve(scope, path);
    } catch (err) {
      return fail(json, res, err, 'Invalid path');
    }
    // The same answer for a document that is not there and one the caller may
    // not read. Distinguishing them tells an outsider which private pages
    // exist, which is most of what a private page is hiding.
    if (!document) return json(res, 404, {error: 'Document not found'});

    let tree;
    try {
      tree = await compileDocument(document);
    } catch (err) {
      // The compiler names the line, so this is worth passing on: a document
      // with broken MDX should say what is wrong rather than fail blankly.
      return json(res, 422, {error: `This document could not be rendered: ${err.message}`, code: 'mdx-error'});
    }
    return json(res, 200, {
      document: {
        id: document.id,
        path: document.path,
        title: document.title,
        visibility: document.visibility,
        updatedAt: document.updatedAt,
      },
      markdown: document.markdown,
      tree,
    });
  }

  // ── Create ──
  if (req.method === 'POST' && contentPath === '/api/content') {
    if (!rateLimit(`content:${req.socket.remoteAddress}`, 60)) {
      return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    }
    try {
      permit('content:create');
      const body = await readBody(req);
      const {path, markdown = '', visibility} = body ?? {};
      const created = await documents.create(scope, {
        path,
        markdown,
        ...(visibility === undefined ? {} : {visibility}),
      });
      clearContentCaches();
      return json(res, 201, {success: true, document: created});
    } catch (err) {
      return fail(json, res, err, 'Invalid request');
    }
  }

  // ── Save ──
  if (req.method === 'PUT' && contentPath === '/api/content') {
    if (!rateLimit(`content:${req.socket.remoteAddress}`, 60)) {
      return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    }
    try {
      permit('content:edit');
      const body = await readBody(req);
      const {path, markdown} = body ?? {};
      if (!path) return json(res, 400, {error: 'Missing path'});
      if (typeof markdown !== 'string') return json(res, 400, {error: 'markdown must be a string'});
      const saved = await documents.save(scope, path, markdown);
      if (!saved) return json(res, 404, {error: 'Document not found'});
      clearContentCaches();
      return json(res, 200, {
        success: true,
        document: {path: saved.path, title: saved.title, updatedAt: saved.updatedAt},
        version: saved.version,
      });
    } catch (err) {
      return fail(json, res, err, 'Invalid request');
    }
  }

  // ── Delete ──
  if (req.method === 'DELETE' && contentPath === '/api/content') {
    try {
      permit('content:delete');
      const body = await readBody(req);
      const {path} = body ?? {};
      if (!path) return json(res, 400, {error: 'Missing path'});
      if (!await documents.remove(scope, path)) return json(res, 404, {error: 'Document not found'});
      clearContentCaches();
      return json(res, 200, {success: true});
    } catch (err) {
      return fail(json, res, err, 'Invalid request');
    }
  }

  // ── Move ──
  if (req.method === 'POST' && contentPath === '/api/content/move') {
    try {
      permit('content:edit');
      const body = await readBody(req);
      const {from, to} = body ?? {};
      if (!from || !to) return json(res, 400, {error: 'Both from and to are required'});
      const moved = await documents.move(scope, from, to);
      if (!moved) return json(res, 404, {error: 'Document not found'});
      clearContentCaches();
      return json(res, 200, {success: true, document: {path: moved.path, title: moved.title}});
    } catch (err) {
      return fail(json, res, err, 'Invalid request');
    }
  }

  // ── Who may read it ──
  if (req.method === 'PUT' && contentPath === '/api/content/visibility') {
    try {
      permit('content:publish');
      const body = await readBody(req);
      const {path, visibility} = body ?? {};
      if (!path) return json(res, 400, {error: 'Missing path'});
      const changed = await documents.setVisibility(scope, path, visibility);
      if (!changed) return json(res, 404, {error: 'Document not found'});
      clearContentCaches();
      return json(res, 200, {success: true, visibility: changed.visibility});
    } catch (err) {
      return fail(json, res, err, 'Invalid request');
    }
  }

  // ── History ──
  //
  // Every save keeps what it replaced, so this is a list rather than the set of
  // named snapshots the file version offered. The bodies are left out; one is
  // fetched by asking for a version.
  if (req.method === 'GET' && contentPath === '/api/content/versions') {
    const path = url.searchParams.get('path');
    if (!path) return json(res, 400, {error: 'Missing path'});
    try {
      permit('content:read');
      const seq = url.searchParams.get('seq');
      if (seq !== null) {
        const one = await documents.version(scope, path, Number(seq));
        if (!one) return json(res, 404, {error: 'Version not found'});
        return json(res, 200, {version: one});
      }
      const history = await documents.versions(scope, path);
      if (!history) return json(res, 404, {error: 'Document not found'});
      return json(res, 200, {versions: history});
    } catch (err) {
      return fail(json, res, err, 'Invalid path');
    }
  }
};
