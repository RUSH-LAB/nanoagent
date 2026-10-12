const path = require('path');

const CONTENT_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
});

function cleanAssetPath(value) {
  const input = String(value ?? '').replace(/^\.\//, '');
  if (!input || input.length > 500 || input.startsWith('/') || input.includes('\\')) return null;
  const parts = input.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  const extension = path.posix.extname(input).toLowerCase();
  return CONTENT_TYPES[extension] ? input : null;
}

function contentTypeForAsset(value) {
  const clean = cleanAssetPath(value);
  return clean ? CONTENT_TYPES[path.posix.extname(clean).toLowerCase()] : null;
}

function assetObjectKey(workspaceId, logicalPath, sha256) {
  const clean = cleanAssetPath(logicalPath);
  if (!clean || !/^[0-9a-f]{64}$/.test(String(sha256))) throw new TypeError('Invalid workspace asset');
  const encodedPath = clean.split('/').map(encodeURIComponent).join('/');
  return `${encodeURIComponent(String(workspaceId))}/content/${sha256}/${encodedPath}`;
}

module.exports = {CONTENT_TYPES, cleanAssetPath, contentTypeForAsset, assetObjectKey};
