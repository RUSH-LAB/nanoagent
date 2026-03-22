import React, { useState, useMemo } from 'react';
import Layout from '@theme/Layout';
import { usePluginData } from '@docusaurus/useGlobalData';

/**
 * Format author list for display.
 */
function formatAuthors(authors) {
  if (!authors || authors.length === 0) return 'Unknown';
  if (authors.length <= 3) return authors.join(', ');
  return `${authors.slice(0, 3).join(', ')}, et al.`;
}

/**
 * A single reference entry in the bibliography list.
 */
function ReferenceEntry({ citationKey, entry }) {
  const authors = formatAuthors(entry.author);
  const venue = entry.venue || '';
  const vol = entry.volume ? `, vol. ${entry.volume}` : '';
  const pages = entry.pages ? `, pp. ${entry.pages}` : '';

  return (
    <div id={`ref-${citationKey}`} className="reference-item" style={{
      padding: '12px 16px',
      marginBottom: '8px',
      borderRadius: '6px',
      border: '1px solid var(--ifm-color-emphasis-200)',
      scrollMarginTop: '80px',
      textIndent: 0,
      paddingLeft: '16px',
    }}>
      <div style={{ marginBottom: '4px' }}>
        <code style={{ fontSize: '0.85em', color: 'var(--ifm-color-primary)' }}>
          @{citationKey}
        </code>
        <span style={{
          marginLeft: '8px',
          fontSize: '0.8em',
          padding: '2px 6px',
          borderRadius: '3px',
          backgroundColor: 'var(--ifm-color-emphasis-100)',
          color: 'var(--ifm-color-emphasis-700)',
        }}>
          {entry.type || 'misc'}
        </span>
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
    </div>
  );
}

export default function BibliographyPage() {
  const { references } = usePluginData('bibliography');
  const [search, setSearch] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  // Compute available years and types for filters
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

  // Filter and sort references
  const filtered = useMemo(() => {
    const entries = Object.entries(references || {});
    const searchLower = search.toLowerCase();

    return entries
      .filter(([key, entry]) => {
        // Search filter
        if (searchLower) {
          const matchesSearch =
            key.toLowerCase().includes(searchLower) ||
            (entry.title || '').toLowerCase().includes(searchLower) ||
            (entry.author || []).some((a) => a.toLowerCase().includes(searchLower));
          if (!matchesSearch) return false;
        }
        // Year filter
        if (yearFilter && String(entry.year) !== yearFilter) return false;
        // Type filter
        if (typeFilter && entry.type !== typeFilter) return false;
        return true;
      })
      .sort(([, a], [, b]) => {
        // Sort by year descending, then author ascending
        const yearCmp = (b.year || 0) - (a.year || 0);
        if (yearCmp !== 0) return yearCmp;
        const authorA = (a.author || [''])[0];
        const authorB = (b.author || [''])[0];
        return authorA.localeCompare(authorB);
      });
  }, [references, search, yearFilter, typeFilter]);

  return (
    <Layout title="Bibliography" description="Complete bibliography of cited references">
      <main style={{ padding: '2rem', maxWidth: '900px', margin: '0 auto' }}>
        <h1>Bibliography</h1>
        <p style={{ color: 'var(--ifm-color-emphasis-600)' }}>
          All references cited across Mochi Lab. Use <code>[@key]</code> in any
          markdown file to cite a reference.
        </p>

        {/* Search and filters */}
        <div style={{
          display: 'flex',
          gap: '12px',
          marginBottom: '24px',
          flexWrap: 'wrap',
        }}>
          <input
            type="text"
            placeholder="Search by title, author, or key..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: '1 1 300px',
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid var(--ifm-color-emphasis-300)',
              fontSize: '0.95em',
              backgroundColor: 'var(--ifm-background-color)',
              color: 'var(--ifm-font-color-base)',
            }}
          />
          <select
            value={yearFilter}
            onChange={(e) => setYearFilter(e.target.value)}
            style={{
              padding: '8px 12px',
              borderRadius: '6px',
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
              padding: '8px 12px',
              borderRadius: '6px',
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

        {/* Results count */}
        <p style={{ fontSize: '0.9em', color: 'var(--ifm-color-emphasis-600)', marginBottom: '16px' }}>
          Showing {filtered.length} of {Object.keys(references || {}).length} references
        </p>

        {/* Reference list */}
        {filtered.map(([key, entry]) => (
          <ReferenceEntry key={key} citationKey={key} entry={entry} />
        ))}

        {filtered.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--ifm-color-emphasis-500)', padding: '2rem' }}>
            No references match your search.
          </p>
        )}
      </main>
    </Layout>
  );
}
