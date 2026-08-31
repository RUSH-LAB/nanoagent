import React, {useEffect, useState} from 'react';
import {useLocation} from '@docusaurus/router';
import Link from '@docusaurus/Link';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import MDXComponents from '@theme/MDXComponents';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import {loadWorkspaces} from '@site/src/utils/workspaces';
import styles from './documentRoute.module.css';

/**
 * A page, fetched and rendered when somebody asks for it.
 *
 * What arrives is an inert render tree. The server has already rejected code,
 * raw HTML, unsafe URLs, unknown components, and non-static attributes.
 */

function childrenOf(node) {
  return (node.children || []).map((child, index) => <SafeNode key={index} node={child} />);
}

function SafeNode({node}) {
  if (!node || node.type === 'empty') return null;
  switch (node.type) {
    case 'root': return <>{childrenOf(node)}</>;
    case 'text': return node.value;
    case 'paragraph': return <p>{childrenOf(node)}</p>;
    case 'heading': return React.createElement(`h${node.depth}`, null, childrenOf(node));
    case 'emphasis': return <em>{childrenOf(node)}</em>;
    case 'strong': return <strong>{childrenOf(node)}</strong>;
    case 'delete': return <del>{childrenOf(node)}</del>;
    case 'blockquote': return <blockquote>{childrenOf(node)}</blockquote>;
    case 'thematicBreak': return <hr />;
    case 'break': return <br />;
    case 'inlineCode': return <code>{node.value}</code>;
    case 'code': return <pre><code className={node.lang ? `language-${node.lang}` : undefined}>{node.value}</code></pre>;
    case 'link': return node.url.startsWith('/')
      ? <Link to={node.url} title={node.title || undefined}>{childrenOf(node)}</Link>
      : <a href={node.url} title={node.title || undefined}>{childrenOf(node)}</a>;
    case 'image': return <img src={node.url} alt={node.alt} title={node.title || undefined} />;
    case 'list': {
      const Tag = node.ordered ? 'ol' : 'ul';
      return <Tag start={node.ordered ? node.start : undefined}>{childrenOf(node)}</Tag>;
    }
    case 'listItem': return <li>{childrenOf(node)}</li>;
    case 'table': return <table><tbody>{childrenOf(node)}</tbody></table>;
    case 'tableRow': return <tr>{childrenOf(node)}</tr>;
    case 'tableCell': return <td>{childrenOf(node)}</td>;
    case 'math': {
      const Tag = node.display ? 'div' : 'span';
      return <Tag className={node.display ? 'math-display' : 'math-inline'} dangerouslySetInnerHTML={{__html: node.html}} />;
    }
    case 'component': {
      const Component = MDXComponents[node.name];
      if (!Component) return null;
      return React.createElement(Component, node.props || {}, childrenOf(node));
    }
    default: return null;
  }
}

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
          const treeRes = await apiFetch(
            `${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/documents/tree`,
          );
          const treePayload = await treeRes.json().catch(() => ({}));
          if (cancelled) return;
          if (treeRes.ok) {
            const prefix = `${documentPath.replace(/\/+$/, '')}/`;
            const children = (treePayload.documents ?? [])
              .filter(document => document.path.startsWith(prefix))
              .sort((a, b) => a.path.localeCompare(b.path));
            if (children.length > 0) {
              setState({status: READY, directory: documentPath, documents: children});
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
        setState(documentPath
          ? {status: READY, tree: payload.tree, document: payload.document}
          : {status: READY, documents: payload.documents ?? []});
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
    const heading = state.directory ? labelForDirectory(state.directory) : 'Documents';
    const description = state.directory
      ? `${state.documents.length} ${state.documents.length === 1 ? 'document' : 'documents'} in this collection`
      : `${state.documents.length} ${state.documents.length === 1 ? 'document' : 'documents'} in this workspace`;
    return (
      <article className={styles.collection}>
        <header className={styles.collectionHeader}>
          <span className={styles.eyebrow}>{state.directory ? 'Collection' : 'Workspace library'}</span>
          <h1>{heading}</h1>
          <p>{description}</p>
        </header>
        {state.documents.length === 0 ? <p className={styles.empty}>This workspace has no documents yet.</p> : (
          <ul className={styles.documentGrid}>
            {state.documents.map(document => {
              const route = routeForDocument(document.path);
              const relative = state.directory
                ? document.path.slice(`${state.directory.replace(/\/+$/, '')}/`.length)
                : document.path;
              return (
                <li key={document.id} className={styles.documentCard}>
                  <Link to={`/w/${encodeURIComponent(workspaceSlug)}/documents/${route}`}>
                    <span className={styles.documentTitle}>{document.title}</span>
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
  return (
    <article>
      {document?.title ? <h1>{document.title}</h1> : null}
      <SafeNode node={tree} />
    </article>
  );
}

export default function DocumentRoute() {
  const location = useLocation();
  const match = /^\/w\/([^/]+)\/documents(?:\/(.*))?$/.exec(location.pathname);
  const workspaceSlug = match?.[1] ? decodeURIComponent(match[1]) : '';
  const documentPath = (match?.[2] || '').replace(/\/+$/, '');

  return (
    <Layout title={documentPath || 'Workspace'}>
      <main className="container margin-vert--lg">
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
