import React, {useEffect, useState} from 'react';
import {useLocation} from '@docusaurus/router';
import Link from '@docusaurus/Link';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import DocSidebarItems from '@theme/DocSidebarItems';
import TOC from '@theme/TOC';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import {loadWorkspaces} from '@site/src/utils/workspaces';
import SafeDocument from './SafeDocument';
import styles from './documentRoute.module.css';

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
  const name = path.split('/').filter(Boolean).pop() || 'Documents';
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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

function sidebarTree(documents, prefix, workspaceSlug) {
  const root = {folders: new Map(), documents: []};
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
  const convert = node => [
    ...[...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map(folder => ({
      type: 'category',
      label: labelForDirectory(folder.name),
      collapsible: true,
      collapsed: false,
      items: convert(folder),
    })),
    ...[...node.documents].sort((a, b) => a.path.localeCompare(b.path)).map(item => ({
      type: 'link',
      label: item.title,
      href: `/w/${encodeURIComponent(workspaceSlug)}/documents/${routeForDocument(item.path)}`,
      docId: item.path,
      unlisted: false,
    })),
  ];
  return convert(root);
}

function DocumentBody({workspaceSlug, documentPath}) {
  const [state, setState] = useState({status: LOADING});

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setState({status: LOADING});
      try {
        const {workspaces} = await loadWorkspaces();
        const workspace = workspaces.find(item => item.slug === workspaceSlug);
        if (!workspace) {
          if (!cancelled) setState({status: MISSING});
          return;
        }
        const endpoint = documentPath
          ? `${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/documents?path=${encodeURIComponent(documentPath)}`
          : `${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/documents/tree`;
        const res = await apiFetch(endpoint);
        const payload = await res.json().catch(() => ({}));

        if (cancelled) return;
        if (res.status === 404 && documentPath) {
          // A path without an index document may still be a real collection.
          // Research is one: its articles live below posts/research/, so asking
          // for posts/research should show those articles rather than claim the
          // workspace has no content.
          const [treeRes, siteRes] = await Promise.all([
            apiFetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/documents/tree?prefix=${encodeURIComponent(documentPath)}&include=frontmatter`),
            apiFetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/site`),
          ]);
          const [treePayload, sitePayload] = await Promise.all([
            treeRes.json().catch(() => ({})),
            siteRes.json().catch(() => ({})),
          ]);
          if (cancelled) return;
          if (treeRes.ok) {
            const prefix = `${documentPath.replace(/\/+$/, '')}/`;
            const children = (treePayload.documents ?? [])
              .filter(document => document.path.startsWith(prefix))
              .sort((a, b) => a.path.localeCompare(b.path));
            if (children.length > 0) {
              setState({
                status: READY,
                directory: documentPath,
                documents: children,
                site: siteRes.ok ? sitePayload.site : null,
                workspaceId: workspace.id,
                canEdit: workspace.role === 'owner' || workspace.role === 'editor',
              });
              return;
            }
          }
          setState({status: MISSING});
          return;
        }
        if (res.status === 404) {
          setState({status: MISSING});
          return;
        }
        if (!res.ok) {
          setState({status: BROKEN, message: payload.error || `Request failed (${res.status})`});
          return;
        }

        if (cancelled) return;
        const canEdit = workspace.role === 'owner' || workspace.role === 'editor';
        if (documentPath) {
          const [treeResponse, siteResponse] = await Promise.all([
            apiFetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/documents/tree`),
            apiFetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/site`),
          ]);
          const [treeData, siteData] = await Promise.all([
            treeResponse.json().catch(() => ({})),
            siteResponse.json().catch(() => ({})),
          ]);
          if (cancelled) return;
          setState({
            status: READY,
            tree: payload.tree,
            document: payload.document,
            frontmatter: payload.frontmatter || {},
            documents: treeResponse.ok ? treeData.documents || [] : [],
            site: siteResponse.ok ? siteData.site : null,
            workspaceId: workspace.id,
            canEdit,
          });
        } else {
          const siteResponse = await apiFetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/site`);
          const siteData = await siteResponse.json().catch(() => ({}));
          if (cancelled) return;
          setState({
            status: READY,
            documents: payload.documents ?? [],
            site: siteResponse.ok ? siteData.site : null,
            workspaceId: workspace.id,
            canEdit,
          });
        }
      } catch (err) {
        if (!cancelled) setState({status: BROKEN, message: err.message});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceSlug, documentPath]);

  if (state.status === LOADING) {
    return <p>Loading…</p>;
  }

  if (state.status === MISSING) {
    // The API answers the same way for a page that is not there and one this
    // caller may not read, so this wording has to cover both without implying
    // which. Saying "you do not have access" would tell an outsider that the
    // page exists, which is most of what a private page is hiding.
    return (
      <>
        <h1>Nothing here</h1>
        <p>
          There is no page at <code>{documentPath}</code> in this workspace.
        </p>
      </>
    );
  }

  if (state.status === BROKEN) {
    return (
      <>
        <h1>This page could not be rendered</h1>
        <p>{state.message}</p>
      </>
    );
  }

  if (!documentPath || state.directory) {
    const directoryCollection = state.directory ? collectionFor(state.site, state.directory) : null;
    const isBlogCollection = directoryCollection?.type === 'blog';
    const visibleDocuments = !state.directory && state.site?.collections?.length
      ? state.documents.filter(document => state.site.collections.some(collection =>
          document.path.startsWith(`${collection.pathPrefix}/`)))
      : state.documents;
    const heading = directoryCollection?.title || (state.directory ? labelForDirectory(state.directory) : 'Documents');
    const description = state.directory
      ? directoryCollection?.description || `${visibleDocuments.length} ${visibleDocuments.length === 1 ? 'post' : 'posts'} in this collection`
      : `${visibleDocuments.length} ${visibleDocuments.length === 1 ? 'document' : 'documents'} in this workspace`;
    return (
      <article className={`${styles.collection} ${isBlogCollection ? styles.blogCollection : ''}`}>
        <header className={styles.collectionHeader}>
          <div>
            <span className={styles.eyebrow}>{state.directory ? 'Collection' : 'Workspace library'}</span>
            <h1>{heading}</h1>
            <p>{description}</p>
          </div>
          {state.canEdit ? (
            <Link className="button button--secondary button--sm" to={`/w/${encodeURIComponent(workspaceSlug)}/files`}>
              Manage files
            </Link>
          ) : null}
        </header>
        {visibleDocuments.length === 0 ? <p className={styles.empty}>This workspace has no documents yet.</p> : (
          <ul className={isBlogCollection ? styles.blogList : styles.documentGrid}>
            {[...visibleDocuments].sort((a, b) => isBlogCollection
              ? String(b.frontmatter?.date || b.updatedAt).localeCompare(String(a.frontmatter?.date || a.updatedAt))
              : a.path.localeCompare(b.path)).map(document => {
              const route = routeForDocument(document.path);
              const relative = state.directory
                ? document.path.slice(`${state.directory.replace(/\/+$/, '')}/`.length)
                : document.path;
              return (
                <li key={document.id} className={isBlogCollection ? styles.blogCard : styles.documentCard}>
                  <Link to={`/w/${encodeURIComponent(workspaceSlug)}/documents/${route}`}>
                    <span className={styles.documentTitle}>{document.title}</span>
                    {isBlogCollection && document.frontmatter?.date ? (
                      <time className={styles.blogDate} dateTime={document.frontmatter.date}>
                        {new Date(document.frontmatter.date).toLocaleDateString()}
                      </time>
                    ) : null}
                    {isBlogCollection && document.frontmatter?.description ? (
                      <span className={styles.blogDescription}>{document.frontmatter.description}</span>
                    ) : null}
                    {isBlogCollection && document.frontmatter?.tags?.length ? (
                      <span className={styles.blogTags}>{document.frontmatter.tags.join(' · ')}</span>
                    ) : null}
                    <span className={styles.documentPath}>{relative.replace(/\.(md|mdx)$/, '')}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </article>
    );
  }

  const {tree, document} = state;
  const collection = collectionFor(state.site, document.path);
  const collectionDocuments = (collection
    ? state.documents.filter(item => item.path.startsWith(`${collection.pathPrefix}/`))
    : state.documents).sort((a, b) => a.path.localeCompare(b.path));
  const currentIndex = collectionDocuments.findIndex(item => item.path === document.path);
  const previous = currentIndex > 0 ? collectionDocuments[currentIndex - 1] : null;
  const next = currentIndex >= 0 && currentIndex < collectionDocuments.length - 1
    ? collectionDocuments[currentIndex + 1]
    : null;
  const headings = headingsOf(tree);
  const frontmatter = state.frontmatter || {};
  const isBlog = collection?.type === 'blog';
  return (
    <div className={`${styles.documentLayout} ${isBlog ? styles.blogLayout : styles.docsLayout}`}>
      {!isBlog && collectionDocuments.length > 1 ? (
        <aside className={styles.docSidebar}>
          <nav className="menu thin-scrollbar">
            <ul className="theme-doc-sidebar-menu menu__list">
              <DocSidebarItems
                items={sidebarTree(collectionDocuments, collection?.pathPrefix || '', workspaceSlug)}
                activePath={`/w/${encodeURIComponent(workspaceSlug)}/documents/${routeForDocument(document.path)}`}
                level={1}
              />
            </ul>
          </nav>
        </aside>
      ) : null}
      <article className={`${styles.document} ${isBlog ? styles.blogDocument : styles.docsDocument} theme-doc-markdown markdown`}>
      {state.canEdit ? (
        <div className={styles.documentActions}>
          <Link
            className="button button--secondary button--sm"
            to={`/w/${encodeURIComponent(workspaceSlug)}/files?path=${encodeURIComponent(document.path)}`}
          >
            Edit document
          </Link>
        </div>
      ) : null}
      {document?.title ? <h1>{document.title}</h1> : null}
      {isBlog && (frontmatter.date || frontmatter.authors?.length || frontmatter.tags?.length) ? (
        <div className={styles.blogMeta}>
          {frontmatter.date ? <time dateTime={frontmatter.date}>{new Date(frontmatter.date).toLocaleDateString()}</time> : null}
          {frontmatter.authors?.length ? <span>{frontmatter.authors.join(', ')}</span> : null}
          {frontmatter.tags?.length ? <span>{frontmatter.tags.join(' · ')}</span> : null}
        </div>
      ) : null}
      {frontmatter.description ? <p className={styles.description}>{frontmatter.description}</p> : null}
      <SafeDocument tree={tree} workspaceId={state.workspaceId} workspaceSlug={workspaceSlug} documentPath={document.path} />
      <nav className="pagination-nav" aria-label="Document pagination">
        {previous ? (
          <Link className="pagination-nav__link pagination-nav__link--prev" to={`/w/${encodeURIComponent(workspaceSlug)}/documents/${routeForDocument(previous.path)}`}>
            <div className="pagination-nav__sublabel">Previous</div>
            <div className="pagination-nav__label">{previous.title}</div>
          </Link>
        ) : null}
        {next ? (
          <Link className="pagination-nav__link pagination-nav__link--next" to={`/w/${encodeURIComponent(workspaceSlug)}/documents/${routeForDocument(next.path)}`}>
            <div className="pagination-nav__sublabel">Next</div>
            <div className="pagination-nav__label">{next.title}</div>
          </Link>
        ) : null}
      </nav>
      </article>
      {headings.length ? (
        <aside className={styles.toc}>
          <TOC toc={headings} minHeadingLevel={2} maxHeadingLevel={3} />
        </aside>
      ) : null}
    </div>
  );
}

export default function DocumentRoute() {
  const location = useLocation();
  const match = /^\/w\/([^/]+)\/documents(?:\/(.*))?$/.exec(location.pathname);
  const workspaceSlug = match?.[1] ? decodeURIComponent(match[1]) : '';
  const documentPath = (match?.[2] || '').replace(/\/+$/, '');

  return (
    <Layout title={documentPath || 'Workspace'}>
      <main className={styles.runtimeMain}>
        {/*
          The whole route is a fetch against the caller's session, so there is
          nothing for the static build to render and nothing it could render
          correctly: at build time there is no caller. BrowserOnly is how this
          site already keeps session-dependent trees out of the prerender.
        */}
        <BrowserOnly fallback={<p>Loading…</p>}>
          {() => <DocumentBody workspaceSlug={workspaceSlug} documentPath={documentPath} />}
        </BrowserOnly>
      </main>
    </Layout>
  );
}
