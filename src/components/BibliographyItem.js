import React, { useState, useEffect } from 'react';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import { usePluginData } from '@docusaurus/useGlobalData';
import { useLocation } from '@docusaurus/router';
import API_BASE from '@site/src/utils/api';
import { S2_PAPER_SEARCH } from '@site/src/utils/semanticScholar';

const BUTTON_BASE = {
  padding: '4px 14px',
  fontSize: '0.85em',
  borderRadius: '4px',
  border: '1px solid var(--ifm-color-emphasis-300)',
  background: 'var(--ifm-color-emphasis-0)',
  color: 'var(--ifm-font-color-base)',
  cursor: 'pointer',
  fontWeight: 500,
};

export default function BibliographyItem() {
  const { references } = usePluginData('bibliography');
  const location = useLocation();
  const key = location.pathname.replace(/^\/bibliography\//, '').replace(/\/$/, '');
  const entry = references[key];

  if (!entry) {
    return (
      <Layout title="Reference Not Found">
        <div style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto' }}>
          <h1>Reference Not Found</h1>
          <p>
            No reference found for key <code>{key}</code>.
          </p>
          <Link to="/bibliography">← Back to Bibliography</Link>
        </div>
      </Layout>
    );
  }

  const pageTitle = `${entry.title} | Mochi Lab Bibliography`;
  const pageDescription = `${entry.author.join(', ')} (${entry.year}). ${entry.venue}. Cited as [@${key}]`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ScholarlyArticle',
    name: entry.title,
    author: entry.author.map((name) => ({ '@type': 'Person', name })),
    datePublished: String(entry.year),
    publisher: entry.venue,
    ...(entry.url && { url: entry.url }),
    ...(entry.doi && { sameAs: `https://doi.org/${entry.doi}` }),
  };

  return (
    <Layout title={pageTitle} description={pageDescription}>
      <Head>
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={pageDescription} />
        <meta property="og:type" content="article" />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={pageTitle} />
        <meta name="twitter:description" content={pageDescription} />
        <meta name="citation_title" content={entry.title} />
        {entry.author.map((author, i) => (
          <meta key={i} name="citation_author" content={author} />
        ))}
        <meta name="citation_publication_date" content={String(entry.year)} />
        {entry.venue && <meta name="citation_journal_title" content={entry.venue} />}
        {entry.doi && <meta name="citation_doi" content={entry.doi} />}
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      </Head>
      <div style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto' }}>
        <Link
          to="/bibliography"
          style={{ display: 'inline-block', marginBottom: '1.5rem' }}
        >
          ← Back to Bibliography
        </Link>

        <h1>{entry.title}</h1>

        <div style={{ marginBottom: '1.5rem' }}>
          <p style={{ margin: '4px 0' }}>
            <strong>Authors:</strong> {entry.author.join(', ')}
          </p>
          <p style={{ margin: '4px 0' }}>
            <strong>Year:</strong> {entry.year}
          </p>
          <p style={{ margin: '4px 0' }}>
            <strong>Venue:</strong> {entry.venue}
          </p>
          <p style={{ margin: '4px 0' }}>
            <strong>Type:</strong>{' '}
            <span
              style={{
                background: 'var(--ifm-color-emphasis-100)',
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '0.85em',
              }}
            >
              {entry.type}
            </span>
          </p>
          {entry.url && (
            <p style={{ margin: '4px 0' }}>
              <strong>URL:</strong>{' '}
              <a href={entry.url} target="_blank" rel="noopener noreferrer">
                {entry.url}
              </a>
            </p>
          )}
          {entry.doi && (
            <p style={{ margin: '4px 0' }}>
              <strong>DOI:</strong>{' '}
              <a
                href={`https://doi.org/${entry.doi}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {entry.doi}
              </a>
            </p>
          )}
          {entry.arxivId && (
            <p style={{ margin: '4px 0' }}>
              <strong>arXiv:</strong>{' '}
              <a
                href={`https://arxiv.org/abs/${entry.arxivId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {entry.arxivId}
              </a>
            </p>
          )}
          <CopyCitation citationKey={key} />
          <CitationCount entry={entry} bibKey={key} />
        </div>

        <EnrichSection bibKey={key} entry={entry} />
        <PublicationTracker entry={entry} bibKey={key} />
        <RawFilesSection entry={entry} bibKey={key} />
        <BibtexSection bibtex={entry.bibtex} />
        <NotesSection notes={entry.notes} bibKey={key} />
        <RelatedPapers title={entry.title} />
      </div>
    </Layout>
  );
}

function CopyCitation({ citationKey }) {
  const [copied, setCopied] = useState(false);
  const text = `[@${citationKey}]`;

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <p style={{ margin: '4px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
      <strong>Cite as:</strong> <code>{text}</code>
      <button
        onClick={handleCopy}
        title="Copy citation key"
        style={{
          padding: '1px 8px',
          fontSize: '0.8em',
          borderRadius: '4px',
          border: '1px solid var(--ifm-color-emphasis-300)',
          background: copied
            ? 'var(--ifm-color-success-contrast-background)'
            : 'var(--ifm-color-emphasis-0)',
          color: copied
            ? 'var(--ifm-color-success-dark)'
            : 'var(--ifm-font-color-base)',
          cursor: 'pointer',
          fontWeight: 500,
          transition: 'background 0.15s, color 0.15s',
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </p>
  );
}

function CitationCount({ entry, bibKey }) {
  const [count, setCount] = useState(entry.citationCount ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleFetch = () => {
    setLoading(true);
    setError(null);
    fetch(`${ENRICH_API}?key=${encodeURIComponent(bibKey)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          const c = data.sources?.semanticScholar?.citationCount;
          if (c != null) {
            setCount(c);
          } else {
            setError('No citation data available');
          }
        }
      })
      .catch((err) => setError('Failed to fetch: ' + err.message))
      .finally(() => setLoading(false));
  };

  if (count != null) {
    return (
      <p style={{ margin: '4px 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.7 }}>
            <rect x="1" y="10" width="3" height="5" rx="0.5" />
            <rect x="5.5" y="6" width="3" height="9" rx="0.5" />
            <rect x="10" y="2" width="3" height="13" rx="0.5" />
          </svg>
          Citations:
        </strong>{' '}
        {count.toLocaleString()}
      </p>
    );
  }

  return (
    <p style={{ margin: '4px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
      <strong>Citations:</strong>
      <button
        onClick={handleFetch}
        disabled={loading}
        style={{
          padding: '1px 8px',
          fontSize: '0.8em',
          borderRadius: '4px',
          border: '1px solid var(--ifm-color-emphasis-300)',
          background: 'var(--ifm-color-emphasis-0)',
          color: 'var(--ifm-font-color-base)',
          cursor: loading ? 'default' : 'pointer',
          opacity: loading ? 0.6 : 1,
          fontWeight: 500,
        }}
      >
        {loading ? 'Fetching...' : 'Fetch citation count'}
      </button>
      {error && (
        <span style={{ fontSize: '0.8em', color: 'var(--ifm-color-danger-dark)' }}>{error}</span>
      )}
    </p>
  );
}

const ENRICH_API = `${API_BASE}/api/references/enrich`;

const SOURCE_LABELS = {
  semanticScholar: 'Semantic Scholar',
  crossref: 'CrossRef',
  dblp: 'DBLP',
};

const SOURCE_COLORS = {
  semanticScholar: '#4A90D9',
  crossref: '#2EAE4A',
  dblp: '#E8A83E',
};

const FIELD_LABELS = {
  title: 'Title',
  authors: 'Authors',
  year: 'Year',
  venue: 'Venue',
  doi: 'DOI',
  arxivId: 'arXiv ID',
  url: 'URL',
  publisher: 'Publisher',
  volume: 'Volume',
  issue: 'Issue',
  pages: 'Pages',
  citationCount: 'Citations',
  referenceCount: 'References',
  tldr: 'TL;DR',
};

function EnrichSection({ bibKey, entry }) {
  const [enrichData, setEnrichData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedFields, setSelectedFields] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleEnrich = () => {
    setLoading(true);
    setError(null);
    setEnrichData(null);
    setSelectedFields({});
    setSaved(false);
    fetch(`${ENRICH_API}?key=${encodeURIComponent(bibKey)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setEnrichData(data);
          setExpanded(true);
        }
      })
      .catch((err) => setError('Failed to fetch enrichment data: ' + err.message))
      .finally(() => setLoading(false));
  };

  const toggleField = (source, field, value) => {
    const fieldKey = `${source}:${field}`;
    setSelectedFields((prev) => {
      const next = { ...prev };
      if (next[fieldKey]) {
        delete next[fieldKey];
      } else {
        next[fieldKey] = { field, value, source };
      }
      return next;
    });
  };

  const handleApply = () => {
    const fields = {};
    for (const { field, value } of Object.values(selectedFields)) {
      // For 'authors' field, map to 'author' which is what references.yaml uses
      const yamlField = field === 'authors' ? 'author' : field;
      fields[yamlField] = value;
    }
    if (Object.keys(fields).length === 0) return;

    setSaving(true);
    setSaved(false);
    setError(null);
    fetch(ENRICH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: bibKey, fields }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setSaved(true);
          setSelectedFields({});
          setTimeout(() => setSaved(false), 3000);
        }
      })
      .catch((err) => setError('Failed to apply enrichment: ' + err.message))
      .finally(() => setSaving(false));
  };


  // Fields to display from enrichment sources, in FIELD_LABELS order (single source of truth).
  const displayFields = Object.keys(FIELD_LABELS);

  const formatFieldValue = (value) => {
    if (value == null) return null;
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  };

  const fieldLabel = (field) => FIELD_LABELS[field] || field;

  return (
    <div style={{ marginBottom: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>Enrich Metadata</h2>
        <button
          onClick={enrichData && expanded ? () => setExpanded(!expanded) : handleEnrich}
          disabled={loading}
          style={{ ...BUTTON_BASE, opacity: loading ? 0.6 : 1 }}
        >
          {loading ? 'Fetching...' : enrichData && expanded ? 'Collapse' : enrichData ? 'Expand' : 'Enrich'}
        </button>
        {saved && (
          <span style={{ color: 'var(--ifm-color-success-dark)', fontSize: '0.85em', fontWeight: 500 }}>
            Applied
          </span>
        )}
      </div>

      {error && (
        <div style={{
          color: 'var(--ifm-color-danger-dark)',
          background: 'var(--ifm-color-danger-contrast-background)',
          border: '1px solid var(--ifm-color-danger-dark)',
          borderRadius: '4px',
          padding: '0.5rem 1rem',
          fontSize: '0.85em',
          marginBottom: '0.75rem',
        }}>
          {error}
        </div>
      )}

      {enrichData && expanded && (
        <div style={{
          border: '1px solid var(--ifm-color-emphasis-200)',
          borderRadius: '6px',
          overflow: 'hidden',
        }}>
          {/* Summary stats bar */}
          {enrichData.sources.semanticScholar && (
            <div style={{
              display: 'flex',
              gap: '16px',
              padding: '0.75rem 1rem',
              background: 'var(--ifm-color-emphasis-100)',
              borderBottom: '1px solid var(--ifm-color-emphasis-200)',
              fontSize: '0.9em',
              flexWrap: 'wrap',
            }}>
              {enrichData.sources.semanticScholar.citationCount != null && (
                <span><strong>Citations:</strong> {enrichData.sources.semanticScholar.citationCount}</span>
              )}
              {enrichData.sources.semanticScholar.referenceCount != null && (
                <span><strong>References:</strong> {enrichData.sources.semanticScholar.referenceCount}</span>
              )}
              {enrichData.sources.semanticScholar.tldr && (
                <div style={{ flexBasis: '100%' }}>
                  <strong>TL;DR:</strong>{' '}
                  <span style={{ fontStyle: 'italic' }}>{enrichData.sources.semanticScholar.tldr}</span>
                </div>
              )}
            </div>
          )}

          {/* Source columns */}
          {Object.entries(enrichData.sources).map(([sourceKey, sourceData]) => {
            if (!sourceData) return null;
            return (
              <div key={sourceKey} style={{
                borderBottom: '1px solid var(--ifm-color-emphasis-200)',
              }}>
                <div style={{
                  padding: '0.5rem 1rem',
                  background: `${SOURCE_COLORS[sourceKey]}15`,
                  borderBottom: '1px solid var(--ifm-color-emphasis-200)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}>
                  <span style={{
                    display: 'inline-block',
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: SOURCE_COLORS[sourceKey],
                  }} />
                  <strong style={{ fontSize: '0.9em' }}>{SOURCE_LABELS[sourceKey]}</strong>
                </div>
                <div style={{ padding: '0.5rem 1rem' }}>
                  {displayFields.map((field) => {
                    const value = sourceData[field];
                    const formatted = formatFieldValue(value);
                    if (!formatted) return null;

                    const fieldKey = `${sourceKey}:${field}`;
                    const isSelected = !!selectedFields[fieldKey];

                    // Compare with current entry value
                    const currentField = field === 'authors' ? 'author' : field;
                    const currentValue = entry[currentField];
                    const currentFormatted = formatFieldValue(currentValue);
                    const isDifferent = currentFormatted !== formatted;
                    const isNew = currentValue == null || currentValue === '';

                    // Only show fields that are new or different
                    if (!isDifferent && !isNew) return null;

                    return (
                      <div
                        key={fieldKey}
                        onClick={() => toggleField(sourceKey, field, value)}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '8px',
                          padding: '4px 0',
                          cursor: 'pointer',
                          borderRadius: '3px',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          style={{ marginTop: '3px', cursor: 'pointer' }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{
                            fontSize: '0.8em',
                            fontWeight: 600,
                            color: 'var(--ifm-color-emphasis-600)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                          }}>
                            {fieldLabel(field)}
                            {isNew && (
                              <span style={{
                                marginLeft: '6px',
                                fontSize: '0.85em',
                                fontWeight: 500,
                                color: 'var(--ifm-color-success-dark)',
                                textTransform: 'none',
                                letterSpacing: 'normal',
                              }}>
                                (new)
                              </span>
                            )}
                            {isDifferent && !isNew && (
                              <span style={{
                                marginLeft: '6px',
                                fontSize: '0.85em',
                                fontWeight: 500,
                                color: 'var(--ifm-color-warning-dark)',
                                textTransform: 'none',
                                letterSpacing: 'normal',
                              }}>
                                (differs)
                              </span>
                            )}
                          </span>
                          <div style={{
                            fontSize: '0.9em',
                            wordBreak: 'break-word',
                            color: 'var(--ifm-font-color-base)',
                          }}>
                            {field === 'tldr' ? (
                              <em>{formatted}</em>
                            ) : formatted}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* No data indicator */}
          {!enrichData.sources.semanticScholar && !enrichData.sources.crossref && !enrichData.sources.dblp && (
            <div style={{
              padding: '1rem',
              textAlign: 'center',
              color: 'var(--ifm-color-emphasis-600)',
              fontStyle: 'italic',
            }}>
              No enrichment data found from any source.
            </div>
          )}

          {/* Apply button */}
          {Object.keys(selectedFields).length > 0 && (
            <div style={{
              padding: '0.75rem 1rem',
              borderTop: '1px solid var(--ifm-color-emphasis-200)',
              background: 'var(--ifm-color-emphasis-100)',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
            }}>
              <button
                onClick={handleApply}
                disabled={saving}
                style={{
                  ...BUTTON_BASE,
                  background: 'var(--ifm-color-primary)',
                  color: 'var(--ifm-color-white)',
                  border: '1px solid var(--ifm-color-primary)',
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? 'Applying...' : `Apply ${Object.keys(selectedFields).length} field${Object.keys(selectedFields).length > 1 ? 's' : ''}`}
              </button>
              <span style={{ fontSize: '0.85em', color: 'var(--ifm-color-emphasis-600)' }}>
                Selected fields will be saved to references.yaml
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TRACK_API = `${API_BASE}/api/references/track`;

function PublicationTracker({ entry, bibKey }) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState(null);

  const hasArxiv = !!entry.arxivId;

  if (!hasArxiv) return null;

  const isPreprint = !entry.publishedVenue && (
    !entry.venue || entry.venue === 'arXiv' || entry.venue === 'ArXiv'
  );

  const handleCheck = () => {
    setChecking(true);
    setError(null);
    fetch(`${TRACK_API}?key=${encodeURIComponent(bibKey)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error && !data.published) {
          setError(data.error);
        } else {
          setStatus(data);
        }
      })
      .catch((err) => setError('Failed to check: ' + err.message))
      .finally(() => setChecking(false));
  };

  const handleUpdate = () => {
    setUpdating(true);
    setError(null);
    fetch(TRACK_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: bibKey }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setStatus(data);
        }
      })
      .catch((err) => setError('Failed to update: ' + err.message))
      .finally(() => setUpdating(false));
  };

  const badgeStyle = (published) => ({
    display: 'inline-block',
    padding: '3px 10px',
    borderRadius: '12px',
    fontSize: '0.85em',
    fontWeight: 600,
    background: published
      ? 'var(--ifm-color-success-contrast-background)'
      : 'var(--ifm-color-warning-contrast-background)',
    color: published
      ? 'var(--ifm-color-success-dark)'
      : 'var(--ifm-color-warning-dark)',
    border: `1px solid ${published ? 'var(--ifm-color-success-dark)' : 'var(--ifm-color-warning-dark)'}`,
  });


  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2>Publication Status</h2>
      <div style={{
        border: '1px solid var(--ifm-color-emphasis-200)',
        borderRadius: '6px',
        padding: '1rem',
      }}>
        {/* Current status */}
        <div style={{ marginBottom: '0.75rem' }}>
          {entry.publishedVenue ? (
            <span style={badgeStyle(true)}>Published: {entry.publishedVenue}</span>
          ) : isPreprint ? (
            <span style={badgeStyle(false)}>Preprint (arXiv)</span>
          ) : (
            <span style={badgeStyle(true)}>{entry.venue}</span>
          )}
        </div>

        {/* Check result */}
        {status && (
          <div style={{
            background: 'var(--ifm-color-emphasis-100)',
            borderRadius: '4px',
            padding: '0.75rem',
            marginBottom: '0.75rem',
            fontSize: '0.9em',
          }}>
            {status.published ? (
              <>
                <p style={{ margin: '0 0 4px 0', fontWeight: 600, color: 'var(--ifm-color-success-dark)' }}>
                  Published at a venue
                </p>
                <p style={{ margin: '2px 0' }}><strong>Venue:</strong> {status.venue}</p>
                {status.doi && (
                  <p style={{ margin: '2px 0' }}>
                    <strong>DOI:</strong>{' '}
                    <a href={`https://doi.org/${status.doi}`} target="_blank" rel="noopener noreferrer">
                      {status.doi}
                    </a>
                  </p>
                )}
                {status.journal?.name && (
                  <p style={{ margin: '2px 0' }}><strong>Journal:</strong> {status.journal.name}</p>
                )}
              </>
            ) : (
              <p style={{ margin: 0, color: 'var(--ifm-color-emphasis-600)' }}>
                No formal publication found yet. Still a preprint.
              </p>
            )}
          </div>
        )}

        {error && (
          <div style={{
            color: 'var(--ifm-color-danger-dark)',
            background: 'var(--ifm-color-danger-contrast-background)',
            border: '1px solid var(--ifm-color-danger-dark)',
            borderRadius: '4px',
            padding: '0.5rem 1rem',
            fontSize: '0.85em',
            marginBottom: '0.75rem',
          }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            onClick={handleCheck}
            disabled={checking}
            style={{ ...BUTTON_BASE, opacity: checking ? 0.6 : 1 }}
          >
            {checking ? 'Checking...' : 'Check Now'}
          </button>
          {status?.published && !status?.tracked && (
            <button
              onClick={handleUpdate}
              disabled={updating}
              style={{
                ...BUTTON_BASE,
                background: 'var(--ifm-color-primary)',
                color: 'var(--ifm-color-white)',
                border: '1px solid var(--ifm-color-primary)',
                opacity: updating ? 0.6 : 1,
              }}
            >
              {updating ? 'Saving...' : 'Save Venue to Reference'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RawFilesSection({ entry, bibKey }) {
  const { hasPdf, hasLatex, notFound, pdfUrl, sourceUrl } = entry.raw;

  const linkStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    background: 'var(--ifm-color-success-contrast-background)',
    color: 'var(--ifm-color-success-dark)',
    padding: '6px 14px',
    borderRadius: '6px',
    fontSize: '0.9em',
    textDecoration: 'none',
    fontWeight: 600,
  };

  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2>Raw Files</h2>
      {hasPdf || hasLatex ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {hasPdf && (
            <a href={pdfUrl} style={linkStyle} target="_blank" rel="noopener noreferrer">
              ⬇ PDF
            </a>
          )}
          {hasLatex && (
            <a href={sourceUrl} style={linkStyle} download>
              ⬇ LaTeX Source (.tar.gz)
            </a>
          )}
        </div>
      ) : notFound ? (
        <div
          style={{
            border: '1px solid var(--ifm-color-warning-dark)',
            background: 'var(--ifm-color-warning-contrast-background)',
            color: 'var(--ifm-color-warning-contrast-foreground)',
            borderRadius: '6px',
            padding: '1rem',
            whiteSpace: 'pre-wrap',
            fontSize: '0.9em',
            lineHeight: 1.5,
          }}
        >
          {notFound}
        </div>
      ) : (
        <p style={{ color: 'var(--ifm-color-emphasis-600)', fontStyle: 'italic' }}>
          No raw files yet. Run <code>node scripts/fetch-bibliography-raw.mjs --only {bibKey}</code>{' '}
          to populate, or drop files into <code>raw/bibliography/{bibKey}/</code>.
        </p>
      )}
    </div>
  );
}

function BibtexSection({ bibtex }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(bibtex).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2>BibTeX</h2>
      <div style={{ position: 'relative' }}>
        <pre
          style={{
            padding: '1rem',
            borderRadius: '4px',
            background: 'var(--ifm-color-emphasis-100)',
            overflow: 'auto',
          }}
        >
          <code>{bibtex}</code>
        </pre>
        <button
          onClick={handleCopy}
          style={{
            position: 'absolute',
            top: '8px',
            right: '8px',
            padding: '4px 10px',
            fontSize: '0.8em',
            borderRadius: '4px',
            border: '1px solid var(--ifm-color-emphasis-300)',
            background: 'var(--ifm-color-emphasis-0)',
            color: 'var(--ifm-font-color-base)',
            cursor: 'pointer',
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

const NOTES_API = `${API_BASE}/api/notes`;

function NotesSection({ notes: staticNotes, bibKey }) {
  const [content, setContent] = useState(staticNotes || '');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${NOTES_API}?key=${encodeURIComponent(bibKey)}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.note && data.note.content != null) {
          setContent(data.note.content);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError('Failed to load notes from server.');
          console.error('Notes fetch error:', err);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [bibKey]);

  const handleSave = () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    fetch(NOTES_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: bibKey, content }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
        return res.json();
      })
      .then(() => {
        setSaved(true);
        setEditing(false);
        setTimeout(() => setSaved(false), 2500);
      })
      .catch((err) => {
        setError('Failed to save notes.');
        console.error('Notes save error:', err);
      })
      .finally(() => setSaving(false));
  };

  const handleCancel = () => {
    setEditing(false);
    setError(null);
    // Re-fetch to reset content to server state
    fetch(`${NOTES_API}?key=${encodeURIComponent(bibKey)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.note && data.note.content != null) {
          setContent(data.note.content);
        }
      });
  };


  return (
    <div style={{ marginBottom: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>Notes</h2>
        {!editing && !loading && (
          <button
            onClick={() => setEditing(true)}
            style={BUTTON_BASE}
          >
            Edit
          </button>
        )}
        {saved && (
          <span
            style={{
              color: 'var(--ifm-color-success-dark)',
              fontSize: '0.85em',
              fontWeight: 500,
            }}
          >
            Saved
          </span>
        )}
      </div>

      {error && (
        <div
          style={{
            color: 'var(--ifm-color-danger-dark)',
            background: 'var(--ifm-color-danger-contrast-background)',
            border: '1px solid var(--ifm-color-danger-dark)',
            borderRadius: '4px',
            padding: '0.5rem 1rem',
            fontSize: '0.85em',
            marginBottom: '0.75rem',
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--ifm-color-emphasis-600)', fontStyle: 'italic' }}>
          Loading notes...
        </p>
      ) : editing ? (
        <div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            style={{
              width: '100%',
              minHeight: '200px',
              padding: '1rem',
              border: '1px solid var(--ifm-color-emphasis-300)',
              borderRadius: '4px',
              fontFamily: 'var(--ifm-font-family-base)',
              fontSize: '0.95em',
              lineHeight: 1.6,
              resize: 'vertical',
              background: 'var(--ifm-color-emphasis-0)',
              color: 'var(--ifm-font-color-base)',
            }}
            placeholder="Write your notes here..."
          />
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                ...BUTTON_BASE,
                background: 'var(--ifm-color-primary)',
                color: 'var(--ifm-color-white)',
                border: '1px solid var(--ifm-color-primary)',
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={handleCancel}
              disabled={saving}
              style={BUTTON_BASE}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : content ? (
        <div
          style={{
            border: '1px solid var(--ifm-color-emphasis-300)',
            borderRadius: '4px',
            padding: '1rem',
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--ifm-font-family-base)',
            lineHeight: 1.6,
          }}
        >
          {content}
        </div>
      ) : (
        <p style={{ color: 'var(--ifm-color-emphasis-600)', fontStyle: 'italic' }}>
          No notes yet. Click Edit to add notes for this reference.
        </p>
      )}
    </div>
  );
}

function RelatedPapers({ title }) {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [addingIdx, setAddingIdx] = useState(null);
  const [addedSet, setAddedSet] = useState(new Set());

  const handleSearch = () => {
    setLoading(true);
    setError(null);
    setResults(null);
    const url =
      S2_PAPER_SEARCH + '?query=' +
      encodeURIComponent(title) +
      '&limit=5&fields=title,authors,year,venue,url';
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Semantic Scholar returned ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setResults(data.data || []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const handleAdd = (paper, idx) => {
    setAddingIdx(idx);
    const ref = {
      title: paper.title,
      author: (paper.authors || []).map((a) => a.name),
      year: paper.year,
      venue: paper.venue || '',
      url: paper.url || '',
    };
    fetch(`${API_BASE}/api/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ref),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        return res.json();
      })
      .then(() => {
        setAddedSet((prev) => new Set(prev).add(idx));
      })
      .catch((err) => {
        setError('Failed to add: ' + err.message);
      })
      .finally(() => setAddingIdx(null));
  };


  return (
    <div style={{ marginBottom: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>Related Papers</h2>
        <button
          onClick={handleSearch}
          disabled={loading}
          style={{ ...BUTTON_BASE, opacity: loading ? 0.6 : 1 }}
        >
          {loading ? 'Searching...' : 'Find Related Papers'}
        </button>
      </div>

      {error && (
        <div style={{
          color: 'var(--ifm-color-danger-dark)',
          background: 'var(--ifm-color-danger-contrast-background)',
          border: '1px solid var(--ifm-color-danger-dark)',
          borderRadius: '4px',
          padding: '0.5rem 1rem',
          fontSize: '0.85em',
          marginBottom: '0.75rem',
        }}>
          {error}
        </div>
      )}

      {loading && (
        <p style={{ color: 'var(--ifm-color-emphasis-600)', fontStyle: 'italic' }}>
          Loading...
        </p>
      )}

      {results && results.length === 0 && (
        <p style={{ color: 'var(--ifm-color-emphasis-600)', fontStyle: 'italic' }}>
          No related papers found.
        </p>
      )}

      {results && results.length > 0 && (
        <div style={{
          border: '1px solid var(--ifm-color-emphasis-200)',
          borderRadius: '6px',
          overflow: 'hidden',
        }}>
          {results.map((paper, idx) => (
            <div
              key={idx}
              style={{
                padding: '0.75rem 1rem',
                borderBottom: idx < results.length - 1 ? '1px solid var(--ifm-color-emphasis-200)' : 'none',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: '12px',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '0.95em', marginBottom: '2px' }}>
                  {paper.url ? (
                    <a href={paper.url} target="_blank" rel="noopener noreferrer">
                      {paper.title}
                    </a>
                  ) : (
                    paper.title
                  )}
                </div>
                <div style={{ fontSize: '0.85em', color: 'var(--ifm-color-emphasis-700)' }}>
                  {(paper.authors || []).map((a) => a.name).join(', ')}
                  {paper.year && <span> ({paper.year})</span>}
                </div>
              </div>
              <button
                onClick={() => handleAdd(paper, idx)}
                disabled={addingIdx === idx || addedSet.has(idx)}
                style={{
                  ...BUTTON_BASE,
                  flexShrink: 0,
                  fontSize: '0.8em',
                  padding: '2px 10px',
                  background: addedSet.has(idx)
                    ? 'var(--ifm-color-success-contrast-background)'
                    : 'var(--ifm-color-emphasis-0)',
                  color: addedSet.has(idx)
                    ? 'var(--ifm-color-success-dark)'
                    : 'var(--ifm-font-color-base)',
                  opacity: addingIdx === idx ? 0.6 : 1,
                }}
              >
                {addedSet.has(idx) ? 'Added' : addingIdx === idx ? 'Adding...' : 'Add to Bibliography'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
