// Vercel serverless function: GET /api/files
// Lists files from the GitHub repo using the Git Trees API.

const { listTree, jsonResponse, optionsResponse, ALLOWED_EXTS } = require('./_github');

/**
 * Build a nested tree structure from the flat GitHub tree entries,
 * matching the format returned by server.js walkDir().
 *
 * Single insertion-ordered pass: each relevant blob is walked from `rootDir`
 * down its path segments, creating a directory node the first time a file is
 * seen under it and appending file nodes in place. Every entry's `.path` is
 * read at most once, so the work is O(files x depth) instead of the previous
 * O(files x directories) (each level used to re-scan the whole filtered list).
 */
function buildTree(entries, rootDir) {
  // Entries kept: blobs under rootDir with an allowed extension (unchanged).
  // Root seed mirrors the old buildLevel(rootDir || '') call: a falsy rootDir
  // yields the level prefix '/', which no content/... path starts with, so the
  // result is []. This preserves the rootDir === '' to [] edge case exactly.
  const rootPath = rootDir || '';
  const rootPrefix = rootPath + '/';

  const rootChildren = [];
  // Full directory path -> node, so each directory is created once and reused
  // (the old per-level `seen` set, hoisted to one map keyed by full path).
  const dirNodes = new Map();

  for (const e of entries) {
    if (e.type !== 'blob') continue;
    const entryPath = e.path;
    if (!ALLOWED_EXTS.some(ext => entryPath.endsWith(ext))) continue;
    if (!entryPath.startsWith(rootPrefix)) continue;

    const segments = entryPath.slice(rootPrefix.length).split('/');
    let children = rootChildren;
    let dirPath = rootPath;
    // Walk the intermediate directories, creating each on first encounter so it
    // lands at the position of the first file seen beneath it.
    const last = segments.length - 1;
    for (let i = 0; i < last; i++) {
      dirPath = dirPath + '/' + segments[i];
      let node = dirNodes.get(dirPath);
      if (!node) {
        node = { name: segments[i], path: dirPath, type: 'directory', children: [] };
        dirNodes.set(dirPath, node);
        children.push(node);
      }
      children = node.children;
    }
    // Append the file at its own position within its parent's children.
    children.push({
      name: segments[last],
      path: entryPath,
      type: 'file',
      size: e.size,
    });
  }

  return rootChildren;
}

module.exports = async function handler(req) {
  if (req.method === 'OPTIONS') return optionsResponse();

  if (req.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const url = new URL(req.url, 'http://localhost');
  const dir = url.searchParams.get('dir') || 'content';

  // Basic validation: must be within content and free of path traversal.
  // The `..` check mirrors `isValidFilePath` in ./_github.js and blocks a value
  // like `content/../secret` that would otherwise pass the `content/` prefix test.
  if ((dir !== 'content' && !dir.startsWith('content/')) || dir.includes('..')) {
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

// Exposed additively for unit tests; the default export stays the handler.
module.exports.buildTree = buildTree;
