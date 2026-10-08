/**
 * Redirect old workspace-dependent pages into a URL with an explicit slug.
 * The selected workspace is only a navigation default, never authorization.
 */
import {WORKSPACE_PAGE_ROOTS} from '@site/src/utils/workspaces';
import {prefetchWorkspaceContentHref} from '@site/src/utils/workspaceContent';

let redirecting = false;
let prefetchInstalled = false;

function installPrefetch() {
  if (prefetchInstalled || typeof document === 'undefined') return;
  prefetchInstalled = true;
  document.addEventListener('pointerover', event => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (anchor) prefetchWorkspaceContentHref(anchor.href).catch(() => {});
  }, {passive: true});
  document.addEventListener('focusin', event => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (anchor) prefetchWorkspaceContentHref(anchor.href).catch(() => {});
  });
}

export async function onRouteDidUpdate({location}) {
  if (redirecting || typeof window === 'undefined') return;
  installPrefetch();
  const page = location.pathname.replace(/^\/+|\/+$/g, '');
  const root = page.split('/')[0];
  if (!WORKSPACE_PAGE_ROOTS.has(root)) return;
  redirecting = true;
  try {
    const {loadWorkspaces, navigateClient} = await import('@site/src/utils/workspaces');
    const data = await loadWorkspaces();
    const workspace = data.workspaces.find(item => item.id === data.defaultWorkspaceId)
      ?? data.workspaces[0];
    if (workspace) {
      navigateClient(
        `/w/${encodeURIComponent(workspace.slug)}/${page}${location.search || ''}${location.hash || ''}`,
        {replace: true},
      );
    }
  } finally {
    redirecting = false;
  }
}
