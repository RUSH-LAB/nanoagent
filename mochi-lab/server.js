const http = require('http');
const fs = require('fs');
const path = require('path');
const {URL} = require('url');

const PROJECT_ROOT = __dirname;
const ALLOWED_EXTS = ['.md', '.mdx'];
const PORT = process.env.EDITOR_PORT || 3001;

function isValidFilePath(filePath) {
  if (!filePath) return false;
  const normalized = path.normalize(filePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  if (!normalized.startsWith('content/') && !normalized.startsWith('content' + path.sep)) return false;
  if (!ALLOWED_EXTS.some(ext => normalized.endsWith(ext))) return false;
  return true;
}

function isValidDir(dirPath) {
  if (!dirPath) return false;
  const normalized = path.normalize(dirPath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  return normalized === 'content' || normalized.startsWith('content/') || normalized.startsWith('content' + path.sep);
}

function walkDir(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(PROJECT_ROOT, fullPath);
    if (entry.isDirectory()) {
      result.push({name: entry.name, path: relPath, type: 'directory', children: walkDir(fullPath)});
    } else if (ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))) {
      result.push({name: entry.name, path: relPath, type: 'file'});
    }
  }
  return result;
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return json(res, 204, null);
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/file') {
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
    const fullPath = path.join(PROJECT_ROOT, filePath);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      return json(res, 200, {content});
    } catch {
      return json(res, 404, {error: 'File not found'});
    }
  }

  if (req.method === 'PUT' && pathname === '/api/file') {
    try {
      const body = await readBody(req);
      const {path: filePath, content} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      if (typeof content !== 'string') return json(res, 400, {error: 'Content must be a string'});
      const fullPath = path.join(PROJECT_ROOT, filePath);
      if (!fs.existsSync(fullPath)) return json(res, 404, {error: 'File not found'});
      fs.writeFileSync(fullPath, content, 'utf-8');
      return json(res, 200, {success: true});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'POST' && pathname === '/api/file') {
    try {
      const body = await readBody(req);
      const {path: filePath, content} = body;
      if (!isValidFilePath(filePath)) return json(res, 400, {error: 'Invalid path'});
      if (typeof content !== 'string') return json(res, 400, {error: 'Content must be a string'});
      const fullPath = path.join(PROJECT_ROOT, filePath);
      if (fs.existsSync(fullPath)) return json(res, 409, {error: 'File already exists'});
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(fullPath, content, 'utf-8');
      return json(res, 200, {success: true, path: filePath});
    } catch {
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'GET' && pathname === '/api/files') {
    const dir = url.searchParams.get('dir') || 'content';
    if (!isValidDir(dir)) return json(res, 400, {error: 'Invalid directory'});
    const fullDir = path.join(PROJECT_ROOT, dir);
    try {
      return json(res, 200, {files: walkDir(fullDir)});
    } catch {
      return json(res, 404, {error: 'Directory not found'});
    }
  }

  json(res, 404, {error: 'Not found'});
});

server.listen(PORT, () => {
  console.log(`Editor API running on http://localhost:${PORT}`);
});
