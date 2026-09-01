import {useEffect, useState} from 'react';
import {useLocation} from '@docusaurus/router';
import API_BASE, {apiJson, getCachedApiJson} from '@site/src/utils/api';
import {getCachedWorkspaces, loadWorkspaces, workspaceSlugFromPath} from '@site/src/utils/workspaces';

const WORKSPACE_SITE_UPDATED = 'mochi:workspace-site-updated';

export function publishWorkspaceSite(slug, site) {
  if (typeof window === 'undefined' || !slug) return;
  window.dispatchEvent(new CustomEvent(WORKSPACE_SITE_UPDATED, {detail: {slug, site}}));
}

function cachedState(slug) {
  if (!slug) return {slug: null, workspace: null, site: null, loading: false, error: null};
  const cached = getCachedWorkspaces();
  const workspace = cached?.workspaces?.find(item => item.slug === slug) ?? null;
  const site = workspace
    ? getCachedApiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/site`)?.data?.site ?? null
    : null;
  return {slug, workspace, site, loading: !site, error: null};
}

/**
 * Resolve the workspace named by this tab's URL and its validated site data.
 *
 * State carries its slug so a route change can never expose the previous
 * workspace while the new request is in flight. The shared API cache keeps
 * the navbar, command launchers, and content route from multiplying reads.
 */
export default function useWorkspaceSite() {
  const location = useLocation();
  const routeSlug = workspaceSlugFromPath(location.pathname);
  const slug = routeSlug && !routeSlug.startsWith(':') ? routeSlug : null;
  const [state, setState] = useState(() => cachedState(slug));

  useEffect(() => {
    let cancelled = false;
    setState(cachedState(slug));
    if (!slug) return () => { cancelled = true; };

    loadWorkspaces()
      .then(({workspaces}) => {
        const workspace = workspaces.find(item => item.slug === slug);
        if (!workspace) {
          if (!cancelled) setState({slug, workspace: null, site: null, loading: false, error: 'Workspace not found'});
          return null;
        }
        return apiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/site`, {cacheMs: 5 * 60_000})
          .then(result => ({workspace, result}));
      })
      .then(value => {
        if (!value || cancelled) return;
        const {workspace, result} = value;
        setState({
          slug,
          workspace,
          site: result.ok ? result.data.site : null,
          loading: false,
          error: result.ok ? null : result.data.error || `Request failed (${result.status})`,
        });
      })
      .catch(error => {
        if (!cancelled) setState({slug, workspace: null, site: null, loading: false, error: error.message});
      });

    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const update = event => {
      if (event.detail?.slug !== slug) return;
      setState(current => ({...current, slug, site: event.detail.site, loading: false, error: null}));
    };
    window.addEventListener(WORKSPACE_SITE_UPDATED, update);
    return () => window.removeEventListener(WORKSPACE_SITE_UPDATED, update);
  }, [slug]);

  return state.slug === slug ? state : cachedState(slug);
}
