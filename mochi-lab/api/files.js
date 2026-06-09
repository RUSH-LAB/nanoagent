// Vercel serverless function: GET /api/files
// Lists files from the GitHub repo using the Git Trees API.

const { listTree, jsonResponse, optionsResponse } = require('./_github');

const ALLOWED_EXTS = ['.md', '.mdx'];

/**
 * Build a nested tree structure from the flat GitHub tree entries,
 * matching the format returned by server.js walkDir().
 */
function buildTree(entries, rootDir) {
  // Filter to entries under rootDir that are blobs with allowed extensions.
  const prefix = rootDir ? rootDir + '/' : '';
  const relevant = entries.filter(e => {
    if (e.type !== 'blob') return false;
    if (!e.path.startsWith(prefix)) return false;
    return ALLOWED_EXTS.some(ext => e.path.endsWith(ext));
  });

  // Also collect directories that contain relevant files.
  const dirs = new Set();
  for (const e of entries) {
    if (e.type === 'tree' && e.path.startsWith(prefix)) {
      dirs.add(e.path);
    }
  }

  // Build nested structure.
  function buildLevel(dirPath) {
    const children = [];
    const seen = new Set();
    const levelPrefix = dirPath + '/';

    for (const e of relevant) {
      if (!e.path.startsWith(levelPrefix)) continue;
      const rest = e.path.slice(levelPrefix.length);
      if (rest.includes('/')) {
        // This file is inside a subdirectory at this level.
        const subDir = rest.split('/')[0];
        const subDirPath = dirPath + '/' + subDir;
        if (!seen.has(subDirPath)) {
          seen.add(subDirPath);
          children.push({
            name: subDir,
            path: subDirPath,
            type: 'directory',
            children: buildLevel(subDirPath),
          });
        }
      } else {
        children.push({
          name: rest,
          path: e.path,
          type: 'file',
          size: e.size,
        });
      }
    }

    return children;
  }

  return buildLevel(rootDir || '');
}

module.exports = async function handler(req) {
  if (req.method === 'OPTIONS') return optionsResponse();

  if (req.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const url = new URL(req.url, 'http://localhost');
  const dir = url.searchParams.get('dir') || 'content';

  // Basic validation: must be within content.
  if (dir !== 'content' && !dir.startsWith('content/')) {
    return jsonResponse(400, { error: 'Invalid directory' });
  }

  try {
    const treeData = await listTree();
    const files = buildTree(treeData.tree || [], dir);
    return jsonResponse(200, { files });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
