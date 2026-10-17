'use strict';

/**
 * A plugin's source on GitHub, for the marketplace (routes/market.js): a public
 * repository's URL, the commit it names, and that commit's archive. Pinning the
 * commit means a listing is exactly what was checked, whatever the branch does
 * after.
 *
 *   https://github.com/{owner}/{repo}                        the default branch, at its root
 *   https://github.com/{owner}/{repo}/tree/{ref}/{folder...} a branch, tag or commit, at a folder
 *
 * A ref is one path segment, so a branch whose name holds '/' is named by its commit.
 */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
// NanoAgent's SOURCE_MAX_BYTES: the largest archive it packs a plugin from.
const ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 30000;

/** `{owner, repo, ref, path}` from a GitHub URL, or null. */
function parseRepositoryUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.search || url.hash) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2) parts[1] = parts[1].replace(/\.git$/, '');
  if (parts.length < 2 || (parts.length > 2 && (parts[2] !== 'tree' || parts.length < 4))) return null;
  if (!parts.every(part => SEGMENT.test(part) && part !== '.' && part !== '..')) return null;
  const [owner, repo, , ref = 'HEAD', ...folder] = parts;
  return {owner, repo, ref, path: folder.join('/')};
}

/** The body of `response`, refusing one past `limit` bytes as it arrives. */
async function readLimited(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function createGithub({fetchImpl = (...args) => fetch(...args)} = {}) {
  const get = (url, accept) => fetchImpl(url, {
    headers: {Accept: accept, 'User-Agent': 'mochi-marketplace'},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  return Object.freeze({
    parseRepositoryUrl,
    /**
     * The repository at `url`: `{value: {repository, archive}}`, where
     * `repository` adds the `commit` its ref named, otherwise `{error, status}`.
     */
    async source(url) {
      const named = parseRepositoryUrl(url);
      if (!named) {
        return {error: 'Give a GitHub repository URL: https://github.com/<owner>/<repo>, or …/tree/<branch>/<folder>', status: 400};
      }
      const {owner, repo, ref} = named;
      try {
        const resolved = await get(`https://api.github.com/repos/${owner}/${repo}/commits/${ref}`, 'application/vnd.github.sha');
        if ([404, 422].includes(resolved.status)) return {error: `GitHub has no public repository ${owner}/${repo} with ${ref}`, status: 404};
        if (!resolved.ok) return {error: `GitHub refused to name the commit (${resolved.status}); try again later`, status: 502};
        const commit = (await resolved.text()).trim();
        if (!COMMIT.test(commit)) return {error: 'GitHub named no commit', status: 502};
        const download = await get(`https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}`, 'application/gzip');
        if (!download.ok) return {error: `GitHub refused the repository archive (${download.status})`, status: 502};
        const archive = await readLimited(download, ARCHIVE_MAX_BYTES);
        if (!archive) return {error: `The repository archive is over ${ARCHIVE_MAX_BYTES / 1024 / 1024} MB`, status: 413};
        return {value: {repository: {...named, commit}, archive}};
      } catch {
        return {error: 'Could not reach GitHub', status: 502};
      }
    },
    /**
     * Whether `repository`'s ref has changed its folder since `repository.commit`:
     * `{value: commit}`, the newest commit that changed it, or `{value: null}`, otherwise `{error, status}`.
     */
    async newer({owner, repo, ref, path, commit}) {
      const base = `https://api.github.com/repos/${owner}/${repo}`;
      try {
        const touched = await get(`${base}/commits?sha=${encodeURIComponent(ref)}${path ? `&path=${encodeURIComponent(path)}` : ''}&per_page=1`, 'application/vnd.github+json');
        if (!touched.ok) return {error: `GitHub refused to list the commits (${touched.status}); try again later`, status: 502};
        const [latest] = await touched.json();
        if (!latest || latest.sha === commit) return {value: null};
        const compared = await get(`${base}/compare/${commit}...${latest.sha}`, 'application/vnd.github+json');
        if (!compared.ok) return {error: `GitHub refused to compare the commits (${compared.status}); try again later`, status: 502};
        // 'ahead': the newest change comes after the commit published; otherwise the commit holds it.
        return {value: (await compared.json()).status === 'ahead' ? latest.sha : null};
      } catch {
        return {error: 'Could not reach GitHub', status: 502};
      }
    },
  });
}

module.exports = {createGithub, parseRepositoryUrl, ARCHIVE_MAX_BYTES};
