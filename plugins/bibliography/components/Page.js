import React, {useEffect, useMemo, useState} from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import API_BASE, {apiFetch} from '@site/src/utils/api';

const PAGE_SIZE = 40;

const panel = {
  border: '1px solid var(--ifm-color-emphasis-200)',
  borderRadius: 12,
  background: 'var(--ifm-background-surface-color)',
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

function authorLine(paper) {
  const authors = paper.author || [];
  if (!authors.length) return 'Unknown authors';
  if (authors.length <= 3) return authors.join(', ');
  return `${authors.slice(0, 3).join(', ')} et al.`;
}

function PaperTags({tags = []}) {
  if (!tags.length) return null;
  return (
    <span style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
      {tags.map(tag => (
        <span key={tag} style={{
          borderRadius: 999,
          background: 'var(--ifm-color-emphasis-100)',
          color: 'var(--ifm-color-emphasis-700)',
          fontSize: 12,
          padding: '2px 8px',
        }}>
          {tag}
        </span>
      ))}
    </span>
  );
}

function AddPaper({onAdded}) {
  const [query, setQuery] = useState('');
  const [candidate, setCandidate] = useState(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const findPaper = async event => {
    event.preventDefault();
    if (!query.trim() || working) return;
    setWorking(true);
    setError('');
    setCandidate(null);
    try {
      const response = await apiFetch(`${API_BASE}/api/metadata/search?q=${encodeURIComponent(query.trim())}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Paper lookup failed');
      if (!data.paper?.title) throw new Error('No paper found. Try a DOI, arXiv link, or exact title.');
      setCandidate(data.paper);
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  };

  const addPaper = async () => {
    if (!candidate || working) return;
    setWorking(true);
    setError('');
    try {
      const response = await apiFetch(`${API_BASE}/api/references`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({entry: candidate}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not add paper');
      onAdded(data.entry);
      setQuery('');
      setCandidate(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <section style={{...panel, padding: 18, marginBottom: 22}}>
      <form onSubmit={findPaper} style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
        <input
          aria-label="Paper identifier or title"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Paste a DOI, arXiv link, official URL, or paper title"
          style={{
            flex: '1 1 420px',
            border: '1px solid var(--ifm-color-emphasis-300)',
            borderRadius: 8,
            background: 'var(--ifm-background-color)',
            color: 'var(--ifm-font-color-base)',
            font: 'inherit',
            padding: '10px 12px',
          }}
        />
        <button type="submit" disabled={working || !query.trim()} style={{...button, background: 'var(--ifm-color-primary)', color: '#fff'}}>
          {working && !candidate ? 'Finding…' : 'Find paper'}
        </button>
      </form>

      {error ? <p role="alert" style={{color: 'var(--ifm-color-danger)', margin: '12px 0 0'}}>{error}</p> : null}

      {candidate ? (
        <div style={{borderTop: '1px solid var(--ifm-color-emphasis-200)', marginTop: 16, paddingTop: 16}}>
          <div style={{display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap'}}>
            <div style={{flex: '1 1 420px'}}>
              <strong>{candidate.title}</strong>
              <div style={{color: 'var(--ifm-color-emphasis-700)', fontSize: 14, marginTop: 4}}>
                {authorLine(candidate)}{candidate.year ? ` · ${candidate.year}` : ''}{candidate.venue ? ` · ${candidate.venue}` : ''}
              </div>
              <div style={{fontSize: 13, marginTop: 7}}>
                Source: <strong>{candidate.source?.type || 'manual'}</strong>
                {candidate.source?.provider ? ` via ${candidate.source.provider}` : ''}
              </div>
            </div>
            <button onClick={addPaper} disabled={working} style={{...button, background: 'var(--ifm-color-primary)', color: '#fff'}}>
              {working ? 'Adding…' : 'Add to library'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function PaperRow({paper, bibliographyPath}) {
  const copyCitation = () => navigator.clipboard?.writeText(`[@${paper.key}]`);
  return (
    <article style={{...panel, padding: 16}}>
      <div style={{display: 'flex', gap: 14, justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap'}}>
        <div style={{flex: '1 1 440px', minWidth: 0}}>
          <Link to={`${bibliographyPath}/${encodeURIComponent(paper.key)}`} style={{fontSize: 17, fontWeight: 700}}>
            {paper.title || paper.key}
          </Link>
          <div style={{fontSize: 14, color: 'var(--ifm-color-emphasis-700)', margin: '4px 0 9px'}}>
            {authorLine(paper)}{paper.year ? ` · ${paper.year}` : ''}{paper.venue ? ` · ${paper.venue}` : ''}
          </div>
          <PaperTags tags={paper.tags} />
        </div>
        <div style={{display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap'}}>
          <span title="Metadata source" style={{fontSize: 12, color: 'var(--ifm-color-emphasis-600)'}}>
            {paper.source?.type || 'manual'}
          </span>
          <button onClick={copyCitation} style={button}>Cite</button>
          {paper.officialUrl ? <a href={paper.officialUrl} target="_blank" rel="noreferrer" style={button}>Official</a> : null}
          {paper.pdfUrl?.startsWith('/api/')
            ? <Link to={`${bibliographyPath}/${encodeURIComponent(paper.key)}#paper-pdf`} style={button}>PDF</Link>
            : paper.pdfUrl
              ? <a href={paper.pdfUrl} target="_blank" rel="noreferrer" style={button}>PDF</a>
              : null}
        </div>
      </div>
    </article>
  );
}

export default function BibliographyPage() {
  const location = useLocation();
  const [references, setReferences] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [tag, setTag] = useState('');
  const [exporting, setExporting] = useState(false);
  const [tags, setTags] = useState([]);
  const [total, setTotal] = useState(0);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const workspacePrefix = /^\/w\/[^/]+/.exec(location.pathname)?.[0] || '';
  const bibliographyPath = `${workspacePrefix}/bibliography`;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 120);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({limit: String(PAGE_SIZE)});
    if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
    if (tag) params.set('tag', tag);
    apiFetch(`${API_BASE}/api/references?${params}`, {signal: controller.signal})
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load bibliography');
        if (!cancelled) {
          setReferences(data.references || {});
          setTags(data.tags || []);
          setTotal(data.total || 0);
          setLibraryTotal(data.libraryTotal || 0);
          setHasMore(Boolean(data.hasMore));
        }
      })
      .catch(err => { if (!cancelled && err.name !== 'AbortError') setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [debouncedSearch, tag]);

  const papers = useMemo(
    () => Object.entries(references).map(([key, paper]) => ({...paper, key})),
    [references],
  );
  const shown = papers;

  const handleAdded = paper => {
    setReferences(current => ({[paper.key]: paper, ...current}));
    setTotal(current => current + 1);
    setLibraryTotal(current => current + 1);
    setTags(current => [...new Set([...current, ...(paper.tags || [])])].sort((a, b) => a.localeCompare(b)));
  };
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(papers.length),
      });
      if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
      if (tag) params.set('tag', tag);
      const response = await apiFetch(`${API_BASE}/api/references?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load more papers');
      setReferences(current => ({...current, ...(data.references || {})}));
      setTotal(data.total || 0);
      setHasMore(Boolean(data.hasMore));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingMore(false);
    }
  };
  const exportBibtex = async () => {
    setExporting(true);
    setError('');
    try {
      const response = await apiFetch(`${API_BASE}/api/references/export`);
      if (!response.ok) throw new Error('Could not export bibliography');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'references.bib';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Layout title="Bibliography" description="Papers, sources, PDFs, tags, and citations">
      <main className="container margin-vert--lg" style={{maxWidth: 980}}>
        <header style={{marginBottom: 22}}>
          <h1 style={{marginBottom: 6}}>Bibliography</h1>
          <p style={{color: 'var(--ifm-color-emphasis-700)', margin: 0}}>
            One reliable record for every paper: its citation, source, official page, PDF, and tags.
          </p>
        </header>

        <AddPaper onAdded={handleAdded} />

        <div style={{display: 'flex', gap: 8, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap'}}>
          <input
            aria-label="Search library"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search papers"
            style={{flex: '1 1 300px', border: '1px solid var(--ifm-color-emphasis-300)', borderRadius: 8, padding: '9px 11px', font: 'inherit'}}
          />
          <select value={tag} onChange={event => setTag(event.target.value)} style={{...button, minWidth: 150}}>
            <option value="">All tags</option>
            {tags.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
          <button onClick={exportBibtex} disabled={exporting || libraryTotal === 0} style={button}>
            {exporting ? 'Exporting…' : 'Export BibTeX'}
          </button>
          {!loading ? <span style={{fontSize: 13, color: 'var(--ifm-color-emphasis-600)'}}>{total} papers</span> : null}
        </div>

        {loading ? <p>Loading papers…</p> : null}
        {error ? <p role="alert" style={{color: 'var(--ifm-color-danger)'}}>{error}</p> : null}
        {!loading && !error && !shown.length ? (
          <div style={{...panel, padding: 32, textAlign: 'center', color: 'var(--ifm-color-emphasis-600)'}}>
            {papers.length ? 'No papers match this filter.' : 'Add the first paper using the field above.'}
          </div>
        ) : null}
        <div style={{display: 'grid', gap: 10}}>
          {shown.map(paper => <PaperRow key={paper.key} paper={paper} bibliographyPath={bibliographyPath} />)}
        </div>
        {hasMore ? (
          <div style={{display: 'flex', justifyContent: 'center', padding: '20px 0'}}>
            <button onClick={loadMore} disabled={loadingMore} style={button}>
              {loadingMore ? 'Loading…' : `Show more (${papers.length} of ${total})`}
            </button>
          </div>
        ) : null}
      </main>
    </Layout>
  );
}
