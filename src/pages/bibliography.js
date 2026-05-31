import React, { useState, useMemo, useCallback, useEffect, useRef, lazy, Suspense } from 'react';

/* ── Year-based navigation components ──────────────────────────── */

const YEAR_NAV_HEIGHT = 48;
const OLDER_CUTOFF = 2020; // years before this are grouped under "Older"

function YearNavBar({ yearGroups, activeYear }) {
  const handleClick = (yearLabel) => {
    const el = document.getElementById(`year-section-${yearLabel}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div style={{
      position: 'sticky',
      top: 0,
      zIndex: 100,
      background: 'var(--ifm-background-color)',
      borderBottom: '1px solid var(--ifm-color-emphasis-200)',
      padding: '8px 0',
      marginBottom: '16px',
      display: 'flex',
      gap: '8px',
      flexWrap: 'wrap',
      alignItems: 'center',
    }}>
      {yearGroups.map(({ label }) => (
        <button
          key={label}
          onClick={() => handleClick(label)}
          style={{
            padding: '4px 14px',
            borderRadius: '16px',
            border: activeYear === label
              ? '1px solid var(--ifm-color-primary)'
              : '1px solid var(--ifm-color-emphasis-200)',
            background: activeYear === label
              ? 'var(--ifm-color-primary)'
              : 'var(--ifm-color-emphasis-100)',
            color: activeYear === label
              ? '#fff'
              : 'var(--ifm-font-color-base)',
            cursor: 'pointer',
            fontSize: '0.82em',
            fontWeight: 600,
            fontFamily: 'inherit',
            transition: 'background 0.15s, color 0.15s, border-color 0.15s',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function YearSectionHeader({ label, count }) {
  return (
    <h3
      id={`year-section-${label}`}
      style={{
        scrollMarginTop: `${YEAR_NAV_HEIGHT + 16}px`,
        margin: '24px 0 12px 0',
        paddingBottom: '6px',
        borderBottom: '2px solid var(--ifm-color-emphasis-200)',
        fontSize: '1.1em',
        color: 'var(--ifm-font-color-base)',
      }}
    >
      {label}{' '}
      <span style={{
        fontSize: '0.78em',
        fontWeight: 400,
        color: 'var(--ifm-color-emphasis-500)',
      }}>
        ({count} {count === 1 ? 'paper' : 'papers'})
      </span>
    </h3>
  );
}

function BackToTopButton({ visible }) {
  if (!visible) return null;
  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="Back to top"
      style={{
        position: 'fixed',
        bottom: '2rem',
        right: '2rem',
        width: '44px',
        height: '44px',
        borderRadius: '50%',
        border: '1px solid var(--ifm-color-emphasis-300)',
        background: 'var(--ifm-background-color)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '1.2em',
        color: 'var(--ifm-color-primary)',
        zIndex: 200,
        transition: 'opacity 0.2s',
      }}
      title="Back to top"
    >
      &#8593;
    </button>
  );
}

function useActiveYearOnScroll(yearGroups) {
  const [activeYear, setActiveYear] = useState('');
  const [showBackToTop, setShowBackToTop] = useState(false);

  useEffect(() => {
    if (!yearGroups.length) return;
    const handleScroll = () => {
      setShowBackToTop(window.scrollY > 400);

      // Find which year section header is nearest to (but above) the viewport top
      let current = yearGroups[0]?.label || '';
      for (const { label } of yearGroups) {
        const el = document.getElementById(`year-section-${label}`);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= YEAR_NAV_HEIGHT + 40) {
            current = label;
          } else {
            break;
          }
        }
      }
      setActiveYear(current);
    };

    handleScroll(); // initial
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [yearGroups]);

  return { activeYear, showBackToTop };
}
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import { usePluginData } from '@docusaurus/useGlobalData';
import BrowserOnly from '@docusaurus/BrowserOnly';
import API_BASE from '@site/src/utils/api';

const CitationGraph = lazy(() => import('../components/CitationGraph'));

function formatAuthors(authors) {
  if (!authors || authors.length === 0) return 'Unknown';
  if (authors.length <= 3) return authors.join(', ');
  return `${authors.slice(0, 3).join(', ')}, et al.`;
}

function toBibTeX(key, entry) {
  const type = entry.type || 'misc';
  const fields = [];
  if (entry.title) fields.push(`  title = {${entry.title}}`);
  if (entry.author?.length) fields.push(`  author = {${entry.author.join(' and ')}}`);
  if (entry.year) fields.push(`  year = {${entry.year}}`);
  if (entry.venue) fields.push(`  journal = {${entry.venue}}`);
  if (entry.volume) fields.push(`  volume = {${entry.volume}}`);
  if (entry.pages) fields.push(`  pages = {${entry.pages}}`);
  if (entry.doi) fields.push(`  doi = {${entry.doi}}`);
  if (entry.url) fields.push(`  url = {${entry.url}}`);
  return `@${type}{${key},\n${fields.join(',\n')}\n}`;
}

function CopyCiteButton({ citationKey }) {
  const [copied, setCopied] = useState(false);
  const text = `[@${citationKey}]`;

  const handleCopy = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      onClick={handleCopy}
      title={`Copy ${text}`}
      style={{
        padding: '2px 8px', border: '1px solid var(--ifm-color-emphasis-200)',
        borderRadius: 4, background: copied ? 'var(--ifm-color-success-contrast-background)' : 'transparent',
        cursor: 'pointer',
        fontSize: '0.75em',
        color: copied ? 'var(--ifm-color-success-dark)' : 'var(--ifm-color-emphasis-600)',
        fontFamily: 'inherit',
        transition: 'background 0.15s, color 0.15s',
      }}
    >
      {copied ? 'Copied!' : 'Cite'}
    </button>
  );
}

function ReferenceEntry({ citationKey, entry }) {
  const authors = formatAuthors(entry.author);
  const venue = entry.venue || '';
  const vol = entry.volume ? `, vol. ${entry.volume}` : '';
  const pages = entry.pages ? `, pp. ${entry.pages}` : '';
  const [bibtexOpen, setBibtexOpen] = useState(false);
  const bibtex = toBibTeX(citationKey, entry);

  return (
    <div id={`ref-${citationKey}`} className="reference-item" style={{
      padding: '12px 16px',
      marginBottom: '8px',
      borderRadius: '6px',
      border: '1px solid var(--ifm-color-emphasis-200)',
      scrollMarginTop: `${YEAR_NAV_HEIGHT + 80}px`,
    }}>
      <div style={{ marginBottom: '4px', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Link to={`/bibliography/${citationKey}`} style={{ textDecoration: 'none' }}>
          <code style={{ fontSize: '0.85em', color: 'var(--ifm-color-primary)' }}>
            @{citationKey}
          </code>
        </Link>
        <span style={{
          fontSize: '0.8em', padding: '2px 6px', borderRadius: '3px',
          backgroundColor: 'var(--ifm-color-emphasis-100)',
          color: 'var(--ifm-color-emphasis-700)',
        }}>
          {entry.type || 'misc'}
        </span>
        <CopyCiteButton citationKey={citationKey} />
        <button
          onClick={() => {
            navigator.clipboard?.writeText(bibtex);
            setBibtexOpen(!bibtexOpen);
          }}
          style={{
            marginLeft: 'auto', padding: '2px 8px', border: '1px solid var(--ifm-color-emphasis-200)',
            borderRadius: 4, background: 'transparent', cursor: 'pointer',
            fontSize: '0.75em', color: 'var(--ifm-color-emphasis-600)', fontFamily: 'inherit',
          }}
          title="Copy BibTeX"
        >
          BibTeX
        </button>
      </div>
      <div style={{ fontWeight: 600, marginBottom: '4px' }}>
        {entry.url ? (
          <a href={entry.url} target="_blank" rel="noopener noreferrer">
            {entry.title}
          </a>
        ) : (
          entry.title
        )}
      </div>
      <div style={{ fontSize: '0.9em', color: 'var(--ifm-color-emphasis-700)' }}>
        {authors} ({entry.year || '????'})
        {venue && <span> &mdash; {venue}{vol}{pages}</span>}
      </div>
      {entry.doi && (
        <div style={{ fontSize: '0.85em', marginTop: '2px' }}>
          DOI: <a href={`https://doi.org/${entry.doi}`} target="_blank" rel="noopener noreferrer">
            {entry.doi}
          </a>
        </div>
      )}
      {bibtexOpen && (
        <pre style={{
          marginTop: 8, padding: '8px 12px', borderRadius: 6,
          background: 'var(--ifm-color-emphasis-100)',
          fontSize: '0.78em', lineHeight: 1.5, overflow: 'auto',
        }}>
          {bibtex}
        </pre>
      )}
      <BrowserOnly>
        {() => {
          const PaperNotes = require('../components/PaperNotes').default;
          return <PaperNotes citationKey={citationKey} title={entry.title} />;
        }}
      </BrowserOnly>
    </div>
  );
}

function TrackAllPreprints({ references }) {
  const [tracking, setTracking] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const preprintCount = useMemo(() => {
    return Object.values(references || {}).filter((entry) => {
      const hasArxiv = !!entry.arxivId;
      return hasArxiv && !entry.publishedVenue;
    }).length;
  }, [references]);

  if (preprintCount === 0) return null;

  const handleTrackAll = () => {
    setTracking(true);
    setError(null);
    setResult(null);
    fetch(`${API_BASE}/api/references/track-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setResult(data);
        }
      })
      .catch((err) => setError('Failed: ' + err.message))
      .finally(() => setTracking(false));
  };

  return (
    <div style={{
      border: '1px solid var(--ifm-color-emphasis-200)',
      borderRadius: '6px',
      padding: '1rem',
      marginBottom: '1.5rem',
      background: 'var(--ifm-color-emphasis-0)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '0.9em' }}>Preprint Tracking</strong>
        <span style={{
          fontSize: '0.8em',
          color: 'var(--ifm-color-emphasis-600)',
        }}>
          {preprintCount} preprint{preprintCount !== 1 ? 's' : ''} to check
        </span>
        <button
          onClick={handleTrackAll}
          disabled={tracking}
          style={{
            marginLeft: 'auto',
            padding: '6px 14px',
            border: '1px solid var(--ifm-color-primary)',
            borderRadius: '6px',
            background: tracking ? 'var(--ifm-color-emphasis-200)' : 'var(--ifm-color-primary)',
            color: tracking ? 'var(--ifm-color-emphasis-600)' : '#fff',
            cursor: tracking ? 'not-allowed' : 'pointer',
            fontSize: '0.85em',
            fontWeight: 600,
            fontFamily: 'inherit',
          }}
        >
          {tracking ? 'Checking All Preprints...' : 'Check All Preprints'}
        </button>
      </div>

      {tracking && (
        <div style={{
          marginTop: '0.75rem',
          fontSize: '0.85em',
          color: 'var(--ifm-color-emphasis-600)',
          fontStyle: 'italic',
        }}>
          Checking {preprintCount} preprints via Semantic Scholar (1 per second)...
        </div>
      )}

      {error && (
        <div style={{
          marginTop: '0.75rem',
          color: 'var(--ifm-color-danger-dark)',
          background: 'var(--ifm-color-danger-contrast-background)',
          border: '1px solid var(--ifm-color-danger-dark)',
          borderRadius: '4px',
          padding: '0.5rem 1rem',
          fontSize: '0.85em',
        }}>
          {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: '0.75rem', fontSize: '0.85em' }}>
          <p style={{ margin: '0 0 6px 0', fontWeight: 600 }}>
            Checked {result.checked} preprints, {result.updated} newly published
          </p>
          {result.results.filter(r => r.published).length > 0 && (
            <div style={{
              background: 'var(--ifm-color-success-contrast-background)',
              borderRadius: '4px',
              padding: '0.5rem 0.75rem',
            }}>
              {result.results.filter(r => r.published).map((r) => (
                <div key={r.key} style={{ margin: '2px 0' }}>
                  <code>@{r.key}</code> -- published at <strong>{r.venue}</strong>
                </div>
              ))}
            </div>
          )}
          {result.updated === 0 && (
            <p style={{ margin: '4px 0 0 0', color: 'var(--ifm-color-emphasis-600)' }}>
              No new publications found. All checked preprints remain unpublished.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SearchAndAddPapers({ existingKeys }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [addedKeys, setAddedKeys] = useState({});
  const [addingKey, setAddingKey] = useState(null);
  const [feedbackMsg, setFeedbackMsg] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }

    setSearching(true);
    setSearchError(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      const encoded = encodeURIComponent(query.trim());
      fetch(
        `https://api.semanticscholar.org/graph/v1/paper/search?query=${encoded}&limit=10&fields=title,authors,year,venue,externalIds,url`
      )
        .then((res) => {
          if (!res.ok) throw new Error(`Semantic Scholar returned ${res.status}`);
          return res.json();
        })
        .then((data) => {
          setResults(data.data || []);
          setSearching(false);
        })
        .catch((err) => {
          setSearchError(err.message);
          setResults([]);
          setSearching(false);
        });
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const generateCitationKey = (paper) => {
    let lastName = 'unknown';
    if (paper.authors && paper.authors.length > 0) {
      const name = paper.authors[0].name || '';
      const parts = name.trim().split(/\s+/);
      lastName = (parts[parts.length - 1] || 'unknown').toLowerCase().replace(/[^a-z]/g, '');
    }
    const year = paper.year || 'nd';
    let key = `${lastName}${year}`;
    // Avoid collisions with existing bibliography keys and keys added in this session
    const allUsed = { ...existingKeys, ...addedKeys };
    if (allUsed[key]) {
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      for (let i = 0; i < letters.length; i++) {
        const candidate = `${key}${letters[i]}`;
        if (!allUsed[candidate]) {
          key = candidate;
          break;
        }
      }
    }
    return key;
  };

  const handleAdd = (paper) => {
    const citationKey = generateCitationKey(paper);
    setAddingKey(paper.paperId);
    setFeedbackMsg(null);

    const refData = {
      key: citationKey,
      title: paper.title || '',
      author: (paper.authors || []).map((a) => a.name),
      year: paper.year || null,
      venue: paper.venue || '',
      url: paper.url || '',
      type: 'article',
    };

    if (paper.externalIds) {
      if (paper.externalIds.DOI) refData.doi = paper.externalIds.DOI;
      if (paper.externalIds.ArXiv) refData.arxivId = paper.externalIds.ArXiv;
    }

    fetch(`${API_BASE}/api/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(refData),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setFeedbackMsg({ type: 'error', text: data.error });
        } else {
          setAddedKeys((prev) => ({ ...prev, [citationKey]: true }));
          setFeedbackMsg({ type: 'success', text: `Added @${citationKey} to bibliography` });
        }
      })
      .catch((err) => {
        setFeedbackMsg({ type: 'error', text: 'Failed to add: ' + err.message });
      })
      .finally(() => setAddingKey(null));
  };

  return (
    <div style={{
      border: '1px solid var(--ifm-color-emphasis-200)',
      borderRadius: '6px',
      padding: '1rem',
      marginBottom: '1.5rem',
      background: 'var(--ifm-color-emphasis-0)',
    }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}
        onClick={() => setExpanded(!expanded)}
      >
        <strong style={{ fontSize: '0.9em' }}>Search &amp; Add Papers</strong>
        <span style={{
          fontSize: '0.8em',
          color: 'var(--ifm-color-emphasis-600)',
        }}>
          Search Semantic Scholar and add papers to your bibliography
        </span>
        <span style={{
          marginLeft: 'auto',
          fontSize: '0.85em',
          color: 'var(--ifm-color-emphasis-500)',
          userSelect: 'none',
        }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {expanded && (
        <div style={{ marginTop: '0.75rem' }}>
          <input
            type="text"
            placeholder="Search Semantic Scholar (e.g., 'attention is all you need')..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              width: '100%', padding: '8px 12px', borderRadius: '6px',
              border: '1px solid var(--ifm-color-emphasis-300)',
              fontSize: '0.95em', backgroundColor: 'var(--ifm-background-color)',
              color: 'var(--ifm-font-color-base)', boxSizing: 'border-box',
            }}
          />

          {feedbackMsg && (
            <div style={{
              marginTop: '0.5rem',
              padding: '0.4rem 0.75rem',
              borderRadius: '4px',
              fontSize: '0.85em',
              color: feedbackMsg.type === 'error' ? 'var(--ifm-color-danger-dark)' : 'var(--ifm-color-success-dark)',
              background: feedbackMsg.type === 'error'
                ? 'var(--ifm-color-danger-contrast-background)'
                : 'var(--ifm-color-success-contrast-background)',
              border: `1px solid ${feedbackMsg.type === 'error' ? 'var(--ifm-color-danger-dark)' : 'var(--ifm-color-success-dark)'}`,
            }}>
              {feedbackMsg.text}
            </div>
          )}

          {searching && (
            <div style={{
              marginTop: '0.5rem', fontSize: '0.85em',
              color: 'var(--ifm-color-emphasis-600)', fontStyle: 'italic',
            }}>
              Searching...
            </div>
          )}

          {searchError && (
            <div style={{
              marginTop: '0.5rem',
              color: 'var(--ifm-color-danger-dark)',
              background: 'var(--ifm-color-danger-contrast-background)',
              border: '1px solid var(--ifm-color-danger-dark)',
              borderRadius: '4px',
              padding: '0.4rem 0.75rem',
              fontSize: '0.85em',
            }}>
              Search error: {searchError}
            </div>
          )}

          {results.length > 0 && (
            <div style={{ marginTop: '0.75rem' }}>
              {results.map((paper) => {
                const paperId = paper.paperId;
                const authors = paper.authors
                  ? paper.authors.map((a) => a.name)
                  : [];
                const authorStr = formatAuthors(authors);
                const isAdded = addedKeys[generateCitationKey(paper)];
                const isAdding = addingKey === paperId;

                return (
                  <div key={paperId} style={{
                    padding: '8px 12px',
                    marginBottom: '6px',
                    borderRadius: '6px',
                    border: '1px solid var(--ifm-color-emphasis-200)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.9em' }}>
                        {paper.url ? (
                          <a href={paper.url} target="_blank" rel="noopener noreferrer">
                            {paper.title}
                          </a>
                        ) : (
                          paper.title
                        )}
                      </div>
                      <div style={{
                        fontSize: '0.82em',
                        color: 'var(--ifm-color-emphasis-700)',
                        marginTop: '2px',
                      }}>
                        {authorStr} ({paper.year || '????'})
                        {paper.venue && <span> &mdash; {paper.venue}</span>}
                      </div>
                    </div>
                    <div style={{ flexShrink: 0, paddingTop: '2px' }}>
                      {isAdded ? (
                        <span style={{
                          padding: '4px 12px',
                          borderRadius: '6px',
                          fontSize: '0.8em',
                          fontWeight: 600,
                          color: 'var(--ifm-color-success-dark)',
                          background: 'var(--ifm-color-success-contrast-background)',
                          border: '1px solid var(--ifm-color-success-dark)',
                        }}>
                          Added
                        </span>
                      ) : (
                        <button
                          onClick={() => handleAdd(paper)}
                          disabled={isAdding}
                          style={{
                            padding: '4px 12px',
                            border: '1px solid var(--ifm-color-primary)',
                            borderRadius: '6px',
                            background: isAdding ? 'var(--ifm-color-emphasis-200)' : 'var(--ifm-color-primary)',
                            color: isAdding ? 'var(--ifm-color-emphasis-600)' : '#fff',
                            cursor: isAdding ? 'not-allowed' : 'pointer',
                            fontSize: '0.8em',
                            fontWeight: 600,
                            fontFamily: 'inherit',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {isAdding ? 'Adding...' : 'Add to Bibliography'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!searching && !searchError && query.trim() && results.length === 0 && (
            <div style={{
              marginTop: '0.5rem', fontSize: '0.85em',
              color: 'var(--ifm-color-emphasis-500)',
            }}>
              No results found.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ImportBibtex() {
  const [modalOpen, setModalOpen] = useState(false);
  const [bibtexText, setBibtexText] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const entryCount = useMemo(() => {
    if (!bibtexText.trim()) return 0;
    const matches = bibtexText.match(/@\w+\s*\{/g);
    return matches ? matches.length : 0;
  }, [bibtexText]);

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setBibtexText(ev.target.result || '');
    };
    reader.readAsText(file);
    // Reset so the same file can be re-selected
    e.target.value = '';
  };

  const handleImport = () => {
    if (!bibtexText.trim() || importing) return;
    setImporting(true);
    setError(null);
    setResult(null);

    fetch(`${API_BASE}/api/references/import-bibtex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bibtex: bibtexText }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setResult(data);
        }
      })
      .catch((err) => setError('Import failed: ' + err.message))
      .finally(() => setImporting(false));
  };

  const handleClose = () => {
    setModalOpen(false);
    setBibtexText('');
    setResult(null);
    setError(null);
  };

  return (
    <>
      <button
        onClick={() => setModalOpen(true)}
        style={{
          padding: '8px 16px',
          border: '1px solid var(--ifm-color-primary)',
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--ifm-color-primary)',
          cursor: 'pointer',
          fontSize: '0.85em',
          fontWeight: 600,
          fontFamily: 'inherit',
        }}
      >
        Import BibTeX
      </button>

      {modalOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div style={{
            background: 'var(--ifm-background-color)',
            borderRadius: '8px',
            padding: '1.5rem',
            width: '90%',
            maxWidth: '640px',
            maxHeight: '80vh',
            overflow: 'auto',
            boxShadow: '0 8px 30px rgba(0,0,0,0.2)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>Import BibTeX</h3>
              <button
                onClick={handleClose}
                style={{
                  background: 'none', border: 'none', fontSize: '1.4em',
                  cursor: 'pointer', color: 'var(--ifm-color-emphasis-600)',
                  lineHeight: 1, padding: '4px',
                }}
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            <div style={{ marginBottom: '0.75rem' }}>
              <label style={{ fontSize: '0.85em', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                Paste BibTeX entries or upload a .bib file
              </label>
              <textarea
                value={bibtexText}
                onChange={(e) => { setBibtexText(e.target.value); setResult(null); setError(null); }}
                placeholder={'@article{key,\n  title = {Example Title},\n  author = {Author Name},\n  year = {2024}\n}'}
                rows={12}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  border: '1px solid var(--ifm-color-emphasis-300)',
                  fontSize: '0.85em',
                  fontFamily: 'monospace',
                  backgroundColor: 'var(--ifm-background-color)',
                  color: 'var(--ifm-font-color-base)',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '1rem', flexWrap: 'wrap' }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".bib,.bibtex,text/plain"
                onChange={handleFileUpload}
                style={{ display: 'none' }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{
                  padding: '6px 14px',
                  border: '1px solid var(--ifm-color-emphasis-300)',
                  borderRadius: '6px',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontSize: '0.82em',
                  fontFamily: 'inherit',
                  color: 'var(--ifm-font-color-base)',
                }}
              >
                Upload .bib file
              </button>

              {entryCount > 0 && (
                <span style={{
                  fontSize: '0.85em',
                  color: 'var(--ifm-color-emphasis-600)',
                  fontWeight: 600,
                }}>
                  {entryCount} {entryCount === 1 ? 'entry' : 'entries'} detected
                </span>
              )}

              <button
                onClick={handleImport}
                disabled={!bibtexText.trim() || importing}
                style={{
                  marginLeft: 'auto',
                  padding: '8px 20px',
                  border: 'none',
                  borderRadius: '6px',
                  background: !bibtexText.trim() || importing ? 'var(--ifm-color-emphasis-200)' : 'var(--ifm-color-primary)',
                  color: !bibtexText.trim() || importing ? 'var(--ifm-color-emphasis-500)' : '#fff',
                  cursor: !bibtexText.trim() || importing ? 'not-allowed' : 'pointer',
                  fontSize: '0.85em',
                  fontWeight: 600,
                  fontFamily: 'inherit',
                }}
              >
                {importing ? 'Importing...' : 'Import'}
              </button>
            </div>

            {error && (
              <div style={{
                padding: '0.5rem 0.75rem',
                borderRadius: '4px',
                fontSize: '0.85em',
                color: 'var(--ifm-color-danger-dark)',
                background: 'var(--ifm-color-danger-contrast-background)',
                border: '1px solid var(--ifm-color-danger-dark)',
                marginBottom: '0.75rem',
              }}>
                {error}
              </div>
            )}

            {result && (
              <div style={{
                padding: '0.75rem',
                borderRadius: '6px',
                background: 'var(--ifm-color-success-contrast-background)',
                border: '1px solid var(--ifm-color-success-dark)',
                fontSize: '0.85em',
              }}>
                <p style={{ margin: '0 0 4px 0', fontWeight: 600, color: 'var(--ifm-color-success-dark)' }}>
                  Added {result.added}, Skipped {result.skipped}
                </p>
                {result.errors && result.errors.length > 0 && (
                  <div style={{ marginTop: '8px' }}>
                    <p style={{ margin: '0 0 4px 0', fontWeight: 600, color: 'var(--ifm-color-danger-dark)' }}>
                      Errors ({result.errors.length}):
                    </p>
                    <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                      {result.errors.map((err, i) => (
                        <li key={i} style={{ color: 'var(--ifm-color-danger-dark)', fontSize: '0.9em' }}>
                          <code>{err.key}</code>: {err.error}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {result.added > 0 && (
                  <p style={{ margin: '8px 0 0 0', fontSize: '0.9em', color: 'var(--ifm-color-emphasis-600)' }}>
                    Reload the page to see newly imported references.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default function BibliographyPage() {
  const { references } = usePluginData('bibliography');
  const [search, setSearch] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [viewMode, setViewMode] = useState('list'); // 'list' or 'graph'

  const { years, types } = useMemo(() => {
    const ys = new Set();
    const ts = new Set();
    for (const entry of Object.values(references || {})) {
      if (entry.year) ys.add(entry.year);
      if (entry.type) ts.add(entry.type);
    }
    return {
      years: [...ys].sort((a, b) => b - a),
      types: [...ts].sort(),
    };
  }, [references]);

  const networkStats = useMemo(() => {
    const entries = Object.values(references || {});
    const total = entries.length;
    const typeCounts = {};
    let minYear = Infinity;
    let maxYear = -Infinity;
    for (const entry of entries) {
      const t = entry.type || 'misc';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
      if (entry.year) {
        if (entry.year < minYear) minYear = entry.year;
        if (entry.year > maxYear) maxYear = entry.year;
      }
    }
    const yearSpan = (minYear <= maxYear) ? maxYear - minYear + 1 : 0;
    const avgPerYear = yearSpan > 0 ? (total / yearSpan).toFixed(1) : 0;
    const yearRange = yearSpan > 0 ? `${minYear}--${maxYear}` : 'N/A';
    // Sort types by count descending for the breakdown
    const typeBreakdown = Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type} (${count})`)
      .join(', ');
    return { total, yearRange, avgPerYear, typeBreakdown };
  }, [references]);

  const filtered = useMemo(() => {
    const entries = Object.entries(references || {});
    const searchLower = search.toLowerCase();

    return entries
      .filter(([key, entry]) => {
        if (searchLower) {
          const matchesSearch =
            key.toLowerCase().includes(searchLower) ||
            (entry.title || '').toLowerCase().includes(searchLower) ||
            (entry.author || []).some((a) => a.toLowerCase().includes(searchLower));
          if (!matchesSearch) return false;
        }
        if (yearFilter && String(entry.year) !== yearFilter) return false;
        if (typeFilter && entry.type !== typeFilter) return false;
        return true;
      })
      .sort(([, a], [, b]) => {
        const yearCmp = (b.year || 0) - (a.year || 0);
        if (yearCmp !== 0) return yearCmp;
        const authorA = (a.author || [''])[0];
        const authorB = (b.author || [''])[0];
        return authorA.localeCompare(authorB);
      });
  }, [references, search, yearFilter, typeFilter]);

  // Group filtered results by year for nav + section headers
  const yearGroups = useMemo(() => {
    const groups = {};
    for (const [key, entry] of filtered) {
      const y = entry.year || 0;
      const label = y >= OLDER_CUTOFF ? String(y) : 'Older';
      if (!groups[label]) groups[label] = [];
      groups[label].push([key, entry]);
    }
    // Sort: recent years first, "Older" last
    return Object.keys(groups)
      .sort((a, b) => {
        if (a === 'Older') return 1;
        if (b === 'Older') return -1;
        return Number(b) - Number(a);
      })
      .map((label) => ({ label, entries: groups[label] }));
  }, [filtered]);

  const { activeYear, showBackToTop } = useActiveYearOnScroll(yearGroups);

  const exportAllBibtex = useCallback(() => {
    const allEntries = Object.entries(references || {});
    const bibtex = allEntries.map(([key, entry]) => toBibTeX(key, entry)).join('\n\n');
    const blob = new Blob([bibtex], {type: 'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'references.bib';
    a.click();
    URL.revokeObjectURL(url);
  }, [references]);

  return (
    <Layout title="Bibliography" description="Complete bibliography of cited references">
      <main style={{ padding: '2rem', maxWidth: '900px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <h1 style={{ margin: 0 }}>Bibliography</h1>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div style={{
              display: 'inline-flex', borderRadius: 6, overflow: 'hidden',
              border: '1px solid var(--ifm-color-emphasis-300)',
            }}>
              <button
                onClick={() => setViewMode('list')}
                style={{
                  padding: '8px 14px', border: 'none', cursor: 'pointer',
                  fontSize: '0.85em', fontWeight: 600, fontFamily: 'inherit',
                  background: viewMode === 'list' ? 'var(--ifm-color-primary)' : 'transparent',
                  color: viewMode === 'list' ? '#fff' : 'var(--ifm-font-color-base)',
                }}
              >
                List View
              </button>
              <button
                onClick={() => setViewMode('graph')}
                style={{
                  padding: '8px 14px', border: 'none', cursor: 'pointer',
                  fontSize: '0.85em', fontWeight: 600, fontFamily: 'inherit',
                  borderLeft: '1px solid var(--ifm-color-emphasis-300)',
                  background: viewMode === 'graph' ? 'var(--ifm-color-primary)' : 'transparent',
                  color: viewMode === 'graph' ? '#fff' : 'var(--ifm-font-color-base)',
                }}
              >
                Graph View
              </button>
            </div>
            <BrowserOnly>
              {() => <ImportBibtex />}
            </BrowserOnly>
            <button
              onClick={exportAllBibtex}
              style={{
                padding: '8px 16px', border: '1px solid var(--ifm-color-primary)',
                borderRadius: 6, background: 'var(--ifm-color-primary)',
                color: '#fff', cursor: 'pointer', fontSize: '0.85em',
                fontWeight: 600, fontFamily: 'inherit',
              }}
            >
              Export All BibTeX
            </button>
          </div>
        </div>
        {viewMode === 'graph' ? (
          <div style={{ marginTop: '1rem' }}>
            <p style={{ color: 'var(--ifm-color-emphasis-600)', marginBottom: '12px' }}>
              Interactive citation graph. Nodes are colored by year (lighter = older, darker = newer).
              Hover for details, click to view a reference. Scroll to zoom, drag to pan.
            </p>
            <Suspense fallback={<div style={{ textAlign: 'center', padding: '2rem', color: 'var(--ifm-color-emphasis-500)' }}>Loading graph...</div>}>
              <CitationGraph references={references} />
            </Suspense>
          </div>
        ) : (
          <>
            <p style={{ color: 'var(--ifm-color-emphasis-600)' }}>
              All references cited across Mochi Lab. Use <code>[@key]</code> in any
              markdown file to cite a reference.
            </p>

            <BrowserOnly>
              {() => {
                const existingKeys = {};
                for (const k of Object.keys(references || {})) {
                  existingKeys[k] = true;
                }
                return <SearchAndAddPapers existingKeys={existingKeys} />;
              }}
            </BrowserOnly>

            <div style={{
              display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap',
            }}>
              <input
                type="text"
                placeholder="Search by title, author, or key..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  flex: '1 1 300px', padding: '8px 12px', borderRadius: '6px',
                  border: '1px solid var(--ifm-color-emphasis-300)',
                  fontSize: '0.95em', backgroundColor: 'var(--ifm-background-color)',
                  color: 'var(--ifm-font-color-base)',
                }}
              />
              <select
                value={yearFilter}
                onChange={(e) => setYearFilter(e.target.value)}
                style={{
                  padding: '8px 12px', borderRadius: '6px',
                  border: '1px solid var(--ifm-color-emphasis-300)',
                  backgroundColor: 'var(--ifm-background-color)',
                  color: 'var(--ifm-font-color-base)',
                }}
              >
                <option value="">All Years</option>
                {years.map((y) => (
                  <option key={y} value={String(y)}>{y}</option>
                ))}
              </select>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                style={{
                  padding: '8px 12px', borderRadius: '6px',
                  border: '1px solid var(--ifm-color-emphasis-300)',
                  backgroundColor: 'var(--ifm-background-color)',
                  color: 'var(--ifm-font-color-base)',
                }}
              >
                <option value="">All Types</option>
                {types.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            <div style={{
              display: 'flex',
              gap: '12px',
              flexWrap: 'wrap',
              marginBottom: '20px',
            }}>
              {[
                { label: 'Total', value: networkStats.total },
                { label: 'Years', value: networkStats.yearRange },
                { label: 'Avg / year', value: networkStats.avgPerYear },
                { label: 'Types', value: networkStats.typeBreakdown },
              ].map(({ label, value }) => (
                <span
                  key={label}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '4px 12px',
                    borderRadius: '16px',
                    border: '1px solid var(--ifm-color-emphasis-200)',
                    background: 'var(--ifm-color-emphasis-100)',
                    fontSize: '0.82em',
                    color: 'var(--ifm-font-color-base)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <strong>{label}:</strong> {value}
                </span>
              ))}
            </div>

            <BrowserOnly>
              {() => <TrackAllPreprints references={references} />}
            </BrowserOnly>

            <p style={{ fontSize: '0.9em', color: 'var(--ifm-color-emphasis-600)', marginBottom: '16px' }}>
              Showing {filtered.length} of {Object.keys(references || {}).length} references
            </p>

            {yearGroups.length > 1 && (
              <YearNavBar yearGroups={yearGroups} activeYear={activeYear} />
            )}

            {yearGroups.map(({ label, entries }) => (
              <div key={label}>
                <YearSectionHeader label={label} count={entries.length} />
                {entries.map(([key, entry]) => (
                  <ReferenceEntry key={key} citationKey={key} entry={entry} />
                ))}
              </div>
            ))}

            {filtered.length === 0 && (
              <p style={{ textAlign: 'center', color: 'var(--ifm-color-emphasis-500)', padding: '2rem' }}>
                No references match your search.
              </p>
            )}

            <BrowserOnly>
              {() => <BackToTopButton visible={showBackToTop} />}
            </BrowserOnly>

            <BrowserOnly>
              {() => {
                const PaperRecommendations = require('../components/PaperRecommendations').default;
                return <PaperRecommendations references={references} />;
              }}
            </BrowserOnly>
          </>
        )}
      </main>
    </Layout>
  );
}
