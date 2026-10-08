import React, {useCallback, useEffect, useMemo, useState} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import {useLocation} from '@docusaurus/router';
import API_BASE, {apiFetch, invalidateApiJson} from '@site/src/utils/api';
import {loadWorkspaces, workspaceSlugFromPath} from '@site/src/utils/workspaces';
import {DOCUMENT_SYNC_EVENT, documentCache, isOffline} from '@site/src/utils/documentCache';
import {clientPlatform} from '@site/src/platform/client';
import SafeDocument from '@site/src/runtime-content/SafeDocument';
import pageStyles from '@site/src/css/page.module.css';
import styles from './styles.module.css';

async function request(path, init) {
  const res = await apiFetch(`${API_BASE}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function routeFor(path) {
  return path.replace(/\.(md|mdx)$/i, '').replace(/\/index$/i, '');
}

function groupDocuments(documents) {
  const root = {name: '', path: '', folders: new Map(), documents: []};
  for (const document of documents) {
    const parts = document.path.split('/');
    let cursor = root;
    for (const part of parts.slice(0, -1)) {
      if (!cursor.folders.has(part)) {
        const path = cursor.path ? `${cursor.path}/${part}` : part;
        cursor.folders.set(part, {name: part, path, folders: new Map(), documents: []});
      }
      cursor = cursor.folders.get(part);
    }
    cursor.documents.push(document);
  }
  return root;
}

/** Where a file lives, as a cloud drive shows it: the server, or also this computer. */
function LocalStatus({held}) {
  if (held?.pending) return <span className={styles.localStatus} title="Edited offline; uploads when you reconnect">↑</span>;
  if (held?.pinned) return <span className={styles.localStatus} title="Kept on this computer">●</span>;
  if (held) return <span className={styles.localStatus} title="On this computer">○</span>;
  return <span className={`${styles.localStatus} ${styles.cloudOnly}`} title="In the cloud only">☁</span>;
}

function TreeNode({node, selectedPath, onSelect, held, depth = 0}) {
  const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  const documents = [...node.documents].sort((a, b) => a.path.localeCompare(b.path));
  return (
    <ul className={styles.treeLevel} style={{'--tree-depth': depth}}>
      {folders.map(folder => (
        <li key={folder.path}>
          <details open>
            <summary className={styles.folder}>{folder.name}</summary>
            <TreeNode node={folder} selectedPath={selectedPath} onSelect={onSelect} held={held} depth={depth + 1} />
          </details>
        </li>
      ))}
      {documents.map(document => (
        <li key={document.id}>
          <button
            type="button"
            className={`${styles.file} ${selectedPath === document.path ? styles.fileActive : ''}`}
            onClick={() => onSelect(document.path)}
            title={document.path}
          >
            <LocalStatus held={held.get(document.path)} />
            {document.path.split('/').pop()}
          </button>
        </li>
      ))}
    </ul>
  );
}

function FileManager() {
  const location = useLocation();
  const workspaceSlug = workspaceSlugFromPath(location.pathname);
  const [workspace, setWorkspace] = useState(null);
  const [userId, setUserId] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [held, setHeld] = useState(() => new Map());
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState(null);
  const [selectedPath, setSelectedPath] = useState(null);
  const [loadedPath, setLoadedPath] = useState(null);
  const [markdown, setMarkdown] = useState('');
  const [savedMarkdown, setSavedMarkdown] = useState('');
  const [tree, setTree] = useState(null);
  const [versions, setVersions] = useState([]);
  const [assets, setAssets] = useState([]);
  const [assetFile, setAssetFile] = useState(null);
  const [assetPath, setAssetPath] = useState('');
  const [mode, setMode] = useState('split');
  const [status, setStatus] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const dirty = markdown !== savedMarkdown;
  const canEdit = workspace?.role === 'owner' || workspace?.role === 'editor';
  const canDelete = workspace?.role === 'owner';

  const apiRoot = workspace
    ? `/api/workspaces/${encodeURIComponent(workspace.id)}/documents`
    : null;
  const assetRoot = workspace
    ? `/api/workspaces/${encodeURIComponent(workspace.id)}/assets`
    : null;

  const scope = useMemo(() => (workspace && userId ? {userId, workspaceId: workspace.id} : null), [userId, workspace]);
  const refreshHeld = useCallback(async () => {
    if (scope) setHeld(await documentCache().cachedPaths(scope));
  }, [scope]);

  // The listing and each document come from the server and are kept in this
  // browser; while the server cannot be reached, the kept copies are shown.
  const cachedRequest = useCallback(async view => {
    try {
      const data = await request(`${apiRoot}${view}`);
      documentCache().remember(scope, view, data)
        .catch(error => console.error('[documents] Browser cache failed:', error));
      return data;
    } catch (error) {
      const kept = isOffline(error) ? await documentCache().read(scope, view) : null;
      if (!kept) throw error;
      return kept.data;
    }
  }, [apiRoot, scope]);

  const refreshTree = useCallback(async (selected = selectedPath) => {
    if (!apiRoot) return;
    const data = await cachedRequest('/tree');
    setDocuments(data.documents || []);
    if (selected && !(data.documents || []).some(document => document.path === selected)) {
      setSelectedPath(null);
      setLoadedPath(null);
      setMarkdown('');
      setSavedMarkdown('');
      setTree(null);
    }
  }, [apiRoot, selectedPath]);

  useEffect(() => {
    let cancelled = false;
    loadWorkspaces()
      .then(({workspaces, userId}) => {
        if (cancelled) return;
        const selected = workspaces.find(item => item.slug === workspaceSlug);
        if (!selected) throw Object.assign(new Error('This workspace does not exist, or you are not a member.'), {status: 404});
        setUserId(userId);
        setWorkspace(selected);
      })
      .catch(error => {
        if (!cancelled) {
          setStatus('error');
          setMessage(error.message);
        }
      });
    return () => { cancelled = true; };
  }, [workspaceSlug]);

  useEffect(() => {
    if (!apiRoot || !scope) return;
    let cancelled = false;
    setStatus('loading');
    Promise.all([
      cachedRequest('/tree'),
      request(assetRoot).catch(error => (isOffline(error) ? {assets: []} : Promise.reject(error))),
    ])
      .then(([data, assetData]) => {
        if (cancelled) return;
        const listed = data.documents || [];
        setDocuments(listed);
        setAssets(assetData.assets || []);
        setStatus('ready');
        const requested = new URLSearchParams(location.search).get('path');
        if (requested && listed.some(document => document.path === requested)) setSelectedPath(requested);
      })
      .catch(error => {
        if (!cancelled) {
          setStatus('error');
          setMessage(error.message);
        }
      });
    return () => { cancelled = true; };
  }, [apiRoot, assetRoot, cachedRequest, location.search, scope]);

  useEffect(() => {
    if (!scope) return undefined;
    refreshHeld();
    const onSync = ({detail}) => {
      if (detail.scope.workspaceId === scope.workspaceId) refreshHeld();
    };
    window.addEventListener(DOCUMENT_SYNC_EVENT, onSync);
    return () => window.removeEventListener(DOCUMENT_SYNC_EVENT, onSync);
  }, [refreshHeld, scope]);

  const select = useCallback(path => {
    if (dirty && !clientPlatform.dialogs.confirm('Discard your unsaved changes?')) return;
    setSelectedPath(path);
  }, [dirty]);

  useEffect(() => {
    if (!apiRoot || !selectedPath || !scope) return;
    let cancelled = false;
    setBusy(true);
    setMessage(null);
    Promise.all([
      cachedRequest(`?path=${encodeURIComponent(selectedPath)}`),
      request(`${apiRoot}/versions?path=${encodeURIComponent(selectedPath)}`)
        .catch(error => (isOffline(error) ? {versions: []} : Promise.reject(error))),
    ]).then(([documentData, versionData]) => {
      if (cancelled) return;
      refreshHeld();
      setLoadedPath(documentData.document.path);
      setLoadedUpdatedAt(documentData.document.updatedAt);
      setMarkdown(documentData.markdown);
      setSavedMarkdown(documentData.markdown);
      setTree(documentData.tree);
      setVersions(versionData.versions || []);
    }).catch(error => {
      if (!cancelled) setMessage(error.message);
    }).finally(() => {
      if (!cancelled) setBusy(false);
    });
    return () => { cancelled = true; };
  }, [apiRoot, cachedRequest, refreshHeld, scope, selectedPath]);

  useEffect(() => {
    if (!apiRoot || !loadedPath || !canEdit || mode === 'editor') return undefined;
    const timer = window.setTimeout(() => {
      request(`${apiRoot}/preview`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({markdown}),
      }).then(data => {
        setTree(data.tree);
        setMessage(null);
      }).catch(error => setMessage(error.message));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [apiRoot, canEdit, loadedPath, markdown, mode]);

  const save = useCallback(async () => {
    if (!apiRoot || !loadedPath || !canEdit) return;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await request(apiRoot, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: loadedPath, markdown, baseUpdatedAt: loadedUpdatedAt}),
      });
      invalidateApiJson(apiRoot);
      setSavedMarkdown(markdown);
      setLoadedUpdatedAt(saved.document.updatedAt);
      setMessage('Saved.');
      await refreshTree(loadedPath);
      const history = await request(`${apiRoot}/versions?path=${encodeURIComponent(loadedPath)}`);
      setVersions(history.versions || []);
    } catch (error) {
      if (!isOffline(error)) {
        setMessage(error.message);
        return;
      }
      try {
        await documentCache().queueSave(scope, {path: loadedPath, markdown, baseUpdatedAt: loadedUpdatedAt, tree});
      } catch (cacheError) {
        setMessage(`You are offline and this browser could not keep the edit: ${cacheError.message}`);
        return;
      }
      setSavedMarkdown(markdown);
      await refreshHeld();
      setMessage('You are offline. The edit is saved in this browser and will upload when you reconnect.');
    } finally {
      setBusy(false);
    }
  }, [apiRoot, canEdit, loadedPath, loadedUpdatedAt, markdown, refreshHeld, refreshTree, scope, tree]);

  // Uploading an offline edit creates a new revision; later saves build on it.
  useEffect(() => {
    const onSync = ({detail}) => {
      if (detail.uploaded && detail.path === loadedPath) setLoadedUpdatedAt(detail.document.updatedAt);
    };
    window.addEventListener(DOCUMENT_SYNC_EVENT, onSync);
    return () => window.removeEventListener(DOCUMENT_SYNC_EVENT, onSync);
  }, [loadedPath]);

  const togglePinned = useCallback(async () => {
    if (!scope || !loadedPath) return;
    const pinned = !held.get(loadedPath)?.pinned;
    try {
      await documentCache().setPinned(scope, loadedPath, pinned);
      await refreshHeld();
    } catch (error) {
      setMessage(error.message);
    }
  }, [held, loadedPath, refreshHeld, scope]);

  const createDocument = useCallback(async () => {
    if (!apiRoot || !canEdit) return;
    const value = clientPlatform.dialogs.prompt('New document path', 'notes/new-page.md')?.trim();
    if (!value) return;
    const path = /\.mdx?$/i.test(value) ? value : `${value}.md`;
    setBusy(true);
    setMessage(null);
    try {
      await request(apiRoot, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path, markdown: `---\ntitle: New page\n---\n\n# New page\n`}),
      });
      invalidateApiJson(apiRoot);
      await refreshTree(path);
      setSelectedPath(path);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }, [apiRoot, canEdit, refreshTree]);

  const renameDocument = useCallback(async () => {
    if (!apiRoot || !loadedPath || !canEdit) return;
    const value = clientPlatform.dialogs.prompt('Move or rename document', loadedPath)?.trim();
    if (!value || value === loadedPath) return;
    const nextPath = /\.mdx?$/i.test(value) ? value : `${value}.md`;
    setBusy(true);
    setMessage(null);
    try {
      await request(`${apiRoot}/move`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({from: loadedPath, to: nextPath}),
      });
      invalidateApiJson(apiRoot);
      setSelectedPath(nextPath);
      setLoadedPath(nextPath);
      await refreshTree(nextPath);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }, [apiRoot, canEdit, loadedPath, refreshTree]);

  const deleteDocument = useCallback(async () => {
    if (!apiRoot || !loadedPath || !canDelete) return;
    if (!clientPlatform.dialogs.confirm(`Delete ${loadedPath}? Its saved versions will be retained until cleanup.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await request(apiRoot, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: loadedPath}),
      });
      invalidateApiJson(apiRoot);
      setSelectedPath(null);
      setLoadedPath(null);
      setMarkdown('');
      setSavedMarkdown('');
      setTree(null);
      setVersions([]);
      await refreshTree(null);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }, [apiRoot, canDelete, loadedPath, refreshTree]);

  const uploadAsset = useCallback(async () => {
    if (!assetRoot || !assetFile || !assetPath || !canEdit) return;
    setBusy(true);
    setMessage(null);
    try {
      const data = await request(`${assetRoot}?path=${encodeURIComponent(assetPath)}`, {
        method: 'PUT',
        headers: {'Content-Type': assetFile.type || 'application/octet-stream'},
        body: await assetFile.arrayBuffer(),
      });
      const listed = await request(assetRoot);
      setAssets(listed.assets || []);
      setAssetFile(null);
      setAssetPath('');
      setMessage(`Uploaded ${data.asset.path}. Use ![description](./relative-path) in Markdown.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }, [assetFile, assetPath, assetRoot, canEdit]);

  const deleteAsset = useCallback(async path => {
    if (!assetRoot || !canDelete || !clientPlatform.dialogs.confirm(`Delete asset ${path}?`)) return;
    setBusy(true);
    try {
      await request(`${assetRoot}?path=${encodeURIComponent(path)}`, {method: 'DELETE'});
      setAssets(current => current.filter(asset => asset.path !== path));
      setMessage(`Deleted ${path}.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }, [assetRoot, canDelete]);

  const loadVersion = useCallback(async seq => {
    if (!apiRoot || !loadedPath) return;
    setBusy(true);
    try {
      const data = await request(`${apiRoot}/versions?path=${encodeURIComponent(loadedPath)}&seq=${encodeURIComponent(seq)}`);
      setMarkdown(data.version.markdown);
      setMessage(`Version ${seq} loaded into the editor. Save to restore it.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }, [apiRoot, loadedPath]);

  const grouped = useMemo(() => groupDocuments(documents), [documents]);

  if (status === 'loading') return <p className={styles.state}>Loading workspace files…</p>;
  if (status === 'error') return <p className={styles.state}>{message}</p>;

  return (
    <main className={`${pageStyles.pageContainer} ${pageStyles.wide} ${styles.page}`}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Workspace content</span>
          <h1>{workspace.name} files</h1>
          <p>Database-backed Markdown, rendered by the same safe Docusaurus components readers see.</p>
        </div>
        <div className={styles.headerActions}>
          <Link className="button button--secondary" to={`/w/${encodeURIComponent(workspace.slug)}/documents`}>View site</Link>
          {canEdit ? <button className="button button--primary" type="button" onClick={createDocument} disabled={busy}>New document</button> : null}
        </div>
      </header>

      {message ? <div className={styles.message} role="status">{message}</div> : null}

      <div className={styles.workspace}>
        <aside className={styles.sidebar} aria-label="Workspace documents">
          <div className={styles.sidebarTitle}>{documents.length} documents</div>
          {documents.length
            ? <TreeNode node={grouped} selectedPath={selectedPath} onSelect={select} held={held} />
            : <p className={styles.empty}>No documents yet.</p>}
          <details className={styles.assets}>
            <summary>Assets ({assets.length})</summary>
            {canEdit ? (
              <div className={styles.assetUpload}>
                <input
                  type="file"
                  accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.json,.zip"
                  onChange={event => {
                    const file = event.target.files?.[0] || null;
                    setAssetFile(file);
                    if (file) {
                      const directory = loadedPath?.includes('/')
                        ? loadedPath.slice(0, loadedPath.lastIndexOf('/') + 1)
                        : '';
                      setAssetPath(`${directory}assets/${file.name}`);
                    }
                  }}
                />
                {assetFile ? (
                  <>
                    <input value={assetPath} onChange={event => setAssetPath(event.target.value)} aria-label="Asset path" />
                    <button type="button" onClick={uploadAsset} disabled={busy || !assetPath}>Upload</button>
                  </>
                ) : null}
              </div>
            ) : null}
            {assets.length ? (
              <ul className={styles.assetList}>
                {assets.map(asset => (
                  <li key={asset.id}>
                    <span title={asset.path}>{asset.path}</span>
                    {canDelete ? <button type="button" onClick={() => deleteAsset(asset.path)} disabled={busy}>×</button> : null}
                  </li>
                ))}
              </ul>
            ) : <p className={styles.empty}>No uploaded assets.</p>}
          </details>
        </aside>

        <section className={styles.editorArea}>
          {!loadedPath ? (
            <div className={styles.blank}>
              <h2>Select a document</h2>
              <p>Choose a file from the workspace tree{canEdit ? ' or create a new one' : ''}.</p>
            </div>
          ) : (
            <>
              <div className={styles.toolbar}>
                <code title={loadedPath}>{loadedPath}</code>
                <div className={styles.modeGroup}>
                  {['editor', 'split', 'preview'].map(value => (
                    <button key={value} type="button" className={mode === value ? styles.modeActive : ''} onClick={() => setMode(value)}>
                      {value}
                    </button>
                  ))}
                </div>
                <div className={styles.actions}>
                  <Link to={`/w/${encodeURIComponent(workspace.slug)}/documents/${routeFor(loadedPath)}`}>Open</Link>
                  <button type="button" onClick={togglePinned} aria-pressed={Boolean(held.get(loadedPath)?.pinned)}>
                    {held.get(loadedPath)?.pinned ? 'Kept on this computer' : 'Keep on this computer'}
                  </button>
                  {canEdit ? <button type="button" onClick={renameDocument} disabled={busy}>Rename</button> : null}
                  {canDelete ? <button type="button" onClick={deleteDocument} disabled={busy}>Delete</button> : null}
                  {canEdit ? <button className="button button--primary button--sm" type="button" onClick={save} disabled={busy || !dirty}>Save</button> : null}
                </div>
              </div>

              <div className={`${styles.panes} ${styles[`mode_${mode}`]}`}>
                {mode !== 'preview' ? (
                  <textarea
                    className={styles.source}
                    value={markdown}
                    onChange={event => setMarkdown(event.target.value)}
                    readOnly={!canEdit}
                    spellCheck="false"
                    aria-label="Markdown source"
                  />
                ) : null}
                {mode !== 'editor' ? (
                  <article className={`${styles.preview} theme-doc-markdown markdown`}>
                    <SafeDocument tree={tree} workspaceId={workspace.id} workspaceSlug={workspace.slug} documentPath={loadedPath} />
                  </article>
                ) : null}
              </div>

              <details className={styles.history}>
                <summary>Version history ({versions.length})</summary>
                {versions.length ? (
                  <ol>
                    {versions.map(version => (
                      <li key={version.id}>
                        <span>Version {version.seq} · {new Date(version.createdAt).toLocaleString()} · {version.length} characters</span>
                        {canEdit ? <button type="button" onClick={() => loadVersion(version.seq)} disabled={busy}>Load</button> : null}
                      </li>
                    ))}
                  </ol>
                ) : <p>No earlier versions.</p>}
              </details>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

export default function FilesPage() {
  return (
    <Layout title="Workspace files">
      <BrowserOnly fallback={<p className={styles.state}>Loading workspace files…</p>}>
        {() => <FileManager />}
      </BrowserOnly>
    </Layout>
  );
}
