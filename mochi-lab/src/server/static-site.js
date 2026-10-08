const fs = require('fs');
const path = require('path');

const TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

function inside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`) ? resolved : null;
}

function candidateFiles(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return []; }
  if (decoded.includes('\0')) return [];
  const relative = decoded.replace(/^\/+/, '');
  const direct = inside(root, path.join(root, relative));
  if (!direct) return [];
  const candidates = [direct];
  if (!path.extname(direct)) {
    candidates.push(`${direct}.html`, path.join(direct, 'index.html'));
  }
  // Docusaurus client routes such as /w/:slug/... have no per-workspace file.
  // The public shell is safe to serve; all data still comes from authenticated
  // workspace APIs after hydration.
  candidates.push(path.join(root, 'index.html'));
  return [...new Set(candidates)];
}

function serveStaticSite(req, res, {root, files = fs} = {}) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  for (const candidate of candidateFiles(root, new URL(req.url, 'http://localhost').pathname)) {
    let stat;
    try { stat = files.statSync(candidate); } catch { continue; }
    if (!stat.isFile()) continue;
    const body = files.readFileSync(candidate);
    const ext = path.extname(candidate).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': candidate.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
  return false;
}

module.exports = {serveStaticSite, candidateFiles, inside, TYPES};
