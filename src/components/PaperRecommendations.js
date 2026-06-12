import React, { useState, useEffect, useRef, useCallback } from 'react';
import API_BASE from '@site/src/utils/api';
import { S2_API_BASE } from '@site/src/utils/semanticScholar';

const REFERENCES_API = `${API_BASE}/api/references`;

// Module-level cache so repeated opens don't re-fetch
const recommendationCache = new Map();

/**
 * Extract a Semantic Scholar-compatible paper identifier from a reference entry.
 * Returns an arXiv ID (e.g. "ArXiv:2103.14030"), DOI, or null.
 */
function extractPaperId(entry) {
  if (entry.paperId) return entry.paperId;

  if (entry.externalIds) {
    if (entry.externalIds.CorpusId) return `CorpusId:${entry.externalIds.CorpusId}`;
    if (entry.externalIds.DOI) return entry.externalIds.DOI;
  }

  // Extract arXiv ID from URL like https://arxiv.org/abs/2103.14030
  if (entry.url) {
    const arxivMatch = entry.url.match(/arxiv\.org\/abs\/(\d+\.\d+(?:v\d+)?)/);
    if (arxivMatch) return `ArXiv:${arxivMatch[1]}`;
  }

  if (entry.arxivId) return `ArXiv:${entry.arxivId}`;
  if (entry.doi) return entry.doi;

  // Try extracting DOI from URL
  if (entry.url) {
    const doiMatch = entry.url.match(/doi\.org\/(10\.\d{4,}\/[^\s]+)/);
    if (doiMatch) return doiMatch[1];
  }

  return null;
}

/**
 * Pick the N entries most likely to be highly cited.
 * Heuristic: prefer entries from well-known venues and with more authors,
 * falling back to recency.
 */
function pickSeedPapers(references, n = 3) {
  const topVenues = new Set([
    'NeurIPS', 'ICML', 'ICLR', 'CVPR', 'ICCV', 'ECCV', 'ACL', 'EMNLP',
    'NAACL', 'AAAI', 'IJCAI', 'Nature', 'Science', 'JMLR',
  ]);

  const entries = Object.entries(references)
    .map(([key, entry]) => {
      const paperId = extractPaperId(entry);
      if (!paperId) return null;
      const venueScore = topVenues.has(entry.venue) ? 10 : 0;
      const authorScore = Math.min((entry.author || []).length, 8);
      const yearScore = (entry.year || 2000) - 2000;
      return { key, entry, paperId, score: venueScore + authorScore + yearScore };
    })
    .filter(Boolean);

  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, n);
}

/**
 * Generate a citation key from a recommendation object.
 * Format: lastNameYearSlug (e.g. "smith2023deep")
 */
function generateCiteKey(rec) {
  const firstAuthor = (rec.authors && rec.authors[0] && rec.authors[0].name) || 'unknown';
  const lastName = firstAuthor.split(' ').pop().toLowerCase().replace(/[^a-z]/g, '');
  const year = rec.year || 'unknown';
  const titleSlug = (rec.title || '')
    .split(/\s+/)
    .slice(0, 2)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return `${lastName}${year}${titleSlug}`;
}

export default function PaperRecommendations({ references }) {
  const [recommendations, setRecommendations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [addingKey, setAddingKey] = useState(null);
  const [addedKeys, setAddedKeys] = useState(new Set());
  const fetchedRef = useRef(false);

  const existingTitles = useRef(new Set());

  useEffect(() => {
    if (references) {
      existingTitles.current = new Set(
        Object.values(references).map((r) => (r.title || '').toLowerCase().trim())
      );
    }
  }, [references]);

  const fetchRecommendations = useCallback(async () => {
    if (!references || Object.keys(references).length === 0) return;

    // Check module-level cache
    const cacheKey = Object.keys(references).sort().join(',');
    if (recommendationCache.has(cacheKey)) {
      setRecommendations(recommendationCache.get(cacheKey));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const seeds = pickSeedPapers(references, 3);
      if (seeds.length === 0) {
        setError('No papers with identifiable IDs found in references.');
        setLoading(false);
        return;
      }

      const allRecs = [];
      const seen = new Set();

      for (const seed of seeds) {
        try {
          const url =
            `${S2_API_BASE}/recommendations/v1/papers/forpaper/${encodeURIComponent(seed.paperId)}` +
            `?limit=10&fields=title,authors,year,venue,externalIds,url`;
          const resp = await fetch(url);
          if (!resp.ok) {
            console.warn(`S2 recommendations failed for ${seed.paperId}: ${resp.status}`);
            continue;
          }
          const data = await resp.json();
          for (const rec of data.recommendedPapers || []) {
            const titleLower = (rec.title || '').toLowerCase().trim();
            // Deduplicate across seeds and against existing references
            if (seen.has(titleLower)) continue;
            if (existingTitles.current.has(titleLower)) continue;
            seen.add(titleLower);
            allRecs.push(rec);
          }
        } catch (err) {
          console.warn(`Failed to fetch recommendations for ${seed.paperId}:`, err);
        }
        // Small delay between requests to respect rate limits
        await new Promise((r) => setTimeout(r, 150));
      }

      // Sort by year descending, then alphabetically
      allRecs.sort(
        (a, b) => (b.year || 0) - (a.year || 0) || (a.title || '').localeCompare(b.title || '')
      );

      const finalRecs = allRecs.slice(0, 15);
      recommendationCache.set(cacheKey, finalRecs);
      setRecommendations(finalRecs);
    } catch (err) {
      setError(`Failed to fetch recommendations: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [references]);

  useEffect(() => {
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      fetchRecommendations();
    }
  }, [fetchRecommendations]);

  const handleAdd = async (rec) => {
    const key = generateCiteKey(rec);
    setAddingKey(key);

    const entry = {
      type: 'article',
      title: rec.title || 'Untitled',
      author: (rec.authors || []).map((a) => a.name),
      year: rec.year || null,
      venue: rec.venue || '',
      url: rec.url || '',
    };

    if (rec.externalIds) {
      if (rec.externalIds.DOI) entry.doi = rec.externalIds.DOI;
      if (rec.externalIds.ArXiv) {
        entry.url = `https://arxiv.org/abs/${rec.externalIds.ArXiv}`;
      }
    }

    try {
      const resp = await fetch(REFERENCES_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, entry }),
      });

      if (resp.ok) {
        setAddedKeys((prev) => new Set([...prev, rec.paperId]));
      } else {
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 409) {
          // Already exists, mark as added
          setAddedKeys((prev) => new Set([...prev, rec.paperId]));
        } else {
          alert(`Failed to add: ${data.error || resp.statusText}`);
        }
      }
    } catch (err) {
      alert(`Network error: ${err.message}`);
    } finally {
      setAddingKey(null);
    }
  };

  const formatAuthors = (authors) => {
    if (!authors || authors.length === 0) return 'Unknown';
    const names = authors.slice(0, 3).map((a) => a.name);
    if (authors.length > 3) names.push(`+${authors.length - 3} more`);
    return names.join(', ');
  };

  return (
    <div style={styles.container}>
      <h3 style={styles.heading}>Recommended Papers</h3>
      <p style={styles.subtitle}>
        Based on the most prominent papers in your bibliography, via Semantic Scholar.
      </p>

      {loading && (
        <div style={styles.loadingContainer}>
          <div style={styles.spinner} />
          <span style={styles.loadingText}>Fetching recommendations...</span>
        </div>
      )}

      {error && <div style={styles.error}>{error}</div>}

      {!loading && !error && recommendations.length === 0 && (
        <p style={styles.emptyText}>
          No recommendations available. This may happen if the referenced papers are not indexed by
          Semantic Scholar.
        </p>
      )}

      {!loading && recommendations.length > 0 && (
        <ul style={styles.list}>
          {recommendations.map((rec) => {
            const isAdded = addedKeys.has(rec.paperId);
            const isAdding = addingKey === generateCiteKey(rec);

            return (
              <li key={rec.paperId || rec.title} style={styles.item}>
                <div style={styles.itemContent}>
                  <a
                    href={rec.url || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={styles.title}
                  >
                    {rec.title}
                  </a>
                  <div style={styles.meta}>
                    <span>{formatAuthors(rec.authors)}</span>
                    {rec.year && <span style={styles.metaSep}>{rec.year}</span>}
                    {rec.venue && <span style={styles.metaSep}>{rec.venue}</span>}
                  </div>
                </div>
                <button
                  onClick={() => handleAdd(rec)}
                  disabled={isAdded || isAdding}
                  style={{
                    ...styles.addButton,
                    ...(isAdded ? styles.addedButton : {}),
                    ...(isAdding ? styles.addingButton : {}),
                  }}
                  title={isAdded ? 'Already added' : 'Add to bibliography'}
                >
                  {isAdded ? 'Added' : isAdding ? '...' : '+ Add'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && (
        <button onClick={fetchRecommendations} style={styles.refreshButton}>
          Refresh Recommendations
        </button>
      )}
    </div>
  );
}

const styles = {
  container: {
    padding: '1.5rem',
    border: '1px solid var(--ifm-color-emphasis-200)',
    borderRadius: '8px',
    background: 'var(--ifm-color-emphasis-0)',
    marginTop: '2rem',
  },
  heading: {
    margin: '0 0 0.25rem 0',
    color: 'var(--ifm-font-color-base)',
    fontSize: '1.2rem',
  },
  subtitle: {
    margin: '0 0 1rem 0',
    fontSize: '0.85em',
    color: 'var(--ifm-color-emphasis-600)',
  },
  loadingContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '1rem 0',
  },
  spinner: {
    width: '18px',
    height: '18px',
    border: '2px solid var(--ifm-color-emphasis-300)',
    borderTopColor: 'var(--ifm-color-primary)',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  loadingText: {
    fontSize: '0.9em',
    color: 'var(--ifm-color-emphasis-600)',
  },
  error: {
    color: 'var(--ifm-color-danger-dark)',
    background: 'var(--ifm-color-danger-contrast-background)',
    border: '1px solid var(--ifm-color-danger-dark)',
    borderRadius: '4px',
    padding: '0.75rem 1rem',
    fontSize: '0.85em',
  },
  emptyText: {
    color: 'var(--ifm-color-emphasis-600)',
    fontStyle: 'italic',
    fontSize: '0.9em',
  },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  item: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '0.75rem 0',
    borderBottom: '1px solid var(--ifm-color-emphasis-100)',
  },
  itemContent: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: '0.95em',
    fontWeight: 500,
    color: 'var(--ifm-color-primary)',
    textDecoration: 'none',
    lineHeight: 1.4,
    display: 'block',
  },
  meta: {
    fontSize: '0.8em',
    color: 'var(--ifm-color-emphasis-600)',
    marginTop: '4px',
    lineHeight: 1.4,
  },
  metaSep: {
    marginLeft: '8px',
    paddingLeft: '8px',
    borderLeft: '1px solid var(--ifm-color-emphasis-300)',
  },
  addButton: {
    flexShrink: 0,
    padding: '4px 12px',
    fontSize: '0.8em',
    fontWeight: 500,
    borderRadius: '4px',
    border: '1px solid var(--ifm-color-primary)',
    background: 'transparent',
    color: 'var(--ifm-color-primary)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    marginTop: '2px',
  },
  addedButton: {
    border: '1px solid var(--ifm-color-success-dark)',
    color: 'var(--ifm-color-success-dark)',
    cursor: 'default',
    opacity: 0.7,
  },
  addingButton: {
    opacity: 0.5,
    cursor: 'wait',
  },
  refreshButton: {
    marginTop: '1rem',
    padding: '6px 16px',
    fontSize: '0.85em',
    borderRadius: '4px',
    border: '1px solid var(--ifm-color-emphasis-300)',
    background: 'var(--ifm-color-emphasis-0)',
    color: 'var(--ifm-font-color-base)',
    cursor: 'pointer',
    fontWeight: 500,
  },
};
