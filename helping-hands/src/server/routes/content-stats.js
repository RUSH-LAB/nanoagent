'use strict';

/** Workspace content totals derived from one scoped document snapshot. */
module.exports = async function content_stats_routes(req, res, _url, pathname, ctx) {
  if (req.method !== 'GET' || pathname !== '/api/stats') return;

  const {
    json, cached, cacheKey, scopeFor, documents, collection,
    requireWorkspacePermission,
  } = ctx;
  if (!req.context) return json(res, 404, {error: 'Workspace not found'});

  try {
    requireWorkspacePermission(req.context, 'content:read');
    const scope = scopeFor(req);
    const stats = await cached(
      cacheKey(scope.workspaceId, `content-stats:${scope.userId}`),
      30000,
      async () => {
        const rows = await documents.snapshot(scope);
        const byDirectory = {};
        let totalWords = 0;
        for (const row of rows) {
          const words = row.markdown.split(/\s+/).filter(Boolean).length;
          const directory = row.path.includes('/') ? row.path.split('/')[0] : '(root)';
          totalWords += words;
          byDirectory[directory] ??= {files: 0, words: 0};
          byDirectory[directory].files++;
          byDirectory[directory].words += words;
        }
        const references = await collection('plugin:bibliography:papers').count(scope);
        return {totalFiles: rows.length, totalWords, references, byDirectory};
      },
    );
    return json(res, 200, stats, {cacheControl: 'private, max-age=30'});
  } catch (error) {
    if (error?.status) {
      return json(res, error.status, {error: error.message, ...(error.code ? {code: error.code} : {})});
    }
    return json(res, 400, {error: 'Stats failed'});
  }
};
