// Shared GitHub API helpers for Vercel serverless functions.
// All functions use fetch() with no external dependencies.

const GITHUB_API = 'https://api.github.com';

function getConfig() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'zeyuyang8/mochi-lab';
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token) {
    throw new Error('GITHUB_TOKEN environment variable is not set');
  }
  return { token, repo, branch };
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

// CORS headers applied to every response.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function optionsResponse() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ── Path validation ──────────────────────────────────────────────────────────

const ALLOWED_EXTS = ['.md', '.mdx'];

function isValidFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  if (filePath.includes('..') || filePath.startsWith('/')) return false;
  if (!filePath.startsWith('content/')) return false;
  if (!ALLOWED_EXTS.some(ext => filePath.endsWith(ext))) return false;
  return true;
}

// ── GitHub Contents API helpers ──────────────────────────────────────────────

/**
 * Throw a descriptive Error when a GitHub API response is not OK.
 * Reads the error body for a message and attaches the HTTP status code.
 */
async function throwIfNotOk(res) {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(err.message || `GitHub API error: ${res.status}`);
    error.status = res.status;
    throw error;
  }
}

/**
 * Read a file from the repo.
 * Returns { content, sha, encoding } on success.
 */
async function getFile(filePath) {
  const { token, repo, branch } = getConfig();
  const url = `${GITHUB_API}/repos/${repo}/contents/${filePath}?ref=${branch}`;
  const res = await fetch(url, { headers: headers(token) });
  await throwIfNotOk(res);
  return res.json();
}

/**
 * Create or update a file in the repo.
 * If `sha` is provided the file is updated; otherwise it is created.
 */
async function putFile(filePath, content, message, sha) {
  const { token, repo, branch } = getConfig();
  const url = `${GITHUB_API}/repos/${repo}/contents/${filePath}`;
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify(body),
  });
  await throwIfNotOk(res);
  return res.json();
}

/**
 * Delete a file from the repo.
 */
async function deleteFile(filePath, sha, message) {
  const { token, repo, branch } = getConfig();
  const url = `${GITHUB_API}/repos/${repo}/contents/${filePath}`;
  const body = { message, sha, branch };

  const res = await fetch(url, {
    method: 'DELETE',
    headers: headers(token),
    body: JSON.stringify(body),
  });
  await throwIfNotOk(res);
  return res.json();
}

/**
 * List the full file tree of the repo for the configured branch.
 * Returns the array of tree entries from the Git Trees API.
 */
async function listTree() {
  const { token, repo, branch } = getConfig();
  const url = `${GITHUB_API}/repos/${repo}/git/trees/${branch}?recursive=1`;
  const res = await fetch(url, { headers: headers(token) });
  await throwIfNotOk(res);
  return res.json();
}

module.exports = {
  getConfig,
  headers,
  GITHUB_API,
  ALLOWED_EXTS,
  isValidFilePath,
  getFile,
  putFile,
  deleteFile,
  listTree,
  jsonResponse,
  optionsResponse,
};
