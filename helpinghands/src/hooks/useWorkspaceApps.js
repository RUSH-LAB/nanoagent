import {useEffect, useState} from 'react';
import API_BASE, {apiFetch, apiJson, invalidateApiJson} from '@site/src/utils/api';

export const workspaceAppsUrl = workspaceId => `${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/apps`;

// The event that has each useWorkspaceApps of a workspace read its list again (forgetWorkspaceApps).
const FORGOTTEN = 'rush:workspace-apps';

/** Forget the cached list, after the member installed, updated or uninstalled a plugin, and read it again where it is shown. */
export function forgetWorkspaceApps(workspaceId) {
  invalidateApiJson(workspaceAppsUrl(workspaceId));
  window.dispatchEvent(new CustomEvent(FORGOTTEN, {detail: workspaceId}));
}

// The workspaces this tab already asked to prepare.
const prepared = new Set();

/**
 * Have the server install the member's plugins ahead of their first open:
 * once per tab when a workspace is entered, and again with `again` after they
 * install one. The server answers at once and installs in the background.
 */
export function prepareWorkspaceApps(workspaceId, {again = false} = {}) {
  if (!workspaceId || (prepared.has(workspaceId) && !again)) return;
  prepared.add(workspaceId);
  apiFetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/app-installs`, {method: 'POST'}).catch(() => {});
}

/**
 * The plugins the member installed from the marketplace: `{apps, error}`, with
 * `apps` null until they arrive, from a briefly cached read, read again when forgotten
 * (forgetWorkspaceApps), the last list kept meanwhile.
 */
export default function useWorkspaceApps(workspace) {
  const [state, setState] = useState({workspaceId: null, apps: null, error: null});
  const [reads, setReads] = useState(0);
  const workspaceId = workspace?.id ?? null;

  useEffect(() => {
    const forgotten = event => event.detail === workspaceId && setReads(count => count + 1);
    window.addEventListener(FORGOTTEN, forgotten);
    return () => window.removeEventListener(FORGOTTEN, forgotten);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return undefined;
    let cancelled = false;
    apiJson(workspaceAppsUrl(workspaceId), {cacheMs: 60_000})
      .then(result => {
        if (cancelled) return;
        setState(result.ok
          ? {workspaceId, apps: result.data.apps, error: null}
          : {workspaceId, apps: null, error: result.data.error || `Could not load apps (${result.status})`});
      })
      .catch(() => {
        if (!cancelled) setState({workspaceId, apps: null, error: 'Could not reach the API server'});
      });
    return () => { cancelled = true; };
  }, [workspaceId, reads]);

  return state.workspaceId === workspaceId ? state : {workspaceId, apps: null, error: null};
}
