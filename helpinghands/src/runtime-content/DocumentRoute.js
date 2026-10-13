import React, {Suspense, lazy, useCallback, useEffect, useState} from 'react';
import clsx from 'clsx';
import {useLocation} from '@docusaurus/router';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Link from '@docusaurus/Link';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import BlogLayout from '@theme/BlogLayout';
import BlogPostPage from '@theme/BlogPostPage';
import DocRootLayout from '@theme/DocRoot/Layout';
import {DocsSidebarProvider} from '@docusaurus/plugin-content-docs/client';
import {HtmlClassNameProvider, ThemeClassNames} from '@docusaurus/theme-common';
import useWorkspaceSubscriptions, {
  isGroupSubscribed, orderByPreference,
} from '@site/src/hooks/useWorkspaceSubscriptions';
import API_BASE, {apiFetch, apiJson, invalidateApiJson} from '@site/src/utils/api';
import {navigateClient} from '@site/src/utils/workspaces';
import {useAccount} from '@site/src/utils/account';
import {
  DOCUMENT_SYNC_EVENT, documentCache, isOffline, startDocumentSync,
} from '@site/src/utils/documentCache';
import {viewWorkspacePublicly} from '@site/src/utils/documentUrls';
import {toast} from '@site/src/components/Toast/toast';
import {clientPlatform} from '@site/src/platform/client';
import {adjacentDocumentPosition, newDocumentDraft} from '@site/src/utils/documentAuthoring';
import {
  WORKSPACE_CONTENT_CACHE_MS, workspaceContentPlan, workspaceHomeLayout,
} from '@site/src/utils/workspaceContent';
import {createRuntimeBlogContent} from './RuntimeBlogPost';
import RuntimeDocItem from './RuntimeDocItem';
import styles from './documentRoute.module.css';

const DocumentEditor = lazy(() => import('./DocumentEditor'));

const HOME_TOOLS = Object.freeze([
  {
    id: 'bibliography',
    title: 'Bibliography',
    description: 'Collect papers, organize sources, and manage citations.',
    path: 'bibliography',
    keywords: ['bib', 'bibliography', 'citation', 'citations', 'paper', 'papers', 'reference', 'references'],
  },
]);

function ToolSearch({workspaceSlug}) {
  const [query, setQuery] = useState('');
  const workspaceRoot = `/w/${encodeURIComponent(workspaceSlug)}`;
  const normalized = query.trim().toLowerCase();
  const matches = normalized
    ? HOME_TOOLS.filter(tool => tool.keywords.some(keyword => keyword.includes(normalized)))
    : [];

  const openFirst = (event) => {
    event.preventDefault();
    if (matches[0]) navigateClient(`${workspaceRoot}/${matches[0].path}`);
  };

  return (
    <section className={styles.toolSearch} aria-label="Find a tool">
      <form className={styles.toolSearchBar} role="search" onSubmit={openFirst}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m16.5 16.5 4 4" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search tools"
          aria-label="Search workspace tools"
          autoComplete="off"
          autoFocus
        />
      </form>

      {normalized && (
        <div className={styles.toolResults} aria-live="polite">
          {matches.map(tool => (
            <Link key={tool.id} className={styles.toolResult} to={`${workspaceRoot}/${tool.path}`}>
              <span>
                <strong>{tool.title}</strong>
                <small>{tool.description}</small>
              </span>
              <span aria-hidden="true">→</span>
            </Link>
          ))}
          {matches.length === 0 && <p>No tools match “{query.trim()}”.</p>}
        </div>
      )}
    </section>
  );
}

/**
 * A page, fetched and rendered when somebody asks for it.
 *
 * What arrives is an inert render tree. The server has already rejected code,
 * raw HTML, unsafe URLs, unknown components, and non-static attributes.
 */

/** The four states this route can be in. Rendered by the switch at the bottom. */
const LOADING = 'loading';
const READY = 'ready';
const MISSING = 'missing';
const BROKEN = 'broken';

async function request(path, init) {
  const response = await apiFetch(`${API_BASE}${path}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function routeForDocument(path) {
  return path.replace(/\.(md|mdx)$/, '').replace(/\/index$/, '');
}

function labelForDirectory(path) {
  const name = stripNumberPrefix(path.split('/').filter(Boolean).pop() || 'Documents').name;
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function stripNumberPrefix(value) {
  if (/^\d+[-_.]\d+/.test(value)) return {name: value, position: undefined};
  const match = /^(\d+)\s*[-_.]+\s*([^-_.\s].*)$/.exec(value);
  return match ? {name: match[2], position: Number(match[1])} : {name: value, position: undefined};
}

function sourceName(document) {
  return document.path.split('/').pop().replace(/\.(md|mdx)$/i, '');
}

function headingsOf(node, result = []) {
  if (!node) return result;
  if (node.type === 'heading' && node.depth >= 2 && node.depth <= 3) {
    const label = (node.children || []).map(child => child.value || '').join('').trim();
    if (label) result.push({id: node.id, value: label, level: node.depth});
  }
  for (const child of node.children || []) headingsOf(child, result);
  return result;
}

function collectionFor(site, documentPath) {
  return (site?.collections || [])
    .filter(collection => documentPath === collection.pathPrefix || documentPath.startsWith(`${collection.pathPrefix}/`))
    .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0] || null;
}

function documentDate(document) {
  const value = document.frontmatter?.date || document.createdAt || document.updatedAt;
  const date = value ? new Date(value) : new Date(0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function taxonomyLabel(value) {
  return String(value || '')
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function documentGroup(document) {
  return document.frontmatter?.group?.trim() || 'Ungrouped';
}

function documentTaxonomy(document) {
  const frontmatter = document.frontmatter || {};
  const paths = [];
  if (frontmatter.category) {
    paths.push({
      category: taxonomyLabel(frontmatter.category),
      subcategory: frontmatter.subcategory ? taxonomyLabel(frontmatter.subcategory) : null,
    });
  }
  for (const tag of frontmatter.tags || []) {
    const [category, ...subcategoryParts] = String(tag).split('::');
    paths.push({
      category: taxonomyLabel(category),
      subcategory: subcategoryParts.length ? taxonomyLabel(subcategoryParts.join('::')) : null,
    });
  }
  const group = documentGroup(document).toLocaleLowerCase();
  const seen = new Set();
  const result = [];
  for (const path of paths) {
    if (!path.category || path.category.toLocaleLowerCase() === group) continue;
    const key = `${path.category.toLocaleLowerCase()}\u0000${path.subcategory?.toLocaleLowerCase() || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result.length ? result : [{category: 'Uncategorized', subcategory: null}];
}

function documentCategory(document) {
  return [...new Set(documentTaxonomy(document).map(path => path.category))].join(', ');
}

function blogFilterHref(collectionHref, {group, category = null, subcategory = null}) {
  const search = new URLSearchParams();
  if (group) search.set('group', group);
  if (category) search.set('category', category);
  if (subcategory) search.set('subcategory', subcategory);
  const query = search.toString();
  return query ? `${collectionHref}?${query}` : collectionHref;
}

function configuredBlogGroups(documents, collection) {
  const counts = new Map();
  for (const document of documents) {
    const title = documentGroup(document);
    counts.set(title, (counts.get(title) || 0) + 1);
  }
  const configured = collection?.groups || [];
  const configuredNames = new Set(configured.map(group => group.title.toLocaleLowerCase()));
  return [
    ...configured.map(group => ({...group, count: counts.get(group.title) || 0})),
    ...[...counts.entries()]
      .filter(([title]) => !configuredNames.has(title.toLocaleLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, count]) => ({title, count})),
  ];
}

function blogGroupNavigation(
  documents,
  workspaceSlug,
  collection,
  activeGroup = null,
  activeCategory = null,
  activeSubcategory = null,
  showBreadcrumb = false,
) {
  const groupEntries = configuredBlogGroups(documents, collection);
  const collectionHref = `/w/${encodeURIComponent(workspaceSlug)}/documents/${collection.pathPrefix}`;
  const groupDocuments = activeGroup
    ? documents.filter(document => documentGroup(document) === activeGroup)
    : [];
  const categoryEntries = new Map();
  for (const document of groupDocuments) {
    const documentCategories = new Map();
    for (const path of documentTaxonomy(document)) {
      if (!documentCategories.has(path.category)) documentCategories.set(path.category, new Set());
      if (path.subcategory) documentCategories.get(path.category).add(path.subcategory);
    }
    for (const [category, subcategories] of documentCategories) {
      if (!categoryEntries.has(category)) {
        categoryEntries.set(category, {count: 0, subcategories: new Map()});
      }
      const entry = categoryEntries.get(category);
      entry.count += 1;
      for (const subcategory of subcategories) {
        entry.subcategories.set(subcategory, (entry.subcategories.get(subcategory) || 0) + 1);
      }
    }
  }
  const taxonomyCategories = [...categoryEntries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([title, entry]) => ({
      title,
      count: entry.count,
      permalink: blogFilterHref(collectionHref, {group: activeGroup, category: title}),
      subcategories: [...entry.subcategories.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([subcategory, count]) => ({
          title: subcategory,
          count,
          permalink: blogFilterHref(collectionHref, {
            group: activeGroup,
            category: title,
            subcategory,
          }),
        })),
    }));
  const categories = activeGroup ? [
    {
      title: 'All',
      count: groupDocuments.length,
      permalink: blogFilterHref(collectionHref, {group: activeGroup}),
      subcategories: [],
      isAll: true,
    },
    ...taxonomyCategories,
  ] : [];
  const activeCategoryEntry = taxonomyCategories.find(category => category.title === activeCategory);
  const activeSubcategoryEntry = activeCategoryEntry?.subcategories
    .find(subcategory => subcategory.title === activeSubcategory);
  const breadcrumb = showBreadcrumb ? [
    activeGroup && {
      label: activeGroup,
      permalink: blogFilterHref(collectionHref, {group: activeGroup}),
    },
    activeCategoryEntry && {
      label: activeCategoryEntry.title,
      permalink: activeCategoryEntry.permalink,
    },
    activeSubcategoryEntry && {
      label: activeSubcategoryEntry.title,
      permalink: activeSubcategoryEntry.permalink,
    },
  ].filter(Boolean) : [];
  return {
    title: 'Groups',
    collectionKey: collection.key,
    collectionHref,
    activeGroup,
    activeCategory,
    activeSubcategory,
    groups: groupEntries.map(entry => ({
      title: entry.title,
      permalink: blogFilterHref(collectionHref, {group: entry.title}),
      count: entry.count,
    })),
    categories,
    breadcrumb,
    items: [],
  };
}

function compareDocuments(a, b, type) {
  if (type === 'blog') {
    return (documentDate(b)?.getTime() || 0) - (documentDate(a)?.getTime() || 0)
      || a.path.localeCompare(b.path);
  }
  const position = (a.frontmatter?.sidebarPosition ?? Number.MAX_SAFE_INTEGER)
    - (b.frontmatter?.sidebarPosition ?? Number.MAX_SAFE_INTEGER);
  return position || a.path.localeCompare(b.path);
}

function sidebarTree(documents, prefix, workspaceSlug) {
  const root = {name: '', folders: new Map(), documents: []};
  for (const document of documents) {
    const relative = document.path.slice(prefix.length).replace(/^\//, '');
    const parts = relative.split('/');
    let node = root;
    for (const name of parts.slice(0, -1)) {
      if (!node.folders.has(name)) node.folders.set(name, {name, folders: new Map(), documents: []});
      node = node.folders.get(name);
    }
    node.documents.push(document);
  }
  const linkFor = item => ({
    type: 'link',
    label: item.title,
    href: `/w/${encodeURIComponent(workspaceSlug)}/documents/${routeForDocument(item.path)}`,
    docId: item.path,
    unlisted: false,
  });
  const convert = node => {
    const indexDocument = node.documents.find(document => sourceName(document) === 'index');
    const entries = [
      ...[...node.folders.values()].map(folder => {
        const folderIndex = folder.documents.find(document => sourceName(document) === 'index');
        const parsed = stripNumberPrefix(folder.name);
        return {
          position: folderIndex?.frontmatter?.sidebarPosition ?? parsed.position ?? Number.MAX_SAFE_INTEGER,
          source: folder.name,
          item: {
            type: 'category',
            label: folderIndex?.title || labelForDirectory(folder.name),
            collapsible: true,
            collapsed: true,
            items: convert(folder),
            ...(folderIndex ? {
              href: `/w/${encodeURIComponent(workspaceSlug)}/documents/${routeForDocument(folderIndex.path)}`,
            } : {}),
          },
        };
      }),
      ...node.documents.filter(document => document !== indexDocument).map(document => {
        const parsed = stripNumberPrefix(sourceName(document));
        return {
          position: document.frontmatter?.sidebarPosition ?? parsed.position ?? Number.MAX_SAFE_INTEGER,
          source: document.path,
          item: linkFor(document),
        };
      }),
    ];
    return entries
      .sort((a, b) => a.position - b.position || a.source.localeCompare(b.source))
      .map(entry => entry.item);
  };
  return convert(root);
}

function DocumentBody({
  workspaceSlug,
  documentPath,
  editRequested,
  groupRequested,
  categoryRequested,
  subcategoryRequested,
}) {
  const {siteConfig} = useDocusaurusContext();
  const {account, userId, workspaces} = useAccount();
  const [state, setState] = useState({status: LOADING});
  const [editing, setEditing] = useState(false);
  // A visitor has no member preferences to read.
  const {subscriptions} = useWorkspaceSubscriptions(
    state.workspaceId && state.workspaceRole !== 'visitor' ? {id: state.workspaceId} : null,
  );

  useEffect(() => {
    let cancelled = false;
    setEditing(false);

    (async () => {
      // Keep the current native page mounted while the next one is fetched.
      // Replacing it with a temporary Layout remounted the navbar and caused
      // both a visible jump and a slower-feeling transition.
      setState(current => current.status === READY && current.workspaceSlug === workspaceSlug
        ? {...current, pending: true}
        : {status: LOADING, workspaceSlug});
      try {
        // A signed-out visitor reads what the workspace publishes, through the
        // public API, without this browser's cache of member documents.
        let workspace;
        let publicSite = null;
        if (userId) {
          workspace = workspaces.find(item => item.slug === workspaceSlug);
        } else {
          const published = await apiJson(`${API_BASE}/api/public/${encodeURIComponent(workspaceSlug)}`, {
            cacheMs: WORKSPACE_CONTENT_CACHE_MS,
          });
          if (published.ok) {
            workspace = {...published.data.workspace, role: 'visitor'};
            publicSite = {ok: true, status: 200, data: {site: published.data.site}};
            viewWorkspacePublicly(workspace.id, workspace.slug);
          }
        }
        if (!workspace) {
          if (!cancelled) setState({status: MISSING});
          return;
        }
        const apiRoot = publicSite
          ? `${API_BASE}/api/public/${encodeURIComponent(workspace.slug)}`
          : `${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}`;
        const scope = {userId, workspaceId: workspace.id};
        const cache = publicSite ? null : documentCache();
        const logCacheError = error => console.error('[documents] Browser cache failed:', error);
        let siteResult = publicSite;
        if (!siteResult) {
          try {
            siteResult = await apiJson(`${apiRoot}/site`, {cacheMs: WORKSPACE_CONTENT_CACHE_MS});
            if (siteResult.ok) cache.remember(scope, '#site', siteResult.data).catch(logCacheError);
          } catch (err) {
            // Offline: lay the workspace out as it was when this browser last saw it.
            siteResult = isOffline(err) ? await cache.read(scope, '#site') : null;
            if (!siteResult) throw err;
          }
        }
        const site = siteResult.ok ? siteResult.data.site : null;
        const homeLayout = workspaceHomeLayout(site, workspaceSlug);
        const homeDocument = !documentPath && homeLayout === 'document'
          ? site?.site?.homeDocument
          : null;
        const requestedPath = documentPath || homeDocument || '';
        const plan = workspaceContentPlan(site, requestedPath);
        const needsTree = Boolean(documentPath || homeLayout !== 'title');
        const views = {
          document: plan.path && !plan.isCollection ? `?path=${encodeURIComponent(plan.path)}` : null,
          tree: needsTree ? `/tree${plan.treeQuery}` : null,
        };
        const notRequested = {
          document: {ok: false, status: 404, data: {}},
          tree: {ok: true, status: 200, data: {documents: []}},
        };

        const show = (documentResult, treeResult) => {
          const listed = treeResult.ok ? treeResult.data.documents || [] : [];
          const readyBase = {
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            workspaceRole: workspace.role,
            workspaceSlug,
            userId,
            views,
            routePath: documentPath,
            site,
          };
          if (!documentPath && homeLayout === 'title') {
            setState({status: READY, documents: listed, homeLayout, ...readyBase});
            return;
          }
          if (!documentPath && homeLayout === 'document') {
            if (!homeDocument) {
              setState({status: BROKEN, message: 'Choose a home document in workspace settings.'});
              return;
            }
            if (!documentResult.ok) {
              setState({status: BROKEN, message: documentResult.data.error || 'The configured home document was not found.'});
              return;
            }
            setState({
              status: READY,
              tree: documentResult.data.tree,
              document: documentResult.data.document,
              markdown: documentResult.data.markdown,
              frontmatter: documentResult.data.frontmatter || {},
              authors: documentResult.data.authors,
              documents: listed,
              homeLayout,
              ...readyBase,
            });
            return;
          }
          if (!documentPath) {
            setState({status: READY, documents: listed, ...readyBase});
            return;
          }
          if (documentResult.ok) {
            setState({
              status: READY,
              tree: documentResult.data.tree,
              document: documentResult.data.document,
              markdown: documentResult.data.markdown,
              frontmatter: documentResult.data.frontmatter || {},
              authors: documentResult.data.authors,
              documents: listed,
              ...readyBase,
            });
            if (editRequested && (workspace.role === 'owner' || workspace.role === 'editor')) setEditing(true);
            return;
          }
          if (documentResult.status === 404 && treeResult.ok) {
            const prefix = `${documentPath.replace(/\/+$/, '')}/`;
            const children = listed
              .filter(document => document.path.startsWith(prefix))
              .sort((a, b) => a.path.localeCompare(b.path));
            const requestedCollection = collectionFor(site, documentPath);
            if (children.length > 0 || requestedCollection?.pathPrefix === documentPath) {
              setState({
                status: READY,
                directory: documentPath,
                documents: children,
                ...readyBase,
              });
              return;
            }
            if (listed.length === 0 && (site?.navigation?.length ?? 0) === 0) {
              setState({status: READY, documents: [], emptyWorkspace: true, ...readyBase});
              navigateClient(`/w/${encodeURIComponent(workspaceSlug)}/documents`, {replace: true});
              return;
            }
            setState({status: MISSING});
            return;
          }
          setState({
            status: BROKEN,
            message: documentResult.data.error || `Request failed (${documentResult.status})`,
          });
        };

        // This browser's copy renders at once; the server's answer below
        // replaces it. A copy holding an edit not yet uploaded stays in view.
        const cached = cache && (views.document || views.tree)
          ? await Promise.all(['document', 'tree'].map(kind => views[kind]
            ? cache.read(scope, views[kind])
            : notRequested[kind])).catch(error => {
            logCacheError(error);
            return [null, null];
          })
          : [null, null];
        const shownFromCache = Boolean(cached[0] && cached[1]);
        if (cancelled) return;
        if (shownFromCache) show(cached[0], cached[1]);

        let results;
        try {
          results = await Promise.all([
            views.document
              ? apiJson(`${apiRoot}/documents${views.document}`, {cacheMs: WORKSPACE_CONTENT_CACHE_MS})
              : notRequested.document,
            views.tree
              ? apiJson(`${apiRoot}/documents${views.tree}`, {cacheMs: WORKSPACE_CONTENT_CACHE_MS})
              : notRequested.tree,
          ]);
        } catch (err) {
          // Offline: keep showing this browser's copy.
          if (shownFromCache && isOffline(err)) return;
          throw err;
        }
        if (cancelled) return;
        const [fetchedDocument, treeResult] = results;
        for (const [kind, result] of [['document', fetchedDocument], ['tree', treeResult]]) {
          if (cache && views[kind] && result.ok) cache.remember(scope, views[kind], result.data).catch(logCacheError);
        }
        show(cached[0]?.pending ? cached[0] : fetchedDocument, treeResult);
      } catch (err) {
        if (!cancelled) setState({status: BROKEN, message: err.message});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceSlug, documentPath, editRequested, userId, workspaces]);

  // Keep this browser's copy of the workspace current while the page is open,
  // and show what the background sync did with edits saved offline.
  useEffect(() => {
    if (!state.workspaceId || !state.userId) return undefined;
    const scope = {userId: state.userId, workspaceId: state.workspaceId};
    const onSync = ({detail}) => {
      if (detail.scope.userId !== scope.userId || detail.scope.workspaceId !== scope.workspaceId) return;
      invalidateApiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(scope.workspaceId)}/documents`);
      if (detail.conflictedCopy) {
        toast.warning(`${detail.path} changed while you were offline, so your edit was saved as ${detail.conflictedCopy}.`, {duration: 0});
      } else if (detail.error) {
        toast.error(`Your offline edit to ${detail.path} could not be uploaded: ${detail.error}`, {duration: 0});
      } else if (detail.uploaded) {
        toast.success(`Uploaded your offline edit to ${detail.path}.`);
      }
      if (!detail.view) return;
      setState(current => {
        if (current.views?.document === detail.view) {
          return {
            ...current,
            tree: detail.data.tree,
            markdown: detail.data.markdown,
            frontmatter: detail.data.frontmatter || {},
            authors: detail.data.authors,
            document: detail.data.document,
          };
        }
        if (current.views?.tree === detail.view && current.documents && !current.directory) {
          return {...current, documents: detail.data.documents || []};
        }
        return current;
      });
    };
    const onOffline = () => toast.warning(
      'You are offline. Documents on this computer stay readable, and edits upload when you reconnect.',
    );
    window.addEventListener(DOCUMENT_SYNC_EVENT, onSync);
    window.addEventListener('offline', onOffline);
    const stop = startDocumentSync(scope);
    return () => {
      stop();
      window.removeEventListener(DOCUMENT_SYNC_EVENT, onSync);
      window.removeEventListener('offline', onOffline);
    };
  }, [state.workspaceId, state.userId]);

  const applySavedDocument = useCallback(saved => {
    setState(current => ({
      ...current,
      pending: false,
      tree: saved.tree,
      markdown: saved.markdown,
      frontmatter: saved.frontmatter ?? current.frontmatter,
      authors: saved.authors ?? current.authors,
      document: {...current.document, ...saved.document},
      documents: (current.documents || []).map(item => item.path === saved.document.path
        ? {...item, title: saved.document.title, updatedAt: saved.document.updatedAt}
        : item),
    }));
  }, []);

  const createDocument = useCallback(async (collection, adjacent = null, group = null) => {
    if (!state.workspaceId || (state.workspaceRole !== 'owner' && state.workspaceRole !== 'editor')) return;
    const type = collection?.type === 'blog' ? 'post' : 'page';
    const title = clientPlatform.dialogs.prompt(`New ${type} title`)?.trim();
    if (!title) return;
    try {
      const directory = adjacent?.document.path.includes('/')
        ? adjacent.document.path.slice(0, adjacent.document.path.lastIndexOf('/'))
        : collection?.pathPrefix;
      const targetCollection = adjacent ? {...collection, pathPrefix: directory} : collection;
      // A post's author is whoever starts it, by GitHub username.
      let author = null;
      if (targetCollection?.type === 'blog') {
        author = account?.githubLogin;
        if (!author) throw new Error('Sign in with GitHub again so Mochi knows your GitHub username.');
      }
      const draft = newDocumentDraft({
        collection: targetCollection,
        title,
        existingPaths: (state.documents || []).map(item => item.path),
        author,
        group,
        sidebarPosition: adjacent && collection?.type !== 'blog'
          ? adjacentDocumentPosition(state.documents || [], adjacent.document.path, adjacent.direction)
          : null,
      });
      const apiRoot = `/api/workspaces/${encodeURIComponent(state.workspaceId)}/documents`;
      const data = await request(apiRoot, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: draft.path, markdown: draft.markdown}),
      });
      invalidateApiJson(`${API_BASE}${apiRoot}`);
      const route = routeForDocument(data.document.path);
      navigateClient(`/w/${encodeURIComponent(workspaceSlug)}/documents/${route}?edit=1`);
    } catch (error) {
      window.alert(error.message);
    }
  }, [account, state.documents, state.site, state.workspaceId, state.workspaceRole, workspaceSlug]);

  const deleteDocument = useCallback(async (document, collection) => {
    if (!state.workspaceId || state.workspaceRole !== 'owner') return;
    const type = collection?.type === 'blog' ? 'post' : 'page';
    if (!clientPlatform.dialogs.confirm(`Delete ${type} “${document.title}”? It will be moved to trash.`)) return;
    try {
      const apiRoot = `/api/workspaces/${encodeURIComponent(state.workspaceId)}/documents`;
      await request(apiRoot, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: document.path}),
      });
      invalidateApiJson(`${API_BASE}${apiRoot}`);
      setEditing(false);
      setState(current => ({
        ...current,
        routePath: collection?.pathPrefix || '',
        directory: collection?.pathPrefix || undefined,
        documents: (current.documents || []).filter(item => item.path !== document.path),
        document: undefined,
        markdown: undefined,
        tree: undefined,
        frontmatter: {},
        authors: undefined,
      }));
      const destination = collection?.pathPrefix
        ? `/w/${encodeURIComponent(workspaceSlug)}/documents/${collection.pathPrefix}`
        : `/w/${encodeURIComponent(workspaceSlug)}/documents`;
      navigateClient(destination, {replace: true});
    } catch (error) {
      window.alert(error.message);
    }
  }, [state.workspaceId, state.workspaceRole, workspaceSlug]);

  if (state.status === LOADING) {
    return <Layout title="Loading"><main className={styles.statusPage}><p>Loading…</p></main></Layout>;
  }

  if (state.status === MISSING) {
    // The API answers the same way for a page that is not there and one this
    // caller may not read, so this wording has to cover both without implying
    // which. Saying "you do not have access" would tell an outsider that the
    // page exists, which is most of what a private page is hiding.
    return (
      <Layout title="Nothing here"><main className={styles.statusPage}>
        <h1>Nothing here</h1>
        <p>
          There is no page at <code>{documentPath}</code> in this workspace.
        </p>
      </main></Layout>
    );
  }

  if (state.status === BROKEN) {
    return (
      <Layout title="This page could not be rendered"><main className={styles.statusPage}>
        <h1>This page could not be rendered</h1>
        <p>{state.message}</p>
      </main></Layout>
    );
  }

  // During an in-workspace navigation, state intentionally retains the last
  // successfully rendered page until the next request finishes. Branch on the
  // path that produced that state, not the newer URL: mixing a homepage state
  // with a document URL is what previously dereferenced `document.path` before
  // the Research document had arrived.
  const renderedPath = state.routePath ?? documentPath;
  const canEdit = state.workspaceRole === 'owner' || state.workspaceRole === 'editor';
  const canDelete = state.workspaceRole === 'owner';

  if (state.emptyWorkspace || (!renderedPath && (state.homeLayout === 'title' || (!state.document && state.documents.length === 0)))) {
    const workspaceTitle = state.site?.site?.title || state.workspaceName;
    return (
      <Layout title={workspaceTitle}>
        <main className={styles.workspaceHome}>
          <header className={styles.workspaceWelcome}>
            <h1>{siteConfig.title}</h1>
            {workspaceTitle !== siteConfig.title && <p>{workspaceTitle}</p>}
          </header>
          <ToolSearch workspaceSlug={state.workspaceSlug} />
        </main>
      </Layout>
    );
  }

  if ((!renderedPath && !state.document) || state.directory) {
    const directoryCollection = state.directory ? collectionFor(state.site, state.directory) : null;
    const isBlogCollection = directoryCollection?.type === 'blog';
    const visibleDocuments = !state.directory && state.site?.collections?.length
      ? state.documents.filter(document => state.site.collections.some(collection =>
          document.path.startsWith(`${collection.pathPrefix}/`)))
      : state.documents;
    const workspaceTitle = state.site?.site?.title || state.workspaceName;
    const heading = directoryCollection?.title || (state.directory ? labelForDirectory(state.directory) : workspaceTitle);
    const itemType = isBlogCollection ? 'post' : 'page';
    const description = state.directory
      ? directoryCollection?.description || `${visibleDocuments.length} ${visibleDocuments.length === 1 ? itemType : `${itemType}s`} in this collection`
      : `${visibleDocuments.length} ${visibleDocuments.length === 1 ? 'document' : 'documents'} in this workspace`;
    const sortedDocuments = [...visibleDocuments].sort((a, b) => compareDocuments(a, b, directoryCollection?.type));
    if (isBlogCollection) {
      const groups = orderByPreference(
        configuredBlogGroups(sortedDocuments, directoryCollection),
        subscriptions?.groupOrder?.[directoryCollection.key],
        group => group.title,
      );
      const requestedGroup = groups.find(group => group.title === groupRequested);
      const selectedGroup = requestedGroup?.title
        || groups.find(group => isGroupSubscribed(
          subscriptions, directoryCollection.key, group.title,
        ))?.title
        || null;
      const groupDocuments = selectedGroup
        ? sortedDocuments.filter(document => documentGroup(document) === selectedGroup)
        : [];
      const categories = [...new Set(groupDocuments.flatMap(document =>
        documentTaxonomy(document).map(path => path.category),
      ))].sort((a, b) => a.localeCompare(b));
      const selectedCategory = categories.includes(categoryRequested) ? categoryRequested : null;
      const categoryDocuments = selectedCategory
        ? groupDocuments.filter(document => documentTaxonomy(document).some(path => path.category === selectedCategory))
        : groupDocuments;
      const subcategories = selectedCategory
        ? [...new Set(categoryDocuments.flatMap(document => documentTaxonomy(document)
          .filter(path => path.category === selectedCategory && path.subcategory)
          .map(path => path.subcategory)))]
        : [];
      const selectedSubcategory = selectedCategory && subcategories.includes(subcategoryRequested)
        ? subcategoryRequested
        : null;
      const displayedDocuments = selectedSubcategory
        ? categoryDocuments.filter(document => documentTaxonomy(document).some(path =>
          path.category === selectedCategory && path.subcategory === selectedSubcategory))
        : categoryDocuments;
      const sidebar = blogGroupNavigation(
        sortedDocuments,
        workspaceSlug,
        directoryCollection,
        selectedGroup,
        selectedCategory,
        selectedSubcategory,
        true,
      );
      return (
        <BlogLayout title={heading} description={description} sidebar={sidebar}>
          <div className={styles.blogCollection}>
            <section className={styles.blogList} aria-label={selectedGroup ? `${selectedGroup} posts` : 'All blog posts'}>
              {sortedDocuments.length === 0 ? <p className={styles.emptyGroup}>This collection has no posts yet.</p> : (
                <>
                  <div className={styles.blogListHeader} aria-hidden="true">
                    <span>Date</span>
                    <span>Title</span>
                    <span />
                  </div>
                  {displayedDocuments.length === 0 ? <p className={styles.emptyGroup}>No posts in this group.</p> : (
                    <ul>
                      {displayedDocuments.map(document => {
                        const date = documentDate(document);
                        return (
                          <li key={document.id} className={styles.blogRow}>
                            <time dateTime={date?.toISOString()}>
                              {date ? new Intl.DateTimeFormat('en-US', {
                                month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
                              }).format(date) : '—'}
                            </time>
                            <Link
                              className={styles.blogTitle}
                              to={`/w/${encodeURIComponent(workspaceSlug)}/documents/${routeForDocument(document.path)}`}
                            >
                              <strong>{document.title}</strong>
                            </Link>
                            <Link
                              className={styles.blogArrow}
                              to={`/w/${encodeURIComponent(workspaceSlug)}/documents/${routeForDocument(document.path)}`}
                              aria-label={`Open ${document.title}`}
                            >→</Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </section>
          </div>
        </BlogLayout>
      );
    }
    return (
      <Layout title={heading} description={description}>
        <article className={styles.collection}>
          <header className={styles.collectionHeader}>
            <div>
              {state.directory && <span className={styles.eyebrow}>Collection</span>}
              <h1>{heading}</h1>
              {state.directory && <p>{description}</p>}
            </div>
          </header>
          {sortedDocuments.length === 0 ? <p className={styles.empty}>This workspace has no documents yet.</p> : (
            <div className={styles.documentGrid}>
              {sortedDocuments.map(document => {
              const route = routeForDocument(document.path);
              const relative = state.directory
                ? document.path.slice(`${state.directory.replace(/\/+$/, '')}/`.length)
                : document.path;
              return (
                <div key={document.id} className={styles.documentCard}>
                  <Link to={`/w/${encodeURIComponent(workspaceSlug)}/documents/${route}`}>
                    <span className={styles.documentTitle}>{document.title}</span>
                    <span className={styles.documentPath}>{relative.replace(/\.(md|mdx)$/, '')}</span>
                  </Link>
                </div>
              );
            })}
            </div>
          )}
        </article>
      </Layout>
    );
  }

  // A malformed or superseded response should degrade to a loading state,
  // never take down the route's React boundary.
  if (!state.document) {
    return <Layout title="Loading"><main className={styles.statusPage}><p>Loading…</p></main></Layout>;
  }

  const {tree, document} = state;
  const collection = collectionFor(state.site, document.path);
  const isBlog = collection?.type === 'blog';
  if (editing && canEdit) {
    return (
      <Layout title={`Edit ${document.title}`}>
        <Suspense fallback={<main className={styles.statusPage}><p>Loading editor…</p></main>}>
          <DocumentEditor
            userId={state.userId}
            workspaceId={state.workspaceId}
            workspaceSlug={workspaceSlug}
            document={document}
            markdown={state.markdown}
            tree={tree}
            contentType={isBlog ? 'post' : 'page'}
            onCreate={isBlog ? () => createDocument(collection) : null}
            onCreateBefore={!isBlog ? () => createDocument(collection, {document, direction: 'before'}) : null}
            onCreateAfter={!isBlog ? () => createDocument(collection, {document, direction: 'after'}) : null}
            onDelete={canDelete ? () => deleteDocument(document, collection) : null}
            onCancel={() => {
              setEditing(false);
              if (editRequested) {
                navigateClient(`/w/${encodeURIComponent(workspaceSlug)}/documents/${routeForDocument(document.path)}`, {replace: true});
              }
            }}
            onSaved={applySavedDocument}
          />
        </Suspense>
      </Layout>
    );
  }
  const collectionDocuments = (collection
    ? state.documents.filter(item => item.path.startsWith(`${collection.pathPrefix}/`))
    : state.documents).sort((a, b) => compareDocuments(a, b, collection?.type));
  const currentIndex = collectionDocuments.findIndex(item => item.path === document.path);
  const previous = currentIndex > 0 ? collectionDocuments[currentIndex - 1] : null;
  const next = currentIndex >= 0 && currentIndex < collectionDocuments.length - 1
    ? collectionDocuments[currentIndex + 1]
    : null;
  const headings = headingsOf(tree);
  const frontmatter = state.frontmatter || {};
  if (isBlog) {
    const taxonomy = documentTaxonomy({...document, frontmatter});
    const primaryCategory = taxonomy[0]?.category || null;
    const blogSidebar = blogGroupNavigation(
      collectionDocuments,
      workspaceSlug,
      collection,
      documentGroup({...document, frontmatter}),
      primaryCategory,
      null,
      false,
    );
    const Content = createRuntimeBlogContent({
      document: {...document, frontmatter},
      tree,
      toc: headings,
      workspaceId: state.workspaceId,
      workspaceSlug,
      collectionPath: collection.pathPrefix,
      showReadingTime: collection.showReadingTime,
      authors: state.authors,
      previous,
      next,
      onEdit: canEdit ? () => setEditing(true) : null,
    });
    return (
      <BlogPostPage
        content={Content}
        sidebar={blogSidebar}
      />
    );
  }
  const sidebar = sidebarTree(collectionDocuments, collection?.pathPrefix || '', workspaceSlug);
  return (
    <Layout title={document.title} description={frontmatter.description}>
      <HtmlClassNameProvider className={clsx(
        ThemeClassNames.wrapper.docsPages,
        ThemeClassNames.page.docsDocPage,
      )}>
        <DocsSidebarProvider name={collection?.key || null} items={sidebar.length ? sidebar : null}>
          <DocRootLayout>
            <RuntimeDocItem
              document={{...document, frontmatter}}
              tree={tree}
              toc={headings}
              workspaceId={state.workspaceId}
              workspaceSlug={workspaceSlug}
              previous={previous}
              next={next}
              onEdit={canEdit ? () => setEditing(true) : null}
            />
          </DocRootLayout>
        </DocsSidebarProvider>
      </HtmlClassNameProvider>
    </Layout>
  );
}

export default function DocumentRoute() {
  const location = useLocation();
  const match = /^\/w\/([^/]+)\/documents(?:\/(.*))?$/.exec(location.pathname);
  const workspaceSlug = match?.[1] ? decodeURIComponent(match[1]) : '';
  const documentPath = (match?.[2] || '').replace(/\/+$/, '');
  const search = new URLSearchParams(location.search);
  const editRequested = search.get('edit') === '1';
  const groupRequested = search.get('group');
  const categoryRequested = search.get('category');
  const subcategoryRequested = search.get('subcategory');

  return (
    <BrowserOnly fallback={<Layout title={documentPath || 'Workspace'}><main className={styles.statusPage}><p>Loading…</p></main></Layout>}>
      {() => <DocumentBody
        workspaceSlug={workspaceSlug}
        documentPath={documentPath}
        editRequested={editRequested}
        groupRequested={groupRequested}
        categoryRequested={categoryRequested}
        subcategoryRequested={subcategoryRequested}
      />}
    </BrowserOnly>
  );
}
