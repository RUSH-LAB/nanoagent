import React, { useState, useEffect, useRef, useCallback } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import API_BASE, { apiFetch } from '@site/src/utils/api';
import {useDebounce} from '@site/src/hooks/useDebounce';
import { contentPathToUrl, displayPagePath } from '@site/src/utils/paths';
import pageStyles from '@site/src/css/page.module.css';

function highlightMatch(text, query) {
  if (!query || !text) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);
  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark key={i} style={{
        backgroundColor: 'var(--ifm-color-primary-lightest, #e8f0fe)',
        color: 'inherit',
        padding: '0 2px',
        borderRadius: '2px',
      }}>{part}</mark>
    ) : part
  );
}

function SearchContent() {
  const params = new URLSearchParams(window.location.search);
  const initialQuery = params.get('q') || '';

  const [query, setQuery] = useState(initialQuery);
  const debouncedQuery = useDebounce(query, 300);
  const inputRef = useRef(null);

  // Results state
  const [fileResults, setFileResults] = useState([]);
  const [contentResults, setContentResults] = useState([]);
  const [refResults, setRefResults] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [loadingRefs, setLoadingRefs] = useState(false);
  const [errorFiles, setErrorFiles] = useState(null);
  const [errorContent, setErrorContent] = useState(null);

  // Update URL when query changes (without reloading)
  useEffect(() => {
    const url = new URL(window.location);
    if (debouncedQuery) {
      url.searchParams.set('q', debouncedQuery);
    } else {
      url.searchParams.delete('q');
    }
    window.history.replaceState({}, '', url);
  }, [debouncedQuery]);

  // Search files and content when debounced query changes
  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setFileResults([]);
      setContentResults([]);
      setRefResults([]);
      setErrorFiles(null);
      setErrorContent(null);
      return;
    }

    const encoded = encodeURIComponent(debouncedQuery.trim());
    const controller = new AbortController();
    const {signal} = controller;

    // Search files
    setLoadingFiles(true);
    setErrorFiles(null);
    apiFetch(`${API_BASE}/api/files/search?q=${encoded}`, {signal})
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => { if (!signal.aborted) setFileResults(data.files || data || []); })
      .catch((err) => { if (!signal.aborted) setErrorFiles(err.message); })
      .finally(() => { if (!signal.aborted) setLoadingFiles(false); });

    // Full-text search
    setLoadingContent(true);
    setErrorContent(null);
    apiFetch(`${API_BASE}/api/search?q=${encoded}`, {signal})
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => { if (!signal.aborted) setContentResults(data.results || data || []); })
      .catch((err) => { if (!signal.aborted) setErrorContent(err.message); })
      .finally(() => { if (!signal.aborted) setLoadingContent(false); });

    setLoadingRefs(true);
    apiFetch(`${API_BASE}/api/references?limit=20&q=${encoded}`, {signal})
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => setRefResults(Object.entries(data.references || {})))
      .catch(() => { if (!signal.aborted) setRefResults([]); })
      .finally(() => { if (!signal.aborted) setLoadingRefs(false); });

    return () => controller.abort();
  }, [debouncedQuery]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const isLoading = loadingFiles || loadingContent || loadingRefs;
  const hasQuery = debouncedQuery.trim().length > 0;
  const hasResults = fileResults.length > 0 || contentResults.length > 0 || refResults.length > 0;
  const totalResults = fileResults.length + contentResults.length + refResults.length;

  const toViewPath = contentPathToUrl;

  return (
    <div className={pageStyles.pageContainer}>
      <h1 style={{ marginBottom: '1.5rem' }}>Search</h1>

      {/* Search input */}
      <div style={{ position: 'relative', marginBottom: '1.5rem' }}>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search pages, content, and references..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            width: '100%',
            padding: '14px 16px 14px 44px',
            borderRadius: '8px',
            border: '2px solid var(--ifm-color-emphasis-300)',
            fontSize: '1.1em',
            backgroundColor: 'var(--ifm-background-color)',
            color: 'var(--ifm-font-color-base)',
            boxSizing: 'border-box',
            outline: 'none',
            transition: 'border-color 0.2s',
          }}
          onFocus={(e) => {
            e.target.style.borderColor = 'var(--ifm-color-primary)';
          }}
          onBlur={(e) => {
            e.target.style.borderColor = 'var(--ifm-color-emphasis-300)';
          }}
        />
        {/* Search icon */}
        <svg
          style={{
            position: 'absolute',
            left: '14px',
            top: '50%',
            transform: 'translateY(-50%)',
            width: '20px',
            height: '20px',
            color: 'var(--ifm-color-emphasis-500)',
          }}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        {query && (
          <button
            onClick={() => { setQuery(''); inputRef.current?.focus(); }}
            style={{
              position: 'absolute',
              right: '12px',
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '1.2em',
              color: 'var(--ifm-color-emphasis-500)',
              padding: '4px',
              lineHeight: 1,
            }}
            aria-label="Clear search"
          >
            &times;
          </button>
        )}
      </div>

      {/* Summary line */}
      {hasQuery && !isLoading && (
        <p style={{
          fontSize: '0.9em',
          color: 'var(--ifm-color-emphasis-600)',
          marginBottom: '1.5rem',
        }}>
          {totalResults} result{totalResults !== 1 ? 's' : ''} for &ldquo;{debouncedQuery}&rdquo;
        </p>
      )}

      {/* Loading state */}
      {isLoading && hasQuery && (
        <div style={{
          textAlign: 'center',
          padding: '2rem',
          color: 'var(--ifm-color-emphasis-500)',
          fontStyle: 'italic',
        }}>
          Searching...
        </div>
      )}

      {/* Empty state — no query */}
      {!hasQuery && (
        <div style={{
          textAlign: 'center',
          padding: '3rem 1rem',
          color: 'var(--ifm-color-emphasis-500)',
        }}>
          <p style={{ fontSize: '1.1em', marginBottom: '1rem' }}>
            Search across all pages, content, and bibliography references.
          </p>
          <div style={{
            display: 'flex',
            gap: '8px',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}>
            {['attention', 'transformer', 'reinforcement learning', 'neural network'].map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => setQuery(suggestion)}
                style={{
                  padding: '6px 14px',
                  borderRadius: '16px',
                  border: '1px solid var(--ifm-color-emphasis-300)',
                  background: 'var(--ifm-background-surface-color, var(--ifm-background-color))',
                  color: 'var(--ifm-color-emphasis-700)',
                  cursor: 'pointer',
                  fontSize: '0.85em',
                  fontFamily: 'inherit',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={(e) => {
                  e.target.style.borderColor = 'var(--ifm-color-primary)';
                  e.target.style.color = 'var(--ifm-color-primary)';
                }}
                onMouseLeave={(e) => {
                  e.target.style.borderColor = 'var(--ifm-color-emphasis-300)';
                  e.target.style.color = 'var(--ifm-color-emphasis-700)';
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
          <p style={{ fontSize: '0.82em', color: 'var(--ifm-color-emphasis-400)', marginTop: '1.5rem' }}>
            Tip: Access this page directly at <code>/search?q=your+query</code>
          </p>
        </div>
      )}

      {/* No results state */}
      {hasQuery && !isLoading && !hasResults && (
        <div style={{
          textAlign: 'center',
          padding: '3rem 1rem',
          color: 'var(--ifm-color-emphasis-500)',
        }}>
          <p style={{ fontSize: '1.1em', marginBottom: '0.5rem' }}>
            No results found for &ldquo;{debouncedQuery}&rdquo;
          </p>
          <p style={{ fontSize: '0.9em' }}>
            Try different keywords or check your spelling.
          </p>
        </div>
      )}

      {/* Errors */}
      {errorFiles && (
        <div style={{
          padding: '0.5rem 1rem',
          marginBottom: '1rem',
          borderRadius: '6px',
          fontSize: '0.85em',
          color: 'var(--ifm-color-danger-dark)',
          background: 'var(--ifm-color-danger-contrast-background)',
          border: '1px solid var(--ifm-color-danger-dark)',
        }}>
          File search error: {errorFiles}
        </div>
      )}
      {errorContent && (
        <div style={{
          padding: '0.5rem 1rem',
          marginBottom: '1rem',
          borderRadius: '6px',
          fontSize: '0.85em',
          color: 'var(--ifm-color-danger-dark)',
          background: 'var(--ifm-color-danger-contrast-background)',
          border: '1px solid var(--ifm-color-danger-dark)',
        }}>
          Content search error: {errorContent}
        </div>
      )}

      {/* Results sections */}
      {!isLoading && hasQuery && (
        <>
          {/* Pages section */}
          {fileResults.length > 0 && (
            <section style={{ marginBottom: '2rem' }}>
              <h2 style={{
                fontSize: '1em',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--ifm-color-emphasis-600)',
                borderBottom: '2px solid var(--ifm-color-emphasis-200)',
                paddingBottom: '6px',
                marginBottom: '12px',
              }}>
                Pages
                <span style={{
                  marginLeft: '8px',
                  fontSize: '0.85em',
                  fontWeight: 400,
                  color: 'var(--ifm-color-emphasis-500)',
                }}>
                  ({fileResults.length})
                </span>
              </h2>
              {fileResults.map((file) => {
                const filePath = typeof file === 'string' ? file : file.path || file.name || '';
                const displayPath = displayPagePath(filePath);
                return (
                  <div key={filePath} style={{
                    padding: '10px 14px',
                    marginBottom: '6px',
                    borderRadius: '6px',
                    border: '1px solid var(--ifm-color-emphasis-200)',
                    transition: 'border-color 0.15s',
                  }}>
                    <Link
                      to={toViewPath(filePath)}
                      style={{
                        fontWeight: 600,
                        fontSize: '0.95em',
                        textDecoration: 'none',
                        display: 'block',
                      }}
                    >
                      {highlightMatch(displayPath, debouncedQuery)}
                    </Link>
                  </div>
                );
              })}
            </section>
          )}

          {/* Content section */}
          {contentResults.length > 0 && (
            <section style={{ marginBottom: '2rem' }}>
              <h2 style={{
                fontSize: '1em',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--ifm-color-emphasis-600)',
                borderBottom: '2px solid var(--ifm-color-emphasis-200)',
                paddingBottom: '6px',
                marginBottom: '12px',
              }}>
                Content
                <span style={{
                  marginLeft: '8px',
                  fontSize: '0.85em',
                  fontWeight: 400,
                  color: 'var(--ifm-color-emphasis-500)',
                }}>
                  ({contentResults.length})
                </span>
              </h2>
              {contentResults.map((result, idx) => {
                const filePath = result.file || result.path || '';
                const snippet = result.snippet || result.context || result.content || '';
                const displayPath = displayPagePath(filePath);
                return (
                  <div key={`${filePath}-${idx}`} style={{
                    padding: '10px 14px',
                    marginBottom: '6px',
                    borderRadius: '6px',
                    border: '1px solid var(--ifm-color-emphasis-200)',
                  }}>
                    <Link
                      to={toViewPath(filePath)}
                      style={{
                        fontWeight: 600,
                        fontSize: '0.9em',
                        textDecoration: 'none',
                        display: 'block',
                        marginBottom: '4px',
                      }}
                    >
                      {displayPath || 'Untitled'}
                    </Link>
                    {snippet && (
                      <div style={{
                        fontSize: '0.85em',
                        color: 'var(--ifm-color-emphasis-700)',
                        lineHeight: 1.5,
                        overflow: 'hidden',
                        display: '-webkit-box',
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: 'vertical',
                      }}>
                        {highlightMatch(snippet, debouncedQuery)}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {/* References section */}
          {refResults.length > 0 && (
            <section style={{ marginBottom: '2rem' }}>
              <h2 style={{
                fontSize: '1em',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--ifm-color-emphasis-600)',
                borderBottom: '2px solid var(--ifm-color-emphasis-200)',
                paddingBottom: '6px',
                marginBottom: '12px',
              }}>
                References
                <span style={{
                  marginLeft: '8px',
                  fontSize: '0.85em',
                  fontWeight: 400,
                  color: 'var(--ifm-color-emphasis-500)',
                }}>
                  ({refResults.length})
                </span>
              </h2>
              {refResults.map(([key, entry]) => {
                const authors = entry.author || [];
                const authorStr = authors.length <= 3
                  ? authors.join(', ')
                  : `${authors.slice(0, 3).join(', ')}, et al.`;
                return (
                  <div key={key} style={{
                    padding: '10px 14px',
                    marginBottom: '6px',
                    borderRadius: '6px',
                    border: '1px solid var(--ifm-color-emphasis-200)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                      <Link
                        to={`/bibliography/${key}`}
                        style={{ textDecoration: 'none' }}
                      >
                        <code style={{ fontSize: '0.85em', color: 'var(--ifm-color-primary)' }}>
                          @{highlightMatch(key, debouncedQuery)}
                        </code>
                      </Link>
                      {entry.year && (
                        <span style={{
                          fontSize: '0.78em',
                          padding: '1px 6px',
                          borderRadius: '3px',
                          backgroundColor: 'var(--ifm-color-emphasis-100)',
                          color: 'var(--ifm-color-emphasis-600)',
                        }}>
                          {entry.year}
                        </span>
                      )}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: '0.9em', marginBottom: '2px' }}>
                      {entry.url ? (
                        <a href={entry.url} target="_blank" rel="noopener noreferrer">
                          {highlightMatch(entry.title || 'Untitled', debouncedQuery)}
                        </a>
                      ) : (
                        highlightMatch(entry.title || 'Untitled', debouncedQuery)
                      )}
                    </div>
                    <div style={{
                      fontSize: '0.82em',
                      color: 'var(--ifm-color-emphasis-600)',
                    }}>
                      {highlightMatch(authorStr, debouncedQuery)}
                      {entry.venue && <span> &mdash; {entry.venue}</span>}
                    </div>
                  </div>
                );
              })}
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Layout title="Search" description="Search across all Mochi Lab content">
      <BrowserOnly fallback={
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--ifm-color-emphasis-500)' }}>
          Loading search...
        </div>
      }>
        {() => <ErrorBoundary><SearchContent /></ErrorBoundary>}
      </BrowserOnly>
    </Layout>
  );
}
