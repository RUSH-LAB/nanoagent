'use strict';

/**
 * What anyone may read, signed in or not, at /api/public/:slug/…:
 *
 *   GET  /api/public/:slug                       the workspace's name and site layout
 *   GET  /api/public/:slug/documents…            the document routes (routes/content.js), read-only
 *   GET  /api/public/:slug/fs/tree?prefix=       public nodes
 *   GET  /api/public/:slug/fs/file?path=         a public file's bytes
 *
 * Only nodes whose access is `public` exist here: the reader runs with no user,
 * so row-level security hides everything else, and a workspace that publishes
 * nothing is not found at all. The document routes run unchanged, as a viewer
 * with no identity, over a repository that can only read.
 */
const {resolveWorkspaceSite} = require('../workspace-site');
const {createPublicDocuments} = require('../fs/documents');
const contentRoutes = require('./content');

const ROUTE = /^\/api\/public\/([^/]+)(\/.*)?$/;

module.exports = async function public_routes(req, res, url, pathname, ctx) {
  const match = ROUTE.exec(pathname);
  if (!match) return;
  const {json, publicFs} = ctx;
  if (req.method !== 'GET') return json(res, 405, {error: 'Public content is read-only'});
  if (!publicFs) {
    return json(res, 409, {
      error: 'Publishing needs the workspace file system (CONTENT_STORE=fs)', code: 'fs-disabled',
    });
  }
  let slug;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    return json(res, 404, {error: 'Not found'});
  }
  const workspace = await publicFs.workspace(slug);
  if (!workspace) return json(res, 404, {error: 'Not found'});
  const rest = match[2] || '/';

  if (rest === '/') {
    return json(res, 200, {
      workspace: {id: workspace.id, name: workspace.name, slug: workspace.slug},
      site: resolveWorkspaceSite(workspace.site),
    });
  }

  if (rest === '/fs/tree') {
    try {
      return json(res, 200, {nodes: await publicFs.list(workspace.id, {prefix: url.searchParams.get('prefix')})});
    } catch (error) {
      if (error.status && error.code) return json(res, error.status, {error: error.message, code: error.code});
      throw error;
    }
  }

  if (rest === '/fs/file') {
    let found;
    try {
      found = await publicFs.read(workspace.id, url.searchParams.get('path'));
    } catch (error) {
      if (error.status && error.code) return json(res, error.status, {error: error.message, code: error.code});
      throw error;
    }
    if (!found) return json(res, 404, {error: 'Not found'});
    res.writeHead(200, {
      'Content-Type': found.node.contentType || 'application/octet-stream',
      'Content-Length': found.body.length,
      'Cache-Control': 'public, max-age=60',
      'ETag': `"${found.node.rev}"`,
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(found.body);
  }

  if (rest === '/documents' || rest.startsWith('/documents/')) {
    // A viewer with no identity: the content routes check permissions and scope
    // from this, and the repository below can only read public documents.
    req.context = {workspaceId: workspace.id, workspaceSlug: workspace.slug, userId: null, role: 'viewer', public: true};
    req.workspacePath = rest;
    return contentRoutes(req, res, url, `/api/content${rest.slice('/documents'.length)}`, {
      ...ctx,
      scopeFor: request => request.context,
      documents: createPublicDocuments({publicFs, workspaceId: workspace.id}),
      workspaceSettings: {get: async () => workspace.site},
    });
  }

  return json(res, 404, {error: 'Not found'});
};
