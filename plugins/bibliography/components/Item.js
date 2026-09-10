import React, {useEffect, useState} from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import API_BASE, {apiFetch} from '@site/src/utils/api';

const panel = {
  border: '1px solid var(--ifm-color-emphasis-200)',
  borderRadius: 12,
  background: 'var(--ifm-background-surface-color)',
  padding: 18,
};

const button = {
  border: '1px solid var(--ifm-color-emphasis-300)',
  borderRadius: 7,
  background: 'var(--ifm-background-color)',
  color: 'var(--ifm-font-color-base)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 14,
  fontWeight: 600,
  padding: '7px 12px',
  textDecoration: 'none',
};

function TagEditor({paper, onSaved}) {
  const [value, setValue] = useState((paper.tags || []).join(', '));
  const [officialUrl, setOfficialUrl] = useState(paper.officialUrl || '');
  const [pdfUrl, setPdfUrl] = useState(paper.pdfUrl || '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setValue((paper.tags || []).join(', '));
    setOfficialUrl(paper.officialUrl || '');
    setPdfUrl(paper.pdfUrl || '');
  }, [paper]);

  const save = async event => {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      const response = await apiFetch(`${API_BASE}/api/references/${encodeURIComponent(paper.key)}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          tags: value.split(',').map(tag => tag.trim()).filter(Boolean),
          officialUrl: officialUrl.trim(),
          pdfUrl: pdfUrl.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save paper');
      onSaved(data.entry);
      setMessage('Saved');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} style={{...panel, display: 'grid', gap: 13}}>
      <h2 style={{fontSize: 19, margin: 0}}>Organize and link</h2>
      <label>
        <span style={{display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 4}}>Tags</span>
        <input
          value={value}
          onChange={event => setValue(event.target.value)}
          placeholder="transformers, survey, read-next"
          style={{width: '100%', border: '1px solid var(--ifm-color-emphasis-300)', borderRadius: 7, padding: '8px 10px', font: 'inherit'}}
        />
      </label>
      <label>
        <span style={{display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 4}}>Official paper URL</span>
        <input
          type="url"
          value={officialUrl}
          onChange={event => setOfficialUrl(event.target.value)}
          placeholder="https://doi.org/..."
          style={{width: '100%', border: '1px solid var(--ifm-color-emphasis-300)', borderRadius: 7, padding: '8px 10px', font: 'inherit'}}
        />
      </label>
      <label>
        <span style={{display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 4}}>PDF URL</span>
        <input
          value={pdfUrl}
          onChange={event => setPdfUrl(event.target.value)}
          placeholder="https://.../paper.pdf"
          style={{width: '100%', border: '1px solid var(--ifm-color-emphasis-300)', borderRadius: 7, padding: '8px 10px', font: 'inherit'}}
        />
      </label>
      <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
        <button type="submit" disabled={saving} style={{...button, background: 'var(--ifm-color-primary)', color: '#fff'}}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {message ? <span style={{fontSize: 13, color: message === 'Saved' ? 'var(--ifm-color-success)' : 'var(--ifm-color-danger)'}}>{message}</span> : null}
      </div>
    </form>
  );
}

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

  if (!url) {
    return (
      <section style={{...panel, textAlign: 'center', color: 'var(--ifm-color-emphasis-600)'}}>
        No PDF is linked yet. Add a PDF URL above.
      </section>
    );
  }

  return (
    <section id="paper-pdf" style={{...panel, padding: 0, overflow: 'hidden'}}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 14px', borderBottom: '1px solid var(--ifm-color-emphasis-200)'}}>
        <strong>Paper PDF</strong>
        {source ? <a href={source} target="_blank" rel="noreferrer" style={button}>Open PDF</a> : null}
      </div>
      {error ? <p role="alert" style={{padding: 16, color: 'var(--ifm-color-danger)'}}>{error}</p> : null}
      <iframe
        src={source ? `${source}#page=${page || 1}` : undefined}
        title={`PDF: ${title}`}
        style={{border: 0, display: 'block', width: '100%', height: '72vh', minHeight: 560}}
      />
    </section>
  );
}

function PdfUpload({paper, onUploaded}) {
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');

  const upload = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setMessage('');
    try {
      const response = await apiFetch(`${API_BASE}/api/references/${encodeURIComponent(paper.key)}/pdf`, {
        method: 'POST',
        headers: {'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name)},
        body: file,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not upload PDF');
      onUploaded({...paper, pdfUrl: data.pdfUrl});
      setMessage('PDF saved to this workspace');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <section style={panel}>
      <h2 style={{fontSize: 19, marginTop: 0}}>Workspace PDF</h2>
      <p style={{fontSize: 14, color: 'var(--ifm-color-emphasis-700)'}}>
        Upload a PDF so everyone in this workspace can open and annotate the same file.
      </p>
      <label style={{...button, display: 'inline-block'}}>
        {uploading ? 'Uploading…' : 'Upload PDF'}
        <input type="file" accept="application/pdf,.pdf" disabled={uploading} onChange={upload} style={{display: 'none'}} />
      </label>
      {message ? <p style={{fontSize: 13, marginBottom: 0}}>{message}</p> : null}
    </section>
  );
}

function Annotations({paper, onSelectPage}) {
  const [annotations, setAnnotations] = useState([]);
  const [page, setPage] = useState(1);
  const [quote, setQuote] = useState('');
  const [note, setNote] = useState('');
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
      onSelectPage(page);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section style={{...panel, marginTop: 18}}>
      <h2 style={{fontSize: 19, marginTop: 0}}>Workspace annotations</h2>
      <p style={{fontSize: 14, color: 'var(--ifm-color-emphasis-700)'}}>
        Page-linked notes are visible to everyone in this workspace.
      </p>
      <form onSubmit={add} style={{display: 'grid', gap: 9, marginBottom: 18}}>
        <label>
          <span style={{fontSize: 13, fontWeight: 700}}>Page</span>
          <input type="number" min="1" value={page} onChange={event => setPage(Number(event.target.value))} style={{display: 'block', width: 100, border: '1px solid var(--ifm-color-emphasis-300)', borderRadius: 7, padding: '7px 9px'}} />
        </label>
        <textarea value={quote} onChange={event => setQuote(event.target.value)} placeholder="Quoted text (optional)" rows={2} style={{border: '1px solid var(--ifm-color-emphasis-300)', borderRadius: 7, padding: '8px 10px', font: 'inherit'}} />
        <textarea value={note} onChange={event => setNote(event.target.value)} placeholder="Add a note" rows={3} style={{border: '1px solid var(--ifm-color-emphasis-300)', borderRadius: 7, padding: '8px 10px', font: 'inherit'}} />
        <button type="submit" disabled={saving || (!quote.trim() && !note.trim())} style={{...button, justifySelf: 'start'}}>
          {saving ? 'Saving…' : 'Add annotation'}
        </button>
      </form>
      {error ? <p role="alert" style={{color: 'var(--ifm-color-danger)'}}>{error}</p> : null}
      <div style={{display: 'grid', gap: 8}}>
        {annotations.map(annotation => (
          <button key={annotation.id} onClick={() => onSelectPage(annotation.page)} style={{...panel, cursor: 'pointer', textAlign: 'left', color: 'inherit'}}>
            <strong>Page {annotation.page}</strong>
            {annotation.quote ? <blockquote style={{margin: '7px 0', fontSize: 14}}>{annotation.quote}</blockquote> : null}
            {annotation.body ? <div style={{fontSize: 14}}>{annotation.body}</div> : null}
          </button>
        ))}
        {!annotations.length ? <span style={{fontSize: 14, color: 'var(--ifm-color-emphasis-600)'}}>No annotations yet.</span> : null}
      </div>
    </section>
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
        if (!cancelled) {
          const found = data.entry;
          if (!found) throw new Error('Paper not found');
          setPaper({...found, key});
        }
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [key]);

  const copyCitation = () => navigator.clipboard?.writeText(`[@${key}]`);

  return (
    <Layout title={paper?.title || 'Paper'} description={paper ? `${paper.title} — bibliography paper` : 'Bibliography paper'}>
      <main className="container margin-vert--lg" style={{maxWidth: 1100}}>
        <Link to={bibliographyPath}>← Bibliography</Link>
        {loading ? <p>Loading paper…</p> : null}
        {error ? <div style={{...panel, marginTop: 20}}><h1>Paper unavailable</h1><p>{error}</p></div> : null}
        {paper ? (
          <>
            <header style={{margin: '20px 0 22px'}}>
              <h1 style={{marginBottom: 8}}>{paper.title}</h1>
              <p style={{fontSize: 17, color: 'var(--ifm-color-emphasis-700)', margin: '0 0 6px'}}>
                {(paper.authors || paper.author || []).join(', ') || 'Unknown authors'}
              </p>
              <p style={{margin: 0, color: 'var(--ifm-color-emphasis-600)'}}>
                {[paper.venue, paper.year].filter(Boolean).join(' · ')}
              </p>
              <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14}}>
                <button onClick={copyCitation} style={{...button, background: 'var(--ifm-color-primary)', color: '#fff'}}>
                  Copy [@{key}]
                </button>
                {paper.officialUrl ? <a href={paper.officialUrl} target="_blank" rel="noreferrer" style={button}>Official paper</a> : null}
                {paper.pdfUrl ? <a href="#paper-pdf" style={button}>View PDF</a> : null}
              </div>
            </header>

            <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 18, alignItems: 'start'}}>
              <div style={{display: 'grid', gap: 18}}>
                <section style={panel}>
                  <h2 style={{fontSize: 19, marginTop: 0}}>Source</h2>
                  <dl style={{margin: 0}}>
                    <dt style={{fontWeight: 700}}>Type</dt>
                    <dd style={{margin: '0 0 9px'}}>{paper.source?.type || 'manual'}</dd>
                    {paper.source?.id ? <><dt style={{fontWeight: 700}}>Identifier</dt><dd style={{margin: '0 0 9px', overflowWrap: 'anywhere'}}>{paper.source.id}</dd></> : null}
                    {paper.source?.provider ? <><dt style={{fontWeight: 700}}>Provider</dt><dd style={{margin: 0}}>{paper.source.provider}</dd></> : null}
                  </dl>
                </section>
                <TagEditor paper={paper} onSaved={setPaper} />
                <PdfUpload paper={paper} onUploaded={setPaper} />
              </div>
              <PdfViewer url={paper.pdfUrl} title={paper.title} page={pdfPage} />
            </div>
            <Annotations paper={paper} onSelectPage={setPdfPage} />
          </>
        ) : null}
      </main>
    </Layout>
  );
}
