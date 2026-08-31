'use strict';
// Content, served from the database and compiled per request.
//
// The endpoints under /api/file read and write the workspace's files on disk,
// and Docusaurus compiles those same files at build time. These do neither: a
// document is a row, the caller's session decides which rows exist for them,
// and the MDX is compiled when it is asked for. That is what makes a page
// private, what lets a workspace created a minute ago have pages, and what
// takes the number of workspaces out of the build.
//
// The two live side by side while content is imported rather than moved. This
// module never touches the filesystem.

/** Turn a thrown status error into the response it describes. */
function fail(json, res, err, fallback) {
  if (err?.status && err?.code) return json(res, err.status, {error: err.message, code: err.code});
  return json(res, 400, {error: fallback});
}

module.exports = async function content_routes(req, res, url, pathname, ctx) {
  // documents and compileDocument come through ctx like every other dependency
  // a route module needs, so a test drives a throwaway database and its own
  // compiler rather than the real ones.
  const {json, readBody, rateLimit, scopeFor, documents, compileDocument} = ctx;
  if (!pathname.startsWith('/api/content')) return;

  const scope = scopeFor(req);

  // ── The tree: every document the caller may see, without their bodies ──
  //
  // Bodies are the whole cost of this read and a file tree renders none of
  // them, so the query does not select them. Titles come from a column derived
  // on write rather than from parsing several hundred documents per request.
  if (req.method === 'GET' && pathname === '/api/content/tree') {
    try {
      return json(res, 200, {documents: documents.list(scope)});
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
  if (req.method === 'GET' && pathname === '/api/content') {
    const path = url.searchParams.get('path');
    if (!path) return json(res, 400, {error: 'Missing path'});
    let document;
    try {
      // `resolve` rather than `get`, so a reader may ask for the URL they are
      // on (books/math/0-intro) instead of the filename behind it. An exact
      // path still matches first.
      document = documents.resolve(scope, path);
    } catch (err) {
      return fail(json, res, err, 'Invalid path');
    }
    // The same answer for a document that is not there and one the caller may
    // not read. Distinguishing them tells an outsider which private pages
    // exist, which is most of what a private page is hiding.
    if (!document) return json(res, 404, {error: 'Document not found'});

    let code;
    try {
      code = await compileDocument(document);
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
      code,
    });
  }

  // ── Create ──
  if (req.method === 'POST' && pathname === '/api/content') {
    if (!rateLimit(`content:${req.socket.remoteAddress}`, 60)) {
      return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    }
    try {
      const body = await readBody(req);
      const {path, markdown = '', visibility} = body ?? {};
      const created = documents.create(scope, {
        path,
        markdown,
        ...(visibility === undefined ? {} : {visibility}),
      });
      return json(res, 201, {success: true, document: created});
    } catch (err) {
      return fail(json, res, err, 'Invalid request');
    }
  }

  // ── Save ──
  if (req.method === 'PUT' && pathname === '/api/content') {
    if (!rateLimit(`content:${req.socket.remoteAddress}`, 60)) {
      return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    }
    try {
      const body = await readBody(req);
      const {path, markdown} = body ?? {};
      if (!path) return json(res, 400, {error: 'Missing path'});
      if (typeof markdown !== 'string') return json(res, 400, {error: 'markdown must be a string'});
      const saved = documents.save(scope, path, markdown);
      if (!saved) return json(res, 404, {error: 'Document not found'});
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
  if (req.method === 'DELETE' && pathname === '/api/content') {
    try {
      const body = await readBody(req);
      const {path} = body ?? {};
      if (!path) return json(res, 400, {error: 'Missing path'});
      if (!documents.remove(scope, path)) return json(res, 404, {error: 'Document not found'});
      return json(res, 200, {success: true});
    } catch (err) {
      return fail(json, res, err, 'Invalid request');
    }
  }

  // ── Move ──
  if (req.method === 'POST' && pathname === '/api/content/move') {
    try {
      const body = await readBody(req);
      const {from, to} = body ?? {};
      if (!from || !to) return json(res, 400, {error: 'Both from and to are required'});
      const moved = documents.move(scope, from, to);
      if (!moved) return json(res, 404, {error: 'Document not found'});
      return json(res, 200, {success: true, document: {path: moved.path, title: moved.title}});
    } catch (err) {
      return fail(json, res, err, 'Invalid request');
    }
  }

  // ── Who may read it ──
  if (req.method === 'PUT' && pathname === '/api/content/visibility') {
    try {
      const body = await readBody(req);
      const {path, visibility} = body ?? {};
      if (!path) return json(res, 400, {error: 'Missing path'});
      const changed = documents.setVisibility(scope, path, visibility);
      if (!changed) return json(res, 404, {error: 'Document not found'});
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
  if (req.method === 'GET' && pathname === '/api/content/versions') {
    const path = url.searchParams.get('path');
    if (!path) return json(res, 400, {error: 'Missing path'});
    try {
      const seq = url.searchParams.get('seq');
      if (seq !== null) {
        const one = documents.version(scope, path, Number(seq));
        if (!one) return json(res, 404, {error: 'Version not found'});
        return json(res, 200, {version: one});
      }
      const history = documents.versions(scope, path);
      if (!history) return json(res, 404, {error: 'Document not found'});
      return json(res, 200, {versions: history});
    } catch (err) {
      return fail(json, res, err, 'Invalid path');
    }
  }
};
