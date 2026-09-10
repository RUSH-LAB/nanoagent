import API_BASE, {apiFetch, invalidateApiJson} from './api.js';
import {publishWorkspaceSite} from '../hooks/useWorkspaceSite.js';

export function replaceCollectionType(collections, type, replacements) {
  const queue = [...replacements];
  const next = [];
  for (const collection of collections || []) {
    if (collection.type === type) {
      if (queue.length) next.push(queue.shift());
    } else {
      next.push(collection);
    }
  }
  next.push(...queue);
  return next;
}

export async function saveWorkspaceCollections(workspace, site, collections) {
  if (!workspace?.id || !workspace?.slug || !site) throw new Error('Workspace settings are not ready');
  const url = `${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/site`;
  const response = await apiFetch(url, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({site: {...site, collections}}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not save workspace content settings');
  invalidateApiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/site`);
  publishWorkspaceSite(workspace.slug, data.site);
  return data.site;
}
