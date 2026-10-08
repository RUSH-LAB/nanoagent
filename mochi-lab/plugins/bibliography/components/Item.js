import React, {useEffect, useMemo, useState} from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import styles from './item.module.css';

function PdfViewer({url, title, page}) {
  const [source, setSource] = useState(url);
  const [error, setError] = useState('');

  useEffect(() => {
    let objectUrl = null;
    let cancelled = false;
    if (!url || !url.startsWith('/api/')) {
      setSource(url);
      return undefined;
    }
    setSource(null);
    setError('');
    apiFetch(`${API_BASE}${url}`)
      .then(async response => {
        if (!response.ok) throw new Error('Could not load the managed PDF');
        objectUrl = URL.createObjectURL(await response.blob());
        if (!cancelled) setSource(objectUrl);
      })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (!url) return <div className={styles.pdfEmpty}>No PDF is linked to this paper.</div>;
  return (
    <>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <iframe src={source ? `${source}#page=${page || 1}` : undefined} title={`PDF: ${title}`} className={styles.pdfFrame} />
    </>
  );
}

function PdfUpload({paper, onUploaded}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const upload = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const response = await apiFetch(`${API_BASE}/api/references/${encodeURIComponent(paper.key)}/pdf`, {
        method: 'POST',
        headers: {'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name)},
        body: file,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not upload PDF');
      onUploaded({...paper, pdfUrl: data.pdfUrl});
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <label className={styles.button}>
        {uploading ? 'Uploading…' : paper.pdfUrl ? 'Replace PDF' : 'Upload PDF'}
        <input type="file" accept="application/pdf,.pdf" disabled={uploading} onChange={upload} hidden />
      </label>
      {error ? <span role="alert" className={styles.toolbarError}>{error}</span> : null}
    </>
  );
}

function Annotations({paper, onSelectPage}) {
  const [annotations, setAnnotations] = useState([]);
  const [page, setPage] = useState(1);
  const [quote, setQuote] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiFetch(`${API_BASE}/api/references/${encodeURIComponent(paper.key)}/annotations`)
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load annotations');
        if (!cancelled) setAnnotations(data.annotations || []);
      })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [paper.key]);

  const add = async event => {
    event.preventDefault();
    if (!quote.trim() && !note.trim()) return;
    setSaving(true);
    setError('');
    try {
      const response = await apiFetch(`${API_BASE}/api/references/${encodeURIComponent(paper.key)}/annotations`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({page, quote, body: note}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save annotation');
      setAnnotations(current => [...current, data.annotation].sort((a, b) => a.page - b.page));
      setQuote('');
      setNote('');
      setOpen(false);
      onSelectPage(page);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.annotations}>
      <div className={styles.sectionBar}>
        <strong>Annotations <span>{annotations.length}</span></strong>
        <button type="button" className={styles.textButton} onClick={() => setOpen(current => !current)}>{open ? 'Cancel' : '＋ Add annotation'}</button>
      </div>
      {open ? (
        <form onSubmit={add} className={styles.annotationForm}>
          <label>Page<input type="number" min="1" value={page} onChange={event => setPage(Number(event.target.value))} /></label>
          <textarea value={quote} onChange={event => setQuote(event.target.value)} placeholder="Quoted text (optional)" rows={2} />
          <textarea value={note} onChange={event => setNote(event.target.value)} placeholder="Your annotation" rows={2} />
          <button type="submit" className={styles.primaryButton} disabled={saving || (!quote.trim() && !note.trim())}>{saving ? 'Saving…' : 'Save annotation'}</button>
        </form>
      ) : null}
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <div className={styles.annotationList}>
        {annotations.map(annotation => (
          <button key={annotation.id} type="button" onClick={() => onSelectPage(annotation.page)} className={styles.annotation}>
            <span className={styles.pageBadge}>p. {annotation.page}</span>
            <span>{annotation.quote || annotation.body}</span>
          </button>
        ))}
        {!annotations.length && !open ? <span className={styles.muted}>No annotations yet.</span> : null}
      </div>
    </div>
  );
}

function timeLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
}

function Discussion({paper}) {
  const [comments, setComments] = useState([]);
  const [members, setMembers] = useState({});
  const [viewer, setViewer] = useState(null);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      apiFetch(`${API_BASE}/api/references/${encodeURIComponent(paper.key)}/comments`).then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load discussion');
        return data.comments || [];
      }),
      apiFetch(`${API_BASE}/api/org/members`).then(async response => response.ok ? response.json() : {members: []}),
    ])
      .then(([nextComments, roster]) => {
        if (cancelled) return;
        setComments(nextComments);
        setMembers(Object.fromEntries((roster.members || []).map(member => [member.id, member])));
        setViewer((roster.members || []).find(member => member.you) || null);
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [paper.key]);

  const postComment = async event => {
    event.preventDefault();
    if (!body.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      const response = await apiFetch(`${API_BASE}/api/references/${encodeURIComponent(paper.key)}/comments`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({body, parentId: replyTo?.id || null}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not post comment');
      setComments(current => [...current, data.comment]);
      setBody('');
      setReplyTo(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteComment = async id => {
    const response = await apiFetch(`${API_BASE}/api/reference-comments/${encodeURIComponent(id)}`, {method: 'DELETE'});
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || 'Could not delete comment');
      return;
    }
    setComments(current => current.filter(comment => comment.id !== id));
  };

  const commentById = useMemo(() => Object.fromEntries(comments.map(comment => [comment.id, comment])), [comments]);

  return (
    <aside className={styles.discussion} aria-label="Paper discussion">
      <div className={styles.discussionHeader}>
        <h2>Discussion</h2>
        <span>{comments.length}</span>
      </div>
      <div className={styles.commentList}>
        {loading ? <p className={styles.muted}>Loading discussion…</p> : null}
        {!loading && !comments.length ? <div className={styles.discussionEmpty}><strong>Start the discussion</strong><span>Share a question, observation, or idea about this paper.</span></div> : null}
        {comments.map(comment => {
          const member = members[comment.authorId];
          const parent = comment.parentId ? commentById[comment.parentId] : null;
          const mayDelete = viewer?.id === comment.authorId || viewer?.role === 'owner';
          return (
            <article key={comment.id} className={`${styles.comment} ${comment.parentId ? styles.reply : ''}`}>
              <div className={styles.avatar} aria-hidden="true">{(member?.name || member?.username || 'U').charAt(0).toUpperCase()}</div>
              <div className={styles.commentBody}>
                <div className={styles.commentMeta}>
                  <strong>{member?.name || member?.username || 'Workspace member'}</strong>
                  <time dateTime={comment.createdAt}>{timeLabel(comment.createdAt)}</time>
                </div>
                {parent ? <div className={styles.replyContext}>Replying to {members[parent.authorId]?.name || members[parent.authorId]?.username || 'a comment'}</div> : null}
                <p>{comment.body}</p>
                <div className={styles.commentActions}>
                  <button type="button" onClick={() => setReplyTo(comment)}>Reply</button>
                  {mayDelete ? <button type="button" onClick={() => deleteComment(comment.id)}>Delete</button> : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <form onSubmit={postComment} className={styles.commentComposer}>
        {replyTo ? <div className={styles.replying}>Replying to {members[replyTo.authorId]?.name || members[replyTo.authorId]?.username || 'comment'}<button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply">×</button></div> : null}
        <textarea value={body} onChange={event => setBody(event.target.value)} placeholder="Join the discussion…" rows={3} />
        <div className={styles.composerFooter}>
          {error ? <span role="alert" className={styles.error}>{error}</span> : <span />}
          <button type="submit" className={styles.primaryButton} disabled={saving || !body.trim()}>{saving ? 'Posting…' : 'Comment'}</button>
        </div>
      </form>
    </aside>
  );
}

export default function BibliographyItem() {
  const location = useLocation();
  const bibliographyPath = /^\/w\/[^/]+/.exec(location.pathname)?.[0]
    ? `${/^\/w\/[^/]+/.exec(location.pathname)[0]}/bibliography`
    : '/bibliography';
  const key = decodeURIComponent(location.pathname.split('/bibliography/')[1]?.replace(/\/$/, '') || '');
  const [paper, setPaper] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pdfPage, setPdfPage] = useState(1);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`${API_BASE}/api/references/item/${encodeURIComponent(key)}`)
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load paper');
        if (!cancelled) setPaper({...data.entry, key});
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [key]);

  return (
    <Layout title={paper?.title || 'Paper'} description={paper ? `${paper.title} — reading and discussion` : 'Bibliography paper'}>
      <main className={styles.page}>
        <header className={styles.pageHeader}>
          <Link to={bibliographyPath}>← Bibliography</Link>
          {paper ? <h1 title={paper.title}>{paper.title}</h1> : null}
        </header>
        {loading ? <p>Loading paper…</p> : null}
        {error ? <div className={styles.loadError}><h1>Paper unavailable</h1><p>{error}</p></div> : null}
        {paper ? (
          <div className={styles.workspace}>
            <section className={styles.pdfPanel} aria-label="PDF and annotations">
              <div className={styles.pdfToolbar}>
                <h2>PDF</h2>
                <div className={styles.pdfActions}>
                  <PdfUpload paper={paper} onUploaded={setPaper} />
                  {paper.pdfUrl ? <a href={paper.pdfUrl} target="_blank" rel="noreferrer" className={styles.button}>Open separately ↗</a> : null}
                </div>
              </div>
              <PdfViewer url={paper.pdfUrl} title={paper.title} page={pdfPage} />
              <Annotations paper={paper} onSelectPage={setPdfPage} />
            </section>
            <Discussion paper={paper} />
          </div>
        ) : null}
      </main>
    </Layout>
  );
}
