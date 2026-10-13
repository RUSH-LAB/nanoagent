'use strict';
// Content, served from the database and compiled per request.
//
// A document is a row scoped by the RequestContext and compiled only when it
// is requested. That is what makes a page private, lets a newly-created
// workspace have pages immediately, and keeps workspace count out of the
// Docusaurus build. This module never touches the filesystem.
const {resolveWorkspaceSite} = require('../workspace-site');

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
    json, readBody, rateLimit, scopeFor, documents, compileDocument, compileMarkdown, parseFrontmatter, splitBlogPost, cached, invalidateCache, cacheKey,
    requireWorkspacePermission, workspaceSettings, githubUsers,
  } = ctx;

  // New clients use /api/workspaces/:id/documents. The dispatcher has already
  // resolved that id into req.context and exposes the suffix as workspacePath.
  // /api/content remains temporarily available while older callers migrate.
  const contentPath = req.context && req.workspacePath?.startsWith('/documents')
    ? `/api/content${req.workspacePath.slice('/documents'.length)}`
    : pathname;
  if (!contentPath.startsWith('/api/content')) return;

  const scope = scopeFor(req);
  let compileSettings;
  const settingsForCompile = async () => {
    if (compileSettings !== undefined) return compileSettings;
    compileSettings = req.context && workspaceSettings
      ? resolveWorkspaceSite(await workspaceSettings.get(req.context))
      : {};
    return compileSettings;
  };
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

  // A post's authors are GitHub usernames; the byline is each account's GitHub
  // profile. A username no account has comes back with only itself.
  const authorsOf = async ({authors = []}) => {
    const accounts = await githubUsers.byLogins(authors);
    return authors.map(login => {
      const account = accounts.get(login.toLowerCase());
      return account ? {login: account.login, name: account.name, image: account.image, bio: account.bio} : {login};
    });
  };

  const descriptionOf = markdown => {
    const body = splitBlogPost(markdown).excerpt
      .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
      .replace(/<!--([\s\S]*?)-->/g, '')
      .trim();
    const paragraph = body.split(/\r?\n\s*\r?\n/).find(block => {
      const value = block.trim();
      return value && !/^(?:#{1,6}\s|```|~~~|[-*+]\s|\d+[.)]\s|>|::|<[A-Z])/m.test(value);
    });
    if (!paragraph) return '';
    return paragraph
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<\/?[A-Za-z][^>]*>/g, '')
      .replace(/[`*_~]/g, '')
      .replace(/\$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  };

  // ── The tree: every document the caller may see, without their bodies ──
  //
  // Bodies are the whole cost of this read and a file tree renders none of
  // them, so the query does not select them. Titles come from a column derived
  // on write rather than from parsing several hundred documents per request.
  if (req.method === 'GET' && contentPath === '/api/content/tree') {
    try {
      permit('content:read');
      const include = url.searchParams.get('include');
      const includeFrontmatter = include === 'frontmatter' || include === 'metadata';
      const includeExcerpt = include === 'frontmatter';
      const prefix = String(url.searchParams.get('prefix') || '').replace(/^\/+|\/+$/g, '');
      // Private documents can differ by caller, so the derived cache includes
      // both immutable workspace id and verified user id. Mutations clear the
      // whole workspace prefix. This removes repeated Markdown compilation and
      // document reads while preserving membership/RLS checks on every request.
      const derivedKey = cacheKey && req.context?.workspaceId && req.context?.userId
        ? cacheKey(req.context.workspaceId, `content-tree:${req.context.userId}:${include || 'plain'}:${prefix}`)
        : null;
      const buildResponse = async () => {
        const rows = includeFrontmatter
          ? await documents.snapshot(scope, {prefix})
          : await documents.list(scope, {prefix});
        const settings = includeExcerpt ? await settingsForCompile() : {};
        return Promise.all(rows.map(async document => {
          const metadata = includeFrontmatter ? parseFrontmatter(document.markdown) : null;
          const blog = includeFrontmatter ? splitBlogPost(document.markdown) : null;
          const excerptTree = includeExcerpt ? await compileMarkdown(blog.excerpt, settings) : null;
          return {
            id: document.id,
            path: document.path,
            title: includeFrontmatter && documents.titleOf
              ? documents.titleOf(document.markdown, document.path)
              : document.title,
            visibility: document.visibility,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
            ...(includeFrontmatter ? {
              frontmatter: metadata,
              description: metadata.description || descriptionOf(document.markdown),
              ...(includeExcerpt ? {
                hasTruncateMarker: blog.hasTruncateMarker,
                excerptTree,
              } : {}),
              readingTime: Math.max(1, Math.ceil(document.markdown.split(/\s+/).filter(Boolean).length / 200)),
            } : {}),
          };
        }));
      };
      const response = derivedKey && cached
        ? await cached(derivedKey, 10 * 60_000, buildResponse)
        : await buildResponse();
      return json(res, 200, {documents: response});
    } catch (err) {
      return fail(json, res, err, 'Could not list the workspace');
    }
  }

  // ── Lightweight path/title search for file pickers ──
  if (req.method === 'GET' && contentPath === '/api/content/search') {
    try {
      permit('content:read');
      const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const searchKey = cacheKey && req.context?.workspaceId && req.context?.userId
        ? cacheKey(req.context.workspaceId, `document-list:${req.context.userId}`)
        : null;
      const rows = searchKey && cached
        ? await cached(searchKey, 10 * 60_000, () => documents.list(scope))
        : await documents.list(scope);
      const documentsFound = rows
        .filter(document => !query || [document.path, document.title].some(value =>
          String(value || '').toLowerCase().includes(query)))
        .slice(0, 100)
        .map(document => ({
          id: document.id,
          name: document.path.split('/').pop(),
          path: document.path,
          title: document.title,
          updatedAt: document.updatedAt,
        }));
      return json(res, 200, {documents: documentsFound});
    } catch (err) {
      return fail(json, res, err, 'Search failed');
    }
  }

  // ── Raw source for editors and comparison tools ──
  if (req.method === 'GET' && contentPath === '/api/content/source') {
    const path = url.searchParams.get('path');
    if (!path) return json(res, 400, {error: 'Missing path'});
    try {
      permit('content:read');
      const document = await documents.get(scope, path);
      return document
        ? json(res, 200, {document: {
            id: document.id,
            path: document.path,
            title: document.title,
            updatedAt: document.updatedAt,
          }, markdown: document.markdown})
        : json(res, 404, {error: 'Document not found'});
    } catch (err) {
      return fail(json, res, err, 'Invalid path');
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
      // on (handbook/intro) instead of the filename behind it. An exact
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
      tree = await compileDocument(document, await settingsForCompile());
    } catch (err) {
      // The compiler names the line, so this is worth passing on: a document
      // with broken MDX should say what is wrong rather than fail blankly.
      return json(res, 422, {error: `This document could not be rendered: ${err.message}`, code: 'mdx-error'});
    }
    const blog = splitBlogPost(document.markdown);
    const frontmatter = parseFrontmatter(document.markdown);
    return json(res, 200, {
      document: {
        id: document.id,
        path: document.path,
        title: documents.titleOf ? documents.titleOf(document.markdown, document.path) : document.title,
        visibility: document.visibility,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        hasTruncateMarker: blog.hasTruncateMarker,
        readingTime: Math.max(1, Math.ceil(document.markdown.split(/\s+/).filter(Boolean).length / 200)),
        description: frontmatter.description || descriptionOf(document.markdown),
      },
      markdown: document.markdown,
      frontmatter,
      authors: await authorsOf(frontmatter),
      tree,
    });
  }

  // ── Unsaved preview ──
  //
  // The editor sends source through the exact compiler used by the published
  // route. Nothing is persisted, and the browser still receives an inert tree
  // rather than executable MDX.
  if (req.method === 'POST' && contentPath === '/api/content/preview') {
    if (!await rateLimit(`content:${req.caller}`, 60)) {
      return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    }
    try {
      permit('content:edit');
      const body = await readBody(req);
      if (typeof body?.markdown !== 'string') {
        return json(res, 400, {error: 'markdown must be a string'});
      }
      return json(res, 200, {tree: await compileMarkdown(body.markdown, await settingsForCompile())});
    } catch (err) {
      if (err?.status && err?.code) return fail(json, res, err, 'Invalid request');
      return json(res, 422, {
        error: `This document could not be rendered: ${err.message}`,
        code: 'mdx-error',
      });
    }
  }

  // ── Create ──
  if (req.method === 'POST' && contentPath === '/api/content') {
    if (!await rateLimit(`content:${req.caller}`, 60)) {
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
    if (!await rateLimit(`content:${req.caller}`, 60)) {
      return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    }
    try {
      permit('content:edit');
      const body = await readBody(req);
      const {path, markdown, baseUpdatedAt} = body ?? {};
      if (!path) return json(res, 400, {error: 'Missing path'});
      if (typeof markdown !== 'string') return json(res, 400, {error: 'markdown must be a string'});
      let tree;
      try {
        tree = await compileMarkdown(markdown, await settingsForCompile());
      } catch (err) {
        return json(res, 422, {
          error: `This document could not be rendered: ${err.message}`,
          code: 'mdx-error',
        });
      }
      const saved = await documents.save(scope, path, markdown, {expectedUpdatedAt: baseUpdatedAt});
      if (!saved) return json(res, 404, {error: 'Document not found'});
      clearContentCaches();
      const frontmatter = parseFrontmatter(markdown);
      return json(res, 200, {
        success: true,
        document: {path: saved.path, title: saved.title, updatedAt: saved.updatedAt},
        version: saved.version,
        frontmatter,
        authors: await authorsOf(frontmatter),
        tree,
      });
    } catch (err) {
      if (err?.code === 'document-conflict') {
        return json(res, 409, {
          error: err.message,
          code: err.code,
          currentUpdatedAt: err.currentUpdatedAt,
        });
      }
      return fail(json, res, err, 'Invalid request');
    }
  }

  // ── Delete ──
  if (req.method === 'DELETE' && contentPath === '/api/content') {
    try {
      permit('content:delete');
      const body = await readBody(req);
      const {path, baseUpdatedAt} = body ?? {};
      if (!path) return json(res, 400, {error: 'Missing path'});
      if (!await documents.remove(scope, path, {expectedUpdatedAt: baseUpdatedAt})) {
        return json(res, 404, {error: 'Document not found'});
      }
      clearContentCaches();
      return json(res, 200, {success: true});
    } catch (err) {
      if (err?.code === 'document-conflict') {
        return json(res, 409, {error: err.message, code: err.code, currentUpdatedAt: err.currentUpdatedAt});
      }
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
      return json(res, 200, {success: true, document: {path: moved.path, title: moved.title, updatedAt: moved.updatedAt}});
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
