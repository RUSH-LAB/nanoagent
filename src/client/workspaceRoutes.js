/**
 * Redirect old workspace-dependent pages into a URL with an explicit slug.
 * The selected workspace is only a navigation default, never authorization.
 */
import {WORKSPACE_PAGE_ROOTS} from '@site/src/utils/workspaces';

let redirecting = false;
let prefetchInstalled = false;

async function prefetchWorkspaceDocument(anchor) {
  const match = /^\/w\/([^/]+)\/documents(?:\/(.*))?$/.exec(anchor.pathname);
  if (!match) return;
  const workspaceSlug = decodeURIComponent(match[1]);
  const documentPath = decodeURIComponent(match[2] || '').replace(/\/+$/, '');
  const [{loadWorkspaces}, {default: API_BASE, apiJson}] = await Promise.all([
    import('@site/src/utils/workspaces'),
    import('@site/src/utils/api'),
  ]);
  const {workspaces} = await loadWorkspaces();
  const workspace = workspaces.find(item => item.slug === workspaceSlug);
  if (!workspace) return;
  const apiRoot = `${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}`;
  const collectionPrefix = documentPath.split('/').slice(0, 2).join('/');
  const isBlogPath = collectionPrefix.startsWith('posts/');
  const treeQuery = documentPath
    ? `?prefix=${encodeURIComponent(collectionPrefix)}&include=${isBlogPath ? 'frontmatter' : 'metadata'}`
    : '';
  const likelyCollection = /^(?:books|posts)\/[^/]+$/.test(documentPath);
  await Promise.allSettled([
    documentPath && !likelyCollection
      ? apiJson(`${apiRoot}/documents?path=${encodeURIComponent(documentPath)}`, {cacheMs: 30_000})
      : Promise.resolve(),
    apiJson(`${apiRoot}/documents/tree${treeQuery}`, {cacheMs: 30_000}),
    apiJson(`${apiRoot}/site`, {cacheMs: 5 * 60_000}),
  ]);
}

function installPrefetch() {
  if (prefetchInstalled || typeof document === 'undefined') return;
  prefetchInstalled = true;
  document.addEventListener('pointerover', event => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (anchor) prefetchWorkspaceDocument(anchor).catch(() => {});
  }, {passive: true});
  document.addEventListener('focusin', event => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (anchor) prefetchWorkspaceDocument(anchor).catch(() => {});
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
