import {useEffect, useLayoutEffect, useState} from 'react';
import {useLocation} from '@docusaurus/router';
import API_BASE, {apiJson, getCachedApiJson, invalidateApiJson} from '@site/src/utils/api';
import {clientPlatform} from '@site/src/platform/client';
import {isOffline} from '@site/src/utils/documentCache';
import {workspaceSlugFromPath} from '@site/src/utils/workspaces';

const WORKSPACE_SITE_UPDATED = 'mochi:workspace-site-updated';
// The browser's memory of each workspace's answer; signing out forgets it (utils/authClient.js).
export const WORKSPACE_SITE_STORAGE_PREFIX = 'mochi:workspace-site:';
const SITE_CACHE_MS = 5 * 60_000;

const siteUrl = slug => `${API_BASE}/api/workspace-site?slug=${encodeURIComponent(slug)}`;
const empty = slug => ({slug, workspace: null, site: null, loading: Boolean(slug), error: null});

export function publishWorkspaceSite(slug, site) {
  if (typeof window === 'undefined' || !slug) return;
  invalidateApiJson(siteUrl(slug));
  window.dispatchEvent(new CustomEvent(WORKSPACE_SITE_UPDATED, {detail: {slug, site}}));
}

/** The answer this page already read, from the shared API cache. */
function cachedState(slug) {
  const data = slug ? getCachedApiJson(siteUrl(slug))?.data : null;
  return data ? {slug, workspace: data.workspace, site: data.site, loading: false, error: null} : empty(slug);
}

// A new tab starts with an empty API cache. The browser keeps each
// workspace's last answer and shows it at once while the read refreshes it,
// so the navbar draws the whole workspace together; a failed read forgets it.
function storedState(slug) {
  try {
    const stored = JSON.parse(clientPlatform.storage.getItem(WORKSPACE_SITE_STORAGE_PREFIX + slug) ?? 'null');
    return stored?.workspace && stored?.site
      ? {slug, workspace: stored.workspace, site: stored.site, loading: false, error: null}
      : null;
  } catch {
    return null;
  }
}

function remember(slug, workspace, site) {
  const key = WORKSPACE_SITE_STORAGE_PREFIX + slug;
  if (workspace && site) clientPlatform.storage.setItem(key, JSON.stringify({workspace, site}));
  else clientPlatform.storage.removeItem(key);
}

// Before paint in the browser, so a remembered workspace never flashes empty;
// the server has no storage and nothing to lay out.
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Resolve the workspace named by this tab's URL and its validated site data,
 * in one read (/api/workspace-site), so everything drawn from it (the navbar's
 * Book, Blog, Plugins and Workspace) appears at the same moment.
 *
 * State carries its slug so a route change can never expose the previous
 * workspace while the new request is in flight. The shared API cache keeps
 * the navbar, command launchers, and content route from multiplying reads.
 */
export default function useWorkspaceSite() {
  const location = useLocation();
  const routeSlug = workspaceSlugFromPath(location.pathname);
  const slug = routeSlug && !routeSlug.startsWith(':') ? routeSlug : null;
  // Rendering starts from the API cache alone, which matches the server's HTML.
  const [state, setState] = useState(() => cachedState(slug));

  useBrowserLayoutEffect(() => {
    const cached = cachedState(slug);
    setState(cached.site || !slug ? cached : storedState(slug) ?? cached);
  }, [slug]);

  useEffect(() => {
    if (!slug) return undefined;
    let cancelled = false;
    apiJson(siteUrl(slug), {cacheMs: SITE_CACHE_MS})
      .then(result => {
        if (cancelled) return;
        if (!result.ok) {
          remember(slug, null, null);
          setState({slug, workspace: null, site: null, loading: false, error: result.data.error || `Request failed (${result.status})`});
          return;
        }
        remember(slug, result.data.workspace, result.data.site);
        setState({slug, workspace: result.data.workspace, site: result.data.site, loading: false, error: null});
      })
      .catch(error => {
        if (cancelled) return;
        // Offline: the workspace as this browser last saw it, so its kept
        // files stay reachable; a server that answers is believed instead.
        const stored = isOffline(error) ? storedState(slug) : null;
        setState(stored ?? {slug, workspace: null, site: null, loading: false, error: error.message});
      });
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const update = event => {
      if (event.detail?.slug !== slug) return;
      setState(current => {
        remember(slug, current.workspace, event.detail.site);
        return {...current, slug, site: event.detail.site, loading: false, error: null};
      });
    };
    window.addEventListener(WORKSPACE_SITE_UPDATED, update);
    return () => window.removeEventListener(WORKSPACE_SITE_UPDATED, update);
  }, [slug]);

  return state.slug === slug ? state : cachedState(slug);
}
