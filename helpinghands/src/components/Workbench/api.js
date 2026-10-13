import API_BASE, {apiFetch, apiRequest} from '@site/src/utils/api';

/**
 * The workspace file system through /api/workspaces/:id/fs (src/server/routes/fs.js).
 * Each call resolves with the server's JSON or rejects with its error, whose
 * `code` says why: `stale-revision` when the file changed since it was read,
 * `fs-disabled` when this server still serves the legacy store.
 */

const query = path => `path=${encodeURIComponent(path)}`;
const TEXT = /^(text\/|application\/(json|yaml|javascript|x-))/;

const describe = node => ({
  id: node.id, path: node.path, size: node.size, rev: node.rev, access: node.access,
  accessExplicit: node.accessExplicit, updatedAt: node.updatedAt,
});

/** `{files, folders, nodes}` from the tree's nodes, folders included so empty ones show. */
export function listingOf(nodes) {
  return {
    nodes,
    files: nodes.filter(node => node.kind === 'file').map(describe),
    folders: nodes.filter(node => node.kind === 'folder').map(describe),
  };
}

export async function listFiles() {
  const {nodes} = await apiRequest('/api/fs/tree', undefined, {failureLabel: 'Could not load your workspace'});
  return listingOf(nodes);
}

/** A file's text and revision, or `{binary: true}` when it is not text. */
export async function readFile(path) {
  const response = await apiFetch(`${API_BASE}/api/fs/file?${query(path)}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Could not open ${path} (${response.status})`);
  }
  const rev = Number(response.headers.get('X-Rev'));
  if (!TEXT.test(response.headers.get('content-type') ?? '')) return {binary: true, rev};
  return {text: await response.text(), rev};
}

/** Every revision of `path`'s content, newest first, each `{seq, at, actorId, size}` among others. */
export async function history(path) {
  return (await apiRequest(`/api/fs/history?${query(path)}`, undefined, {failureLabel: `Could not list the revisions of ${path}`})).revisions;
}

/** The text of `path` as of its revision `seq`. */
export async function readRevision(path, seq) {
  const response = await apiFetch(`${API_BASE}/api/fs/revision?${query(path)}&seq=${seq}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Could not read that revision of ${path} (${response.status})`);
  }
  return response.text();
}

/** Save `text` at `path`. `baseRev` is the revision it was read at; `create` requires that nothing is there yet. */
export async function saveFile(path, text, {create = false, baseRev} = {}) {
  const revision = create ? 0 : baseRev;
  const {node} = await apiRequest(
    `/api/fs/file?${query(path)}${revision === undefined ? '' : `&baseRev=${revision}`}`,
    {method: 'PUT', headers: {'Content-Type': 'text/plain; charset=utf-8'}, body: text},
    {failureLabel: `Could not save ${path}`},
  );
  return describe(node);
}

const remove = path => apiRequest(`/api/fs/node?${query(path)}`, {method: 'DELETE'}, {failureLabel: `Could not delete ${path}`});
export const deleteFile = remove;
export const deleteFolder = remove;
export const makeFolder = path => apiRequest(`/api/fs/folder?${query(path)}`, {method: 'POST'}, {failureLabel: `Could not create ${path}`});
export const moveEntry = (from, to) => apiRequest('/api/fs/move', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({from, to}),
}, {failureLabel: `Could not move ${from}`});

/**
 * Who may see `path`: 'workspace', 'private', 'shared' (with `members`, by user
 * id), 'public', or null to follow its folder.
 */
export const setAccess = (path, access, members) => apiRequest('/api/fs/access', {
  method: 'PUT',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({path, access, ...(members ? {members} : {})}),
}, {failureLabel: `Could not change who can see ${path}`});

/** The workspace's members, `[{id, name, email}]`. */
export async function listMembers() {
  return (await apiRequest('/api/members', undefined, {failureLabel: 'Could not list the members'})).members;
}

/** The workspace's changes after `since` up to `until`, oldest first, from the change feed. */
export async function changesBetween(since, until) {
  const changes = [];
  for (let cursor = since; ;) {
    const page = await apiRequest(`/api/fs/changes?since=${cursor}`, undefined, {failureLabel: 'Could not read what changed in the workspace'});
    changes.push(...page.changes.filter(change => change.seq <= until));
    if (!page.more || page.cursor >= until) return changes;
    cursor = page.cursor;
  }
}

export async function listTrash() {
  return (await apiRequest('/api/fs/tree?deleted=1', undefined, {failureLabel: 'Could not load the trash'})).nodes;
}
export const restore = id => apiRequest('/api/fs/restore', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({id}),
}, {failureLabel: 'Could not restore it'});
export const emptyTrash = () => apiRequest('/api/fs/trash', {method: 'DELETE'}, {failureLabel: 'Could not empty the trash'});

/** Where the browser itself opens or downloads a file (images, PDFs, downloads). */
export const fileUrl = (workspaceId, path, {download = false} = {}) =>
  `${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/fs/file?${query(path)}${download ? '&download=1' : ''}`;
