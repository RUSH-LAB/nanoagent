import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import ToolsLayout from '@site/src/components/ToolsLayout';
import styles from './styles.module.css';

/**
 * The caller's own agent workspace: every file the apps saved for them.
 *
 * The files live in NanoAgent, in a folder only this member of this workspace
 * reaches (src/server/agent-workspace.js); /api/agent-files lists, serves and
 * deletes them.
 */

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Nest the flat listing by folder: {folders: {name: node}, files: [entry]}. */
function fileTree(files) {
  const root = {folders: {}, files: []};
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (const folder of parts.slice(0, -1)) node = node.folders[folder] ??= {folders: {}, files: []};
    node.files.push({...file, name: parts.at(-1)});
  }
  return root;
}

function FileTree({node, fileHref, onDelete}) {
  return (
    <ul className={styles.fileTree}>
      {Object.entries(node.folders).map(([name, child]) => (
        <li key={`dir:${name}`}>
          <details>
            <summary>📁 {name}</summary>
            <FileTree node={child} fileHref={fileHref} onDelete={onDelete} />
          </details>
        </li>
      ))}
      {node.files.map(file => (
        <li key={file.path} className={styles.fileRow}>
          <a href={fileHref(file.path)} target="_blank" rel="noreferrer">{file.name}</a>
          <span className={styles.muted}>{formatSize(file.size)}</span>
          <button type="button" className={styles.deleteFile} title={`Delete ${file.path}`} onClick={() => onDelete(file.path)}>✕</button>
        </li>
      ))}
    </ul>
  );
}

function WorkspaceApp() {
  const {useCallback, useEffect, useState} = React;
  const {default: API_BASE, apiRequest} = require('@site/src/utils/api');
  const {workspace} = useWorkspaceSite();
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    apiRequest('/api/agent-files', undefined, {failureLabel: 'Could not load your workspace'})
      .then(data => { setListing(data); setError(null); })
      .catch(err => setError(err.message));
  }, []);
  useEffect(load, [load]);

  const fileHref = path => workspace
    ? `${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/agent-files/content?path=${encodeURIComponent(path)}`
    : '#';
  const remove = async path => {
    if (!window.confirm(`Delete ${path} from your workspace?`)) return;
    try {
      await apiRequest(`/api/agent-files/content?path=${encodeURIComponent(path)}`, {method: 'DELETE'}, {failureLabel: 'Could not delete'});
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const files = listing?.files ?? [];
  return (
    <>
      <header className={styles.pageHeader}>
        <div>
          <div className={styles.eyebrow}>Private to you</div>
          <h1>Workspace</h1>
          <p className={styles.muted}>Everything the apps saved for you. Open a file to view it.</p>
        </div>
        <button type="button" className="button button--secondary button--sm" onClick={load}>Refresh</button>
      </header>
      {error && <div className={styles.error}>{error}</div>}
      {listing && !files.length && <p className={styles.muted}>Nothing here yet. Files the apps save for you appear here.</p>}
      {files.length > 0 && (
        <section className={styles.files}>
          <FileTree node={fileTree(files)} fileHref={fileHref} onDelete={remove} />
        </section>
      )}
      {listing?.truncated && <p className={styles.muted}>Showing the first {files.length} files.</p>}
    </>
  );
}

export default function WorkspacePage() {
  return (
    <ToolsLayout title="Workspace" description="Files the apps saved for you">
      <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading...</div>}>
        {() => <ErrorBoundary><WorkspaceApp /></ErrorBoundary>}
      </BrowserOnly>
    </ToolsLayout>
  );
}
