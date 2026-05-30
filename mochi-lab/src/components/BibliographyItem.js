import React, { useState } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import { usePluginData } from '@docusaurus/useGlobalData';
import { useLocation } from '@docusaurus/router';

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

  return (
    <Layout title={key} description={entry.title}>
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
          <p style={{ margin: '4px 0' }}>
            <strong>Cite as:</strong> <code>[@{key}]</code>
          </p>
        </div>

        <RawFilesSection entry={entry} bibKey={key} />
        <BibtexSection bibtex={entry.bibtex} />
        <NotesSection notes={entry.notes} bibKey={key} />
      </div>
    </Layout>
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

function NotesSection({ notes, bibKey }) {
  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2>Notes</h2>
      {notes ? (
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
          {notes}
        </div>
      ) : (
        <p style={{ color: 'var(--ifm-color-emphasis-600)', fontStyle: 'italic' }}>
          No notes yet. Create notes/{bibKey}.md to add notes.
        </p>
      )}
    </div>
  );
}
