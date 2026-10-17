import {useEffect, useState} from 'react';
import API_BASE, {apiJson} from '@site/src/utils/api';

/**
 * The drafts on the member's computer, the plugins they are making there that
 * its RUSH Lab installed (`rushlab preview`): `{drafts, error, offline}`, with
 * `drafts` null until they arrive and `offline` while no computer is connected
 * (503). Read again whenever the window comes back into view, so a draft
 * previewed in the terminal shows up once the member returns.
 */
export default function useWorkspaceDrafts(workspace) {
  const [state, setState] = useState({workspaceId: null, drafts: null, error: null, offline: false});
  const workspaceId = workspace?.id ?? null;

  useEffect(() => {
    if (!workspaceId) return undefined;
    let cancelled = false;
    const load = () => apiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/app-drafts`, {fresh: true})
      .then(result => {
        if (cancelled) return;
        if (result.ok) setState({workspaceId, drafts: result.data.drafts, error: null, offline: false});
        else if (result.status === 503) setState({workspaceId, drafts: null, error: null, offline: true});
        else setState({workspaceId, drafts: null, error: result.data.error || `Could not load drafts (${result.status})`, offline: false});
      })
      .catch(() => {
        if (!cancelled) setState({workspaceId, drafts: null, error: 'Could not reach the API server', offline: false});
      });
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    load();
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [workspaceId]);

  return state.workspaceId === workspaceId ? state : {workspaceId, drafts: null, error: null, offline: false};
}
