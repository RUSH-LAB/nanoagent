import React, {useEffect, useMemo, useRef, useState} from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import {clientPlatform} from '@site/src/platform/client';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import styles from './page.module.css';

const PAGE_SIZE = 40;

function authorLine(paper) {
  const authors = paper.authors || paper.author || [];
  if (!authors.length) return 'Unknown authors';
  if (authors.length <= 3) return authors.join(', ');
  return `${authors.slice(0, 3).join(', ')} et al.`;
}

function primaryCreator(paper) {
  const author = (paper.authors || paper.author)?.[0];
  if (!author) return 'Unknown';
  const parts = author.trim().split(/\s+/);
  return parts.at(-1) || author;
}

function draftForPaper(paper) {
  return {
    type: paper?.type || 'article',
    title: paper?.title || '',
    authors: (paper?.authors || paper?.author || []).join('\n'),
    year: paper?.year || '',
    venue: paper?.venue || '',
    doi: paper?.doi || '',
    officialUrl: paper?.officialUrl || '',
    pdfUrl: paper?.pdfUrl || '',
  };
}

function PaperIcon({hasPdf}) {
  return <span className={styles.paperIcon} aria-hidden="true">{hasPdf ? '▣' : '▤'}</span>;
}

function AddPaper({onAdded, onClose}) {
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
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className={styles.actionPanel} aria-labelledby="add-paper-title">
      <div className={styles.actionPanelHeader}>
        <div>
          <h2 id="add-paper-title">Add paper</h2>
          <p>Look up reliable metadata before adding it to the library.</p>
        </div>
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close add paper">×</button>
      </div>
      <form onSubmit={findPaper} className={styles.addForm}>
        <input
          autoFocus
          aria-label="Paper identifier or title"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="DOI, arXiv URL, official URL, or title"
        />
        <button type="submit" className={styles.primaryButton} disabled={working || !query.trim()}>
          {working && !candidate ? 'Finding…' : 'Find paper'}
        </button>
      </form>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      {candidate ? (
        <div className={styles.candidate}>
          <PaperIcon hasPdf={Boolean(candidate.pdfUrl)} />
          <div className={styles.candidateText}>
            <strong>{candidate.title}</strong>
            <span>{authorLine(candidate)}{candidate.year ? ` · ${candidate.year}` : ''}{candidate.venue ? ` · ${candidate.venue}` : ''}</span>
          </div>
          <button type="button" onClick={addPaper} disabled={working} className={styles.primaryButton}>
            {working ? 'Adding…' : 'Add to library'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ImportBibtex({onImported, onClose}) {
  const fileInput = useRef(null);
  const [bibtex, setBibtex] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const readFile = event => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setBibtex(String(reader.result || ''));
    reader.onerror = () => setError('Could not read that file');
    reader.readAsText(file);
  };

  const importBibtex = async event => {
    event.preventDefault();
    if (!bibtex.trim() || working) return;
    setWorking(true);
    setError('');
    try {
      const response = await apiFetch(`${API_BASE}/api/references/import-bibtex`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({bibtex}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not import BibTeX');
      onImported(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className={styles.actionPanel} aria-labelledby="import-title">
      <div className={styles.actionPanelHeader}>
        <div>
          <h2 id="import-title">Import BibTeX</h2>
          <p>Choose a .bib file or paste BibTeX records below.</p>
        </div>
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close import">×</button>
      </div>
      <form onSubmit={importBibtex} className={styles.importForm}>
        <input ref={fileInput} type="file" accept=".bib,text/plain" onChange={readFile} hidden />
        <button type="button" className={styles.button} onClick={() => fileInput.current?.click()}>Choose .bib file</button>
        <textarea
          aria-label="BibTeX records"
          value={bibtex}
          onChange={event => setBibtex(event.target.value)}
          placeholder="@article{citation-key, ...}"
          rows={7}
        />
        <div className={styles.importActions}>
          <span>{bibtex ? `${bibtex.length.toLocaleString()} characters` : 'Up to 500 KB'}</span>
          <button type="submit" className={styles.primaryButton} disabled={working || !bibtex.trim()}>
            {working ? 'Importing…' : 'Import'}
          </button>
        </div>
      </form>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    </section>
  );
}

function LibrarySidebar({activeTag, libraryTotal, tags, onSelectTag}) {
  return (
    <aside className={styles.librarySidebar} aria-label="Bibliography navigation">
      <h2>Library</h2>
      <button
        type="button"
        className={`${styles.sidebarItem} ${activeTag ? '' : styles.sidebarItemActive}`}
        onClick={() => onSelectTag('')}
      >
        <span aria-hidden="true">▤</span>
        <span>All papers</span>
        <span className={styles.sidebarCount}>{libraryTotal}</span>
      </button>
      <div className={styles.sidebarSection}>
        <h2>Tags</h2>
        {tags.length ? tags.map(value => (
          <button
            type="button"
            key={value}
            className={`${styles.sidebarItem} ${activeTag === value ? styles.sidebarItemActive : ''}`}
            onClick={() => onSelectTag(value)}
          >
            <span className={styles.tagDot} aria-hidden="true" />
            <span className={styles.sidebarLabel}>{value}</span>
          </button>
        )) : <p className={styles.sidebarEmpty}>Tags added to papers appear here.</p>}
      </div>
    </aside>
  );
}

function PaperTable({papers, bibliographyPath, sort, onSort}) {
  const sortButton = (field, label) => (
    <button type="button" onClick={() => onSort(field)} className={styles.sortButton}>
      {label}<span aria-hidden="true">{sort.field === field ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</span>
    </button>
  );

  return (
    <div className={styles.tableWrap}>
      <table className={styles.paperTable}>
        <thead>
          <tr>
            <th className={styles.iconColumn}><span className={styles.visuallyHidden}>Type</span></th>
            <th>{sortButton('title', 'Title')}</th>
            <th>{sortButton('authors', 'Authors')}</th>
            <th>{sortButton('year', 'Year')}</th>
            <th>{sortButton('venue', 'Venue')}</th>
            <th className={styles.attachmentColumn}><span aria-label="PDF">▣</span></th>
          </tr>
        </thead>
        <tbody>
          {papers.map(paper => (
            <tr
              key={paper.key}
            >
              <td className={styles.iconColumn}><PaperIcon hasPdf={Boolean(paper.pdfUrl)} /></td>
              <td>
                <Link className={styles.paperTitle} to={`${bibliographyPath}/${encodeURIComponent(paper.key)}`}>
                  {paper.title || paper.key}
                </Link>
              </td>
              <td className={styles.creatorCell}>{authorLine(paper)}</td>
              <td>{paper.year || '—'}</td>
              <td className={styles.venueCell}>{paper.venue || '—'}</td>
              <td className={styles.attachmentColumn}>{paper.pdfUrl ? <span title="PDF attached">●</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaperInspector({paper, bibliographyPath, onUpdated, onDeleted}) {
  const [tagsValue, setTagsValue] = useState((paper?.tags || []).join(', '));
  const [draft, setDraft] = useState(() => draftForPaper(paper));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setTagsValue((paper?.tags || []).join(', '));
    setDraft(draftForPaper(paper));
    setEditing(false);
    setMessage('');
  }, [paper?.key]);

  if (!paper) {
    return (
      <aside className={styles.inspector}>
        <div className={styles.inspectorEmpty}>
          <span aria-hidden="true">▤</span>
          <p>Select a paper to inspect its metadata.</p>
        </div>
      </aside>
    );
  }

  const copyCitation = async () => {
    await navigator.clipboard?.writeText(`[@${paper.key}]`);
    setMessage('Citation copied');
  };

  const saveTags = async event => {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      const response = await apiFetch(`${API_BASE}/api/references/${encodeURIComponent(paper.key)}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({tags: tagsValue.split(',').map(value => value.trim()).filter(Boolean)}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save tags');
      onUpdated(data.entry);
      setMessage('Tags saved');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveMetadata = async event => {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      const response = await apiFetch(`${API_BASE}/api/references/${encodeURIComponent(paper.key)}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          type: draft.type,
          title: draft.title.trim(),
          authors: draft.authors.split('\n').map(value => value.trim()).filter(Boolean),
          year: draft.year ? Number(draft.year) : null,
          venue: draft.venue.trim(),
          doi: draft.doi.trim(),
          officialUrl: draft.officialUrl.trim(),
          pdfUrl: draft.pdfUrl.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save metadata');
      onUpdated(data.entry);
      setEditing(false);
      setMessage('Metadata saved');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  };

  const deletePaper = async () => {
    if (!(await clientPlatform.dialogs.confirm(`Delete “${paper.title || paper.key}” from this workspace?`))) return;
    setDeleting(true);
    setMessage('');
    try {
      const response = await apiFetch(`${API_BASE}/api/references/${encodeURIComponent(paper.key)}`, {method: 'DELETE'});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not delete paper');
      onDeleted(paper.key);
    } catch (err) {
      setMessage(err.message);
      setDeleting(false);
    }
  };

  return (
    <aside className={styles.inspector} aria-label="Selected paper details">
      <div className={styles.inspectorHeader}>
        <PaperIcon hasPdf={Boolean(paper.pdfUrl)} />
        <span>{paper.type || 'Paper'}</span>
      </div>
      <div className={styles.inspectorBody}>
        <h2>{paper.title || paper.key}</h2>
        <p className={styles.inspectorAuthors}>{authorLine(paper)}</p>
        <div className={styles.inspectorActions}>
          <button type="button" onClick={copyCitation} className={styles.primaryButton}>Copy [@{paper.key}]</button>
          <Link to={`${bibliographyPath}/${encodeURIComponent(paper.key)}`} className={styles.button}>Open record</Link>
        </div>
        <div className={styles.sectionHeading}>
          <strong>Info</strong>
          <button type="button" onClick={() => setEditing(current => !current)}>{editing ? 'Cancel' : 'Edit'}</button>
        </div>
        {editing ? (
          <form className={styles.metadataEditor} onSubmit={saveMetadata}>
            <label>Item type<select value={draft.type} onChange={event => setDraft(current => ({...current, type: event.target.value}))}><option value="article">Journal article</option><option value="inproceedings">Conference paper</option><option value="book">Book</option><option value="incollection">Book section</option><option value="phdthesis">Thesis</option><option value="misc">Other</option></select></label>
            <label>Title<textarea rows={3} value={draft.title} onChange={event => setDraft(current => ({...current, title: event.target.value}))} required /></label>
            <label>Authors<textarea rows={3} value={draft.authors} onChange={event => setDraft(current => ({...current, authors: event.target.value}))} placeholder="One author per line" /></label>
            <div className={styles.editorPair}>
              <label>Year<input type="number" min="1" max="9999" value={draft.year} onChange={event => setDraft(current => ({...current, year: event.target.value}))} /></label>
              <label>Venue<input value={draft.venue} onChange={event => setDraft(current => ({...current, venue: event.target.value}))} /></label>
            </div>
            <label>DOI<input value={draft.doi} onChange={event => setDraft(current => ({...current, doi: event.target.value}))} /></label>
            <label>Official URL<input type="url" value={draft.officialUrl} onChange={event => setDraft(current => ({...current, officialUrl: event.target.value}))} /></label>
            <label>PDF URL<input value={draft.pdfUrl} onChange={event => setDraft(current => ({...current, pdfUrl: event.target.value}))} /></label>
            <button type="submit" className={styles.primaryButton} disabled={saving}>{saving ? 'Saving…' : 'Save metadata'}</button>
          </form>
        ) : (
          <dl className={styles.metadataList}>
            <div><dt>Citation key</dt><dd>{paper.key}</dd></div>
            <div><dt>Year</dt><dd>{paper.year || '—'}</dd></div>
            <div><dt>Publication</dt><dd>{paper.venue || '—'}</dd></div>
            {paper.doi ? <div><dt>DOI</dt><dd>{paper.doi}</dd></div> : null}
            {paper.arxivId ? <div><dt>arXiv</dt><dd>{paper.arxivId}</dd></div> : null}
            <div><dt>Source</dt><dd>{paper.source?.type || 'manual'}</dd></div>
          </dl>
        )}
        <form className={styles.tagEditor} onSubmit={saveTags}>
          <label htmlFor="paper-tags">Tags</label>
          <input id="paper-tags" value={tagsValue} onChange={event => setTagsValue(event.target.value)} placeholder="survey, read-next" />
          <button type="submit" className={styles.button} disabled={saving}>{saving ? 'Saving…' : 'Save tags'}</button>
        </form>
        <div className={styles.linkList}>
          {paper.officialUrl ? <a href={paper.officialUrl} target="_blank" rel="noreferrer">Open official page ↗</a> : null}
          {paper.pdfUrl ? <Link to={`${bibliographyPath}/${encodeURIComponent(paper.key)}#paper-pdf`}>Open PDF</Link> : null}
        </div>
        {message ? <p role="status" className={styles.statusMessage}>{message}</p> : null}
      </div>
      <div className={styles.inspectorFooter}>
        <button type="button" className={styles.dangerButton} onClick={deletePaper} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete paper'}
        </button>
      </div>
    </aside>
  );
}

export default function BibliographyPage() {
  const location = useLocation();
  const [references, setReferences] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [tag, setTag] = useState('');
  const [exporting, setExporting] = useState(false);
  const [tags, setTags] = useState([]);
  const [total, setTotal] = useState(0);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activePanel, setActivePanel] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [sort, setSort] = useState({field: 'year', direction: 'desc'});
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
          const nextReferences = data.references || {};
          setReferences(nextReferences);
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
  }, [debouncedSearch, tag, refreshKey]);

  const papers = useMemo(() => Object.entries(references).map(([key, paper]) => ({...paper, key})), [references]);
  const sortedPapers = useMemo(() => {
    const direction = sort.direction === 'asc' ? 1 : -1;
    return [...papers].sort((a, b) => {
      if (sort.field === 'year') return direction * ((a.year || 0) - (b.year || 0));
      if (sort.field === 'authors') return direction * primaryCreator(a).localeCompare(primaryCreator(b));
      if (sort.field === 'venue') return direction * String(a.venue || '').localeCompare(String(b.venue || ''));
      return direction * String(a.title || '').localeCompare(String(b.title || ''));
    });
  }, [papers, sort]);
  const changeSort = field => {
    setSort(current => current.field === field
      ? {field, direction: current.direction === 'asc' ? 'desc' : 'asc'}
      : {field, direction: field === 'year' ? 'desc' : 'asc'});
  };

  const handleAdded = paper => {
    setReferences(current => ({[paper.key]: paper, ...current}));
    setTotal(current => current + 1);
    setLibraryTotal(current => current + 1);
    setTags(current => [...new Set([...current, ...(paper.tags || [])])].sort((a, b) => a.localeCompare(b)));
    setNotice('Paper added to the library');
  };

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const params = new URLSearchParams({limit: String(PAGE_SIZE), offset: String(papers.length)});
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

  const handleImported = result => {
    setActivePanel('');
    setNotice(`Imported ${result.added} paper${result.added === 1 ? '' : 's'}${result.skipped ? ` · ${result.skipped} skipped` : ''}`);
    setRefreshKey(current => current + 1);
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
      <main className={styles.page}>
        <header className={styles.pageHeader}>
          <div><h1>Bibliography</h1><p>{libraryTotal} {libraryTotal === 1 ? 'paper' : 'papers'} in this workspace</p></div>
          <div className={styles.toolbarActions}>
            <button type="button" className={styles.primaryButton} onClick={() => setActivePanel(current => current === 'add' ? '' : 'add')}>＋ Add</button>
            <button type="button" className={styles.button} onClick={() => setActivePanel(current => current === 'import' ? '' : 'import')}>Import</button>
            <button type="button" className={styles.button} onClick={exportBibtex} disabled={exporting || libraryTotal === 0}>{exporting ? 'Exporting…' : 'Export'}</button>
          </div>
        </header>
        {activePanel === 'add' ? <AddPaper onAdded={handleAdded} onClose={() => setActivePanel('')} /> : null}
        {activePanel === 'import' ? <ImportBibtex onImported={handleImported} onClose={() => setActivePanel('')} /> : null}
        {error ? <p role="alert" className={styles.pageAlert}>{error}</p> : null}
        {notice ? <p role="status" className={styles.pageNotice}>{notice}</p> : null}
        <section className={styles.libraryShell} aria-label="Bibliography library">
          <LibrarySidebar activeTag={tag} libraryTotal={libraryTotal} tags={tags} onSelectTag={setTag} />
          <div className={styles.libraryMain}>
            <div className={styles.searchToolbar}>
              <label className={styles.searchField}>
                <span aria-hidden="true">⌕</span>
                <input aria-label="Search library" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search title, author, tag, or citation key" />
                {search ? <button type="button" onClick={() => setSearch('')} aria-label="Clear search">×</button> : null}
              </label>
              <span className={styles.resultCount}>{loading ? 'Loading…' : `${total} ${total === 1 ? 'item' : 'items'}`}</span>
            </div>
            {loading ? <div className={styles.emptyState}>Loading your library…</div> : null}
            {!loading && !error && !sortedPapers.length ? (
              <div className={styles.emptyState}>
                <strong>{search || tag ? 'No matching papers' : 'Your library is empty'}</strong>
                <span>{search || tag ? 'Try another search or tag.' : 'Add a paper by DOI, arXiv URL, or title.'}</span>
              </div>
            ) : null}
            {!loading && sortedPapers.length ? (
              <>
                <PaperTable papers={sortedPapers} bibliographyPath={bibliographyPath} sort={sort} onSort={changeSort} />
                {hasMore ? <div className={styles.loadMore}><button type="button" onClick={loadMore} disabled={loadingMore} className={styles.button}>{loadingMore ? 'Loading…' : `Load more (${papers.length} of ${total})`}</button></div> : null}
              </>
            ) : null}
          </div>
        </section>
      </main>
    </Layout>
  );
}
