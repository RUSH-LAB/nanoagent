import React, {useCallback, useEffect, useState} from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {useHistory, useLocation} from '@docusaurus/router';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import Markdown from '@site/src/components/CommandBar/Markdown';
import SidebarLayout from '@site/src/components/SidebarLayout';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import API_BASE, {apiFetch, apiRequest} from '@site/src/utils/api';
import styles from './styles.module.css';

/**
 * The caller's own agent workspace: every file the apps saved for them.
 *
 * The sidebar is the file tree; the content previews the file chosen in it
 * (?path=), or summarizes the workspace when none is. The files live in
 * NanoAgent, in a folder only this member of this workspace reaches
 * (src/server/agent-workspace.js); /api/agent-files lists, serves and deletes
 * them.
 */

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const PDF = /\.pdf$/i;
const MARKDOWN = /\.md$/i;
// Past this a text preview is more scrolling than reading; open the file instead.
const PREVIEW_LIMIT = 1024 * 1024;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(seconds) {
  return new Date(seconds * 1000).toLocaleString();
}

/** The listing as doc sidebar items: a collapsible category per folder, folders first. */
function treeItems(files, fileHref) {
  const root = {folders: new Map(), files: []};
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (const folder of parts.slice(0, -1)) {
      if (!node.folders.has(folder)) node.folders.set(folder, {folders: new Map(), files: []});
      node = node.folders.get(folder);
    }
    node.files.push({label: parts.at(-1), href: fileHref(file.path)});
  }
  const items = node => [
    ...[...node.folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, child]) => ({type: 'category', label, collapsible: true, collapsed: true, items: items(child)})),
    ...node.files
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(file => ({type: 'link', ...file})),
  ];
  return items(root);
}

function TextPreview({url, markdown}) {
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    apiFetch(url)
      .then(async response => {
        if (!response.ok) throw new Error(`Could not open the file (${response.status})`);
        if (!(response.headers.get('content-type') ?? '').startsWith('text/plain')) return false;
        return response.text();
      })
      .then(value => { if (!cancelled) setText(value); })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [url]);

  if (error) return <div className={styles.error}>{error}</div>;
  if (text === null) return <p className={styles.muted}>Loading…</p>;
  if (text === false) return <p className={styles.muted}>This file is not text, so there is no preview. Download it instead.</p>;
  return markdown
    ? <div className={styles.markdown}><Markdown text={text} /></div>
    : <pre className={styles.text}>{text}</pre>;
}

function FilePreview({file, fileUrl, onDelete}) {
  const url = fileUrl(file.path);
  const parts = file.path.split('/');
  let preview;
  if (IMAGE.test(file.path)) preview = <img className={styles.image} src={url} alt={file.path} />;
  else if (PDF.test(file.path)) preview = <iframe className={styles.pdf} src={url} title={file.path} />;
  else if (file.size > PREVIEW_LIMIT) preview = <p className={styles.muted}>Too large to preview here. Open or download it.</p>;
  else preview = <TextPreview url={url} markdown={MARKDOWN.test(file.path)} />;

  return (
    <article className={styles.page}>
      <header className={styles.fileHeader}>
        <div>
          <div className={styles.breadcrumb}>{parts.slice(0, -1).join(' / ') || 'Workspace'}</div>
          <h1>{parts.at(-1)}</h1>
          <p className={styles.muted}>{formatSize(file.size)} · saved {formatTime(file.modified)}</p>
        </div>
        <div className={styles.actions}>
          <a className="button button--secondary button--sm" href={url} target="_blank" rel="noreferrer">Open</a>
          <a className="button button--secondary button--sm" href={fileUrl(file.path, true)}>Download</a>
          <button type="button" className="button button--outline button--danger button--sm" onClick={() => onDelete(file.path)}>Delete</button>
        </div>
      </header>
      <div className={styles.preview}>{preview}</div>
    </article>
  );
}

function Overview({files, truncated, fileHref}) {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const recent = [...files].sort((a, b) => b.modified - a.modified).slice(0, 8);
  return (
    <article className={styles.page}>
      <div className={styles.eyebrow}>Private to you</div>
      <h1>Workspace</h1>
      <p className={styles.muted}>Everything the apps saved for you. Pick a file on the left to view it.</p>
      {!files.length ? (
        <p className={styles.empty}>Nothing here yet. Ask a plugin to save something and it appears here.</p>
      ) : (
        <>
          <p>{files.length}{truncated ? '+' : ''} file{files.length === 1 ? '' : 's'} · {formatSize(total)}</p>
          <h3 className={styles.sectionTitle}>Recently saved</h3>
          <ul className={styles.recent}>
            {recent.map(file => (
              <li key={file.path}>
                <Link to={fileHref(file.path)}>{file.path}</Link>
                <span className={styles.muted}>{formatTime(file.modified)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

function WorkspaceColumns() {
  const location = useLocation();
  const history = useHistory();
  const {slug, workspace} = useWorkspaceSite();
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    if (!workspace) return;
    apiRequest('/api/agent-files', undefined, {failureLabel: 'Could not load your workspace'})
      .then(data => { setListing(data); setError(null); })
      .catch(err => setError(err.message));
  }, [workspace]);
  useEffect(load, [load]);

  const pagePath = `/w/${encodeURIComponent(slug)}/workspace`;
  const fileHref = path => `${pagePath}?path=${encodeURIComponent(path)}`;
  const fileUrl = (path, download = false) => workspace
    ? `${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/agent-files/content?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`
    : '#';
  const remove = async path => {
    if (!window.confirm(`Delete ${path} from your workspace?`)) return;
    try {
      await apiRequest(`/api/agent-files/content?path=${encodeURIComponent(path)}`, {method: 'DELETE'}, {failureLabel: 'Could not delete'});
      history.push(pagePath);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const files = listing?.files ?? [];
  const selectedPath = new URLSearchParams(location.search).get('path');
  const selected = files.find(file => file.path === selectedPath);
  const sidebar = !listing
    ? []
    : files.length
      ? treeItems(files, fileHref)
      : [{type: 'html', value: '<span class="menu__link">No files yet</span>', defaultStyle: false}];

  let content = null;
  if (!slug) content = <p className={styles.muted}>Open Workspace from a workspace.</p>;
  else if (error) content = <div className={styles.error}>{error}</div>;
  else if (listing && selectedPath) {
    content = selected
      ? <FilePreview key={selected.path} file={selected} fileUrl={fileUrl} onDelete={remove} />
      : <div className={styles.error}>{selectedPath} is not in your workspace.</div>;
  } else if (listing) content = <Overview files={files} truncated={listing.truncated} fileHref={fileHref} />;

  return (
    <SidebarLayout
      sidebarKey="workspace"
      sidebar={sidebar}
      activePath={selectedPath ? fileHref(selectedPath) : location.pathname}
    >
      <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading...</div>}>
        {() => <ErrorBoundary>{content}</ErrorBoundary>}
      </BrowserOnly>
    </SidebarLayout>
  );
}

export default function WorkspacePage() {
  return (
    <Layout title="Workspace" description="Files the apps saved for you">
      <WorkspaceColumns />
    </Layout>
  );
}
