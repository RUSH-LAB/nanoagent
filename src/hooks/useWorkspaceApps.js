import {useEffect, useState} from 'react';
import API_BASE, {apiJson} from '@site/src/utils/api';

/**
 * The NanoAgent apps a workspace can open: `{apps, error}`, with `apps` null
 * until they arrive, from a briefly cached read.
 */
export default function useWorkspaceApps(workspace) {
  const [state, setState] = useState({workspaceId: null, apps: null, error: null});
  const workspaceId = workspace?.id ?? null;

  useEffect(() => {
    if (!workspaceId) return undefined;
    let cancelled = false;
    apiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/apps`, {cacheMs: 60_000})
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
  }, [workspaceId]);

  return state.workspaceId === workspaceId ? state : {workspaceId, apps: null, error: null};
}
