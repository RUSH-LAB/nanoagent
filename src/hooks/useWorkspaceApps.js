import {useEffect, useState} from 'react';
import API_BASE, {apiJson} from '@site/src/utils/api';

/**
 * The NanoAgent apps a workspace can open, for the navbar's Plugins menu.
 *
 * A failed read leaves the menu empty rather than raising it in the chrome:
 * the menu still links to the apps page, which reports the same error in full.
 */
export default function useWorkspaceApps(workspace) {
  const [apps, setApps] = useState({workspaceId: null, list: []});
  const workspaceId = workspace?.id ?? null;

  useEffect(() => {
    if (!workspaceId) return undefined;
    let cancelled = false;
    apiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/apps`, {cacheMs: 60_000})
      .then(result => {
        if (!cancelled) setApps({workspaceId, list: result.ok ? result.data.apps : []});
      })
      .catch(() => {
        if (!cancelled) setApps({workspaceId, list: []});
      });
    return () => { cancelled = true; };
  }, [workspaceId]);

  return apps.workspaceId === workspaceId ? apps.list : [];
}
