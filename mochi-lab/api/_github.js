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

// ── GitHub Contents API helpers ──────────────────────────────────────────────

/**
 * Read a file from the repo.
 * Returns { content, sha, encoding } on success.
 */
async function getFile(filePath) {
  const { token, repo, branch } = getConfig();
  const url = `${GITHUB_API}/repos/${repo}/contents/${filePath}?ref=${branch}`;
  const res = await fetch(url, { headers: headers(token) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(err.message || `GitHub API error: ${res.status}`);
    error.status = res.status;
    throw error;
  }
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
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(err.message || `GitHub API error: ${res.status}`);
    error.status = res.status;
    throw error;
  }
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
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(err.message || `GitHub API error: ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/**
 * List the full file tree of the repo for a given branch.
 * Returns the array of tree entries from the Git Trees API.
 */
async function listTree(branch) {
  const { token, repo, branch: defaultBranch } = getConfig();
  const ref = branch || defaultBranch;
  const url = `${GITHUB_API}/repos/${repo}/git/trees/${ref}?recursive=1`;
  const res = await fetch(url, { headers: headers(token) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(err.message || `GitHub API error: ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

module.exports = {
  getConfig,
  getFile,
  putFile,
  deleteFile,
  listTree,
  jsonResponse,
  optionsResponse,
  CORS_HEADERS,
};
