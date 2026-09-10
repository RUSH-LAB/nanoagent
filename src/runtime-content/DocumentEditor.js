import React, {Suspense, lazy, useCallback, useEffect, useMemo, useState} from 'react';
import API_BASE, {apiFetch, invalidateApiJson} from '@site/src/utils/api';
import SafeDocument from './SafeDocument';
import styles from './documentEditor.module.css';

const MarkdownSourceEditor = lazy(() => import('./MarkdownSourceEditor'));
const PREVIEW_DELAY_MS = 300;

const finite = value => Number.isFinite(value) && value >= 0;
const formatCost = value => finite(value) ? `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}` : '—';
const formatTokens = value => finite(value) ? Math.round(value).toLocaleString() : '—';
const formatSeconds = value => finite(value) ? `${value < 0.1 ? value.toFixed(3) : value.toFixed(1)}s` : '—';

function draftKey(workspaceId, documentId) {
  return `mochi:document-draft:${workspaceId}:${documentId}`;
}

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

function recoverDraft(key, markdown, updatedAt) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(key));
    if (saved?.baseUpdatedAt === updatedAt && typeof saved.markdown === 'string' && saved.markdown !== markdown) {
      return saved.markdown;
    }
  } catch {
    // A corrupt local draft is disposable; the database copy remains intact.
  }
  return markdown;
}

export default function DocumentEditor({
  workspaceId, workspaceSlug, document, markdown, tree, onCancel, onSaved,
}) {
  const storageKey = useMemo(() => draftKey(workspaceId, document.id), [workspaceId, document.id]);
  const [baseline, setBaseline] = useState(() => ({markdown, updatedAt: document.updatedAt, tree}));
  const [draft, setDraft] = useState(() => recoverDraft(storageKey, markdown, document.updatedAt));
  const [previewTree, setPreviewTree] = useState(tree);
  const [mode, setMode] = useState('split');
  const [previewStatus, setPreviewStatus] = useState('ready');
  const [saving, setSaving] = useState(false);
  const [completionUsage, setCompletionUsage] = useState({count: 0, totalCost: 0, last: null});
  const [message, setMessage] = useState(
    draft !== markdown ? {kind: 'notice', text: 'Recovered an unsaved draft from this browser.'} : null,
  );
  const dirty = draft !== baseline.markdown;
  const apiRoot = `/api/workspaces/${encodeURIComponent(workspaceId)}/documents`;

  const recordCompletionMetrics = useCallback((telemetry) => {
    const usage = telemetry?.metrics?.usage ?? telemetry?.usage ?? null;
    const cost = telemetry?.metrics?.cost ?? telemetry?.cost;
    setCompletionUsage(current => ({
      count: current.count + 1,
      totalCost: current.totalCost + (finite(cost) ? cost : 0),
      last: {
        cost,
        tokens: usage?.total_tokens,
        duration: telemetry?.metrics?.duration_s,
        profile: telemetry?.profile,
        model: telemetry?.model,
      },
    }));
  }, []);

  useEffect(() => {
    if (!dirty) {
      window.localStorage.removeItem(storageKey);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify({
          markdown: draft,
          baseUpdatedAt: baseline.updatedAt,
          savedAt: new Date().toISOString(),
        }));
      } catch {
        // Editing must continue even when browser storage is unavailable.
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [baseline.updatedAt, dirty, draft, storageKey]);

  useEffect(() => {
    const warn = event => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    if (draft === baseline.markdown) {
      setPreviewTree(baseline.tree);
      setPreviewStatus('ready');
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreviewStatus('loading');
      try {
        const data = await request(`${apiRoot}/preview`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({markdown: draft}),
          signal: controller.signal,
        });
        setPreviewTree(data.tree);
        setPreviewStatus('ready');
        setMessage(current => current?.kind === 'error' ? null : current);
      } catch (error) {
        if (error.name === 'AbortError') return;
        setPreviewStatus('error');
        setMessage({kind: 'error', text: error.message});
      }
    }, PREVIEW_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [apiRoot, baseline.markdown, baseline.tree, draft]);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const data = await request(apiRoot, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          path: document.path,
          markdown: draft,
          baseUpdatedAt: baseline.updatedAt,
        }),
      });
      invalidateApiJson(`${API_BASE}${apiRoot}`);
      const nextDocument = {...document, ...data.document};
      const next = {markdown: draft, updatedAt: data.document.updatedAt, tree: data.tree};
      setBaseline(next);
      setPreviewTree(data.tree);
      window.localStorage.removeItem(storageKey);
      setMessage({kind: 'success', text: `Saved version ${data.version}.`});
      onSaved({document: nextDocument, markdown: draft, tree: data.tree, frontmatter: data.frontmatter || {}});
    } catch (error) {
      setMessage({kind: error.code === 'document-conflict' ? 'conflict' : 'error', text: error.message});
    } finally {
      setSaving(false);
    }
  }, [apiRoot, baseline.updatedAt, dirty, document, draft, onSaved, saving, storageKey]);

  useEffect(() => {
    const shortcut = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [save]);

  const close = () => {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return;
    if (dirty) window.localStorage.removeItem(storageKey);
    onCancel();
  };

  const reloadLatest = async () => {
    if (!window.confirm('Replace this draft with the latest saved version?')) return;
    setSaving(true);
    try {
      const data = await request(`${apiRoot}?path=${encodeURIComponent(document.path)}`);
      const next = {markdown: data.markdown, updatedAt: data.document.updatedAt, tree: data.tree};
      setBaseline(next);
      setDraft(data.markdown);
      setPreviewTree(data.tree);
      window.localStorage.removeItem(storageKey);
      setMessage({kind: 'notice', text: 'Loaded the latest saved version.'});
      onSaved({document: {...document, ...data.document}, markdown: data.markdown, tree: data.tree, frontmatter: data.frontmatter || {}});
    } catch (error) {
      setMessage({kind: 'error', text: error.message});
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className={styles.editorPage}>
      <header className={styles.editorHeader}>
        <div className={styles.editorIdentity}>
          <span className={styles.eyebrow}>Editing</span>
          <strong>{document.title}</strong>
          <code>{document.path}</code>
        </div>
        <div className={styles.modeSwitcher} aria-label="Editor view">
          {['write', 'split', 'preview'].map(value => (
            <button type="button" key={value} className={mode === value ? styles.modeActive : ''} onClick={() => setMode(value)}>{value}</button>
          ))}
        </div>
        <div className={styles.editorActions}>
          <button type="button" className={styles.cancelButton} onClick={close}>Done</button>
          <button type="button" className={styles.saveButton} disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </header>

      {message && (
        <div className={`${styles.editorMessage} ${styles[`message_${message.kind}`]}`} role={message.kind === 'error' || message.kind === 'conflict' ? 'alert' : 'status'}>
          <span>{message.text}</span>
          {message.kind === 'conflict' && <button type="button" onClick={reloadLatest} disabled={saving}>Reload latest</button>}
        </div>
      )}

      <div className={`${styles.editorPanes} ${styles[`mode_${mode}`]}`}>
        {mode !== 'preview' && (
          <section className={styles.sourcePane} aria-label="Markdown editor">
            <div className={styles.sourceHeader}>
              <span>Markdown</span>
              {completionUsage.last ? (
                <small title={[completionUsage.last.profile, completionUsage.last.model].filter(Boolean).join(' · ')}>
                  AI last {formatCost(completionUsage.last.cost)} · {formatTokens(completionUsage.last.tokens)} tokens · {formatSeconds(completionUsage.last.duration)} · session {formatCost(completionUsage.totalCost)}
                </small>
              ) : <small>AI usage appears after a suggestion</small>}
            </div>
            <div className={styles.sourceEditor}>
              <Suspense fallback={<div className={styles.loadingEditor}>Loading editor…</div>}>
                <MarkdownSourceEditor
                  value={draft}
                  onChange={setDraft}
                  documentPath={document.path}
                  documentTitle={document.title}
                  onCompletionMetrics={recordCompletionMetrics}
                />
              </Suspense>
            </div>
          </section>
        )}
        {mode !== 'write' && (
          <section className={styles.previewPane} aria-label="Live preview">
            <div className={styles.previewHeader}>
              <span>Preview</span>
              <small>{previewStatus === 'loading' ? 'Updating…' : previewStatus === 'error' ? 'Last valid preview' : 'Up to date'}</small>
            </div>
            <article className={`${styles.previewContent} theme-doc-markdown markdown`}>
              <SafeDocument tree={previewTree} workspaceId={workspaceId} workspaceSlug={workspaceSlug} documentPath={document.path} />
            </article>
          </section>
        )}
      </div>
    </main>
  );
}
