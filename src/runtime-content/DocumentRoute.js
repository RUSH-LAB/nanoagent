import React, {Suspense, lazy, useCallback, useEffect, useState} from 'react';
import clsx from 'clsx';
import {useLocation} from '@docusaurus/router';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Link from '@docusaurus/Link';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import BlogListPage from '@theme/BlogListPage';
import BlogPostPage from '@theme/BlogPostPage';
import DocRootLayout from '@theme/DocRoot/Layout';
import {DocsSidebarProvider} from '@docusaurus/plugin-content-docs/client';
import {HtmlClassNameProvider, ThemeClassNames} from '@docusaurus/theme-common';
import API_BASE, {apiJson} from '@site/src/utils/api';
import {loadWorkspaces, navigateClient} from '@site/src/utils/workspaces';
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

function compareDocuments(a, b, type) {
  if (type === 'blog') {
    return String(b.frontmatter?.date || b.updatedAt).localeCompare(String(a.frontmatter?.date || a.updatedAt));
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

function DocumentBody({workspaceSlug, documentPath}) {
  const {siteConfig} = useDocusaurusContext();
  const [state, setState] = useState({status: LOADING});
  const [editing, setEditing] = useState(false);

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
        const {workspaces} = await loadWorkspaces();
        const workspace = workspaces.find(item => item.slug === workspaceSlug);
        if (!workspace) {
          if (!cancelled) setState({status: MISSING});
          return;
        }
        const apiRoot = `${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}`;
        const siteResult = await apiJson(`${apiRoot}/site`, {cacheMs: WORKSPACE_CONTENT_CACHE_MS});
        const site = siteResult.ok ? siteResult.data.site : null;
        const homeLayout = workspaceHomeLayout(site, workspaceSlug);
        const homeDocument = !documentPath && homeLayout === 'document'
          ? site?.site?.homeDocument
          : null;
        const requestedPath = documentPath || homeDocument || '';
        const plan = workspaceContentPlan(site, requestedPath);
        const needsTree = Boolean(documentPath || homeLayout !== 'title');
        const [documentResult, treeResult] = await Promise.all([
          plan.path && !plan.isCollection
            ? apiJson(`${apiRoot}/documents?path=${encodeURIComponent(plan.path)}`, {
                cacheMs: WORKSPACE_CONTENT_CACHE_MS,
              })
            : Promise.resolve({ok: false, status: 404, data: {}}),
          needsTree
            ? apiJson(`${apiRoot}/documents/tree${plan.treeQuery}`, {
                cacheMs: WORKSPACE_CONTENT_CACHE_MS,
              })
            : Promise.resolve({ok: true, status: 200, data: {documents: []}}),
        ]);
        if (cancelled) return;

        const listed = treeResult.ok ? treeResult.data.documents || [] : [];
        const readyBase = {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceRole: workspace.role,
          workspaceSlug,
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
            documents: listed,
            ...readyBase,
          });
          return;
        }
        if (documentResult.status === 404 && treeResult.ok) {
          const prefix = `${documentPath.replace(/\/+$/, '')}/`;
          const children = listed
            .filter(document => document.path.startsWith(prefix))
            .sort((a, b) => a.path.localeCompare(b.path));
          if (children.length > 0) {
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
      } catch (err) {
        if (!cancelled) setState({status: BROKEN, message: err.message});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceSlug, documentPath]);

  const applySavedDocument = useCallback(saved => {
    setState(current => ({
      ...current,
      pending: false,
      tree: saved.tree,
      markdown: saved.markdown,
      frontmatter: saved.frontmatter,
      document: {...current.document, ...saved.document},
      documents: (current.documents || []).map(item => item.path === saved.document.path
        ? {...item, title: saved.document.title, updatedAt: saved.document.updatedAt}
        : item),
    }));
  }, []);

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
    const description = state.directory
      ? directoryCollection?.description || `${visibleDocuments.length} ${visibleDocuments.length === 1 ? 'post' : 'posts'} in this collection`
      : `${visibleDocuments.length} ${visibleDocuments.length === 1 ? 'document' : 'documents'} in this workspace`;
    const sortedDocuments = [...visibleDocuments].sort((a, b) => compareDocuments(a, b, directoryCollection?.type));
    if (isBlogCollection) {
      const items = sortedDocuments.map(document => ({
        content: createRuntimeBlogContent({
          document,
          tree: document.excerptTree,
          workspaceId: state.workspaceId,
          workspaceSlug,
          collectionPath: directoryCollection.pathPrefix,
          showReadingTime: directoryCollection.showReadingTime,
          authors: state.site?.authors,
        }),
      }));
      return (
        <BlogListPage
          metadata={{
            blogTitle: heading,
            blogDescription: description,
            permalink: `/w/${encodeURIComponent(workspaceSlug)}/documents/${directoryCollection.pathPrefix}`,
            page: 1,
            postsPerPage: 'ALL',
            totalPages: 1,
          }}
          items={items}
          sidebar={{title: directoryCollection.sidebarTitle || 'All Posts', items: []}}
        />
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
  const canEdit = state.workspaceRole === 'owner' || state.workspaceRole === 'editor';
  if (editing && canEdit) {
    return (
      <Layout title={`Edit ${document.title}`}>
        <Suspense fallback={<main className={styles.statusPage}><p>Loading editor…</p></main>}>
          <DocumentEditor
            workspaceId={state.workspaceId}
            workspaceSlug={workspaceSlug}
            document={document}
            markdown={state.markdown}
            tree={tree}
            onCancel={() => setEditing(false)}
            onSaved={applySavedDocument}
          />
        </Suspense>
      </Layout>
    );
  }
  const collection = collectionFor(state.site, document.path);
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
  const isBlog = collection?.type === 'blog';
  if (isBlog) {
    const Content = createRuntimeBlogContent({
      document: {...document, frontmatter},
      tree,
      toc: headings,
      workspaceId: state.workspaceId,
      workspaceSlug,
      collectionPath: collection.pathPrefix,
      showReadingTime: collection.showReadingTime,
      authors: state.site?.authors,
      previous,
      next,
      onEdit: canEdit ? () => setEditing(true) : null,
    });
    return (
      <BlogPostPage
        content={Content}
        sidebar={{title: collection.sidebarTitle || 'All Posts', items: []}}
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

  return (
    <BrowserOnly fallback={<Layout title={documentPath || 'Workspace'}><main className={styles.statusPage}><p>Loading…</p></main></Layout>}>
      {() => <DocumentBody workspaceSlug={workspaceSlug} documentPath={documentPath} />}
    </BrowserOnly>
  );
}
