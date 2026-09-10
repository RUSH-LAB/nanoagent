import API_BASE, {apiJson} from './api.js';
import {loadWorkspaces} from './workspaces.js';

// Content already authorized and loaded by this tab can safely remain warm for
// a normal editing session. Every write invalidates the workspace API prefix,
// so this avoids repeated Neon round trips without making saved content stale.
export const WORKSPACE_CONTENT_CACHE_MS = 10 * 60_000;

// This development workspace predates configurable home pages. Give only it
// the requested title-only presentation; every other workspace retains the
// library until its owner chooses another layout.
const TITLE_ONLY_WORKSPACES = new Set(['mochi']);

export function workspaceHomeLayout(site, workspaceSlug) {
  return site?.site?.homeLayout
    || (TITLE_ONLY_WORKSPACES.has(workspaceSlug) ? 'title' : 'library');
}

function normalizeDocumentPath(value) {
  return String(value ?? '').replace(/^\/+|\/+$/g, '');
}

function collectionFor(site, documentPath) {
  const path = normalizeDocumentPath(documentPath);
  return (site?.collections ?? [])
    .filter(collection => path === collection.pathPrefix || path.startsWith(`${collection.pathPrefix}/`))
    .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0] ?? null;
}

/** Describe the API reads needed to render one runtime content route. */
export function workspaceContentPlan(site, documentPath) {
  const path = normalizeDocumentPath(documentPath);
  const collection = collectionFor(site, path);
  // A workspace site explicitly owns its collection boundaries. The fallback
  // keeps an unconfigured workspace useful without assuming organization-
  // specific names such as `books` or `posts`.
  const prefix = collection?.pathPrefix ?? '';
  // Collection pages render a compact metadata list. Avoid compiling every
  // post excerpt merely to show its title, author, and year—this matters once
  // a workspace has hundreds of posts.
  const include = 'metadata';
  const treeQuery = path || prefix
    ? `?prefix=${encodeURIComponent(prefix || path)}&include=${include}`
    : '';
  return {
    path,
    collection,
    treeQuery,
    isCollection: Boolean(collection && path === collection.pathPrefix),
  };
}

/**
 * Warm everything a content click needs. apiJson deduplicates this request
 * with the route loader, so hovering/clicking during a prefetch never creates
 * duplicate database work.
 */
export async function prefetchWorkspaceContent(workspaceSlug, documentPath, knownSite = null) {
  if (!workspaceSlug) return;
  const {workspaces} = await loadWorkspaces();
  const workspace = workspaces.find(item => item.slug === workspaceSlug);
  if (!workspace) return;

  const apiRoot = `${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}`;
  const siteRequest = apiJson(`${apiRoot}/site`, {cacheMs: WORKSPACE_CONTENT_CACHE_MS});
  const siteResult = knownSite ? null : await siteRequest;
  const site = knownSite ?? (siteResult?.ok ? siteResult.data.site : null);
  const plan = workspaceContentPlan(site, documentPath);

  await Promise.allSettled([
    plan.path && !plan.isCollection
      ? apiJson(`${apiRoot}/documents?path=${encodeURIComponent(plan.path)}`, {
          cacheMs: WORKSPACE_CONTENT_CACHE_MS,
        })
      : Promise.resolve(),
    apiJson(`${apiRoot}/documents/tree${plan.treeQuery}`, {
      cacheMs: WORKSPACE_CONTENT_CACHE_MS,
    }),
    siteRequest,
  ]);
}

/** Parse and prefetch a workspace-document anchor. */
export function prefetchWorkspaceContentHref(href, knownSite = null) {
  let url;
  try {
    url = new URL(href, typeof window === 'undefined' ? 'http://localhost' : window.location.href);
  } catch {
    return Promise.resolve();
  }
  const match = /^\/w\/([^/]+)\/documents(?:\/(.*))?$/.exec(url.pathname);
  if (!match) return Promise.resolve();
  try {
    return prefetchWorkspaceContent(
      decodeURIComponent(match[1]),
      decodeURIComponent(match[2] || ''),
      knownSite,
    );
  } catch {
    return Promise.resolve();
  }
}
