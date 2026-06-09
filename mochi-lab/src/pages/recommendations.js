import React, { useState, useEffect, useCallback } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import API_BASE from '@site/src/utils/api';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';

function formatAuthors(authors) {
  if (!authors || authors.length === 0) return 'Unknown';
  if (authors.length <= 3) return authors.join(', ');
  return `${authors.slice(0, 3).join(', ')}, et al.`;
}

function RecommendationsDashboard() {
  const [recommendations, setRecommendations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [addingIdx, setAddingIdx] = useState(null);
  const [addedSet, setAddedSet] = useState(new Set());
  const [progress, setProgress] = useState('');

  const fetchRecommendations = useCallback(async () => {
    setLoading(true);
    setError(null);
    setProgress('Analyzing your bibliography and fetching recommendations...');
    try {
      const resp = await fetch(`${API_BASE}/api/recommendations`);
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      setRecommendations(data.recommendations || []);
      setProgress('');
    } catch (err) {
      setError(err.message);
      setProgress('');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecommendations();
  }, [fetchRecommendations]);

  const handleAdd = async (rec, idx) => {
    setAddingIdx(idx);
    try {
      const resp = await fetch(`${API_BASE}/api/recommendations/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: rec.title,
          authors: rec.authors,
          year: rec.year,
          venue: rec.venue,
          arxivId: rec.arxivId,
        }),
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setAddedSet((prev) => new Set([...prev, idx]));
      } else {
        alert(`Failed to add: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Network error: ${err.message}`);
    } finally {
      setAddingIdx(null);
    }
  };

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <h1 style={{ margin: 0 }}>Discover Papers</h1>
        <button
          onClick={() => {
            setAddedSet(new Set());
            fetchRecommendations();
          }}
          disabled={loading}
          style={{
            padding: '8px 16px',
            border: '1px solid var(--ifm-color-primary)',
            borderRadius: 6,
            background: 'var(--ifm-color-primary)',
            color: '#fff',
            cursor: loading ? 'wait' : 'pointer',
            fontSize: '0.85em',
            fontWeight: 600,
            fontFamily: 'inherit',
            opacity: loading ? 0.6 : 1,
          }}
        >
          Refresh
        </button>
      </div>
      <p style={{ color: 'var(--ifm-color-emphasis-600)', marginBottom: '1.5rem' }}>
        Paper recommendations based on the references in your bibliography, powered by Semantic Scholar.
      </p>

      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                padding: '16px',
                borderRadius: '8px',
                border: '1px solid var(--ifm-color-emphasis-200)',
                background: 'var(--ifm-card-background-color, var(--ifm-background-color))',
              }}
            >
              <LoadingSkeleton shape="text" width="70%" height={16} />
              <div style={{ marginTop: 10 }}>
                <LoadingSkeleton shape="text" width="50%" height={12} />
              </div>
              <div style={{ marginTop: 10 }}>
                <LoadingSkeleton shape="text" width="85%" height={11} />
              </div>
            </div>
          ))}
          {progress && (
            <p style={{ color: 'var(--ifm-color-emphasis-600)', fontSize: '0.9em', margin: 0, textAlign: 'center' }}>
              {progress}
            </p>
          )}
        </div>
      )}

      {error && (
        <div style={{
          color: 'var(--ifm-color-danger-dark)',
          background: 'var(--ifm-color-danger-contrast-background)',
          border: '1px solid var(--ifm-color-danger-dark)',
          borderRadius: '6px',
          padding: '1rem',
          fontSize: '0.9em',
          marginBottom: '1rem',
        }}>
          Failed to load recommendations: {error}
        </div>
      )}

      {!loading && !error && recommendations.length === 0 && (
        <div style={{
          textAlign: 'center',
          padding: '3rem 1rem',
          color: 'var(--ifm-color-emphasis-500)',
        }}>
          <p style={{ fontSize: '1.1em', fontWeight: 500 }}>No recommendations available</p>
          <p style={{ fontSize: '0.9em' }}>
            This may happen if referenced papers are not indexed by Semantic Scholar,
            or if your bibliography does not contain papers with identifiable arXiv/DOI links.
          </p>
        </div>
      )}

      {!loading && recommendations.length > 0 && (
        <div>
          <p style={{
            fontSize: '0.85em',
            color: 'var(--ifm-color-emphasis-600)',
            marginBottom: '1rem',
          }}>
            Showing {recommendations.length} recommended papers, sorted by relevance score.
          </p>

          {recommendations.map((rec, idx) => {
            const isAdded = addedSet.has(idx);
            const isAdding = addingIdx === idx;
            const arxivUrl = rec.arxivId ? `https://arxiv.org/abs/${rec.arxivId}` : null;

            return (
              <div
                key={idx}
                style={{
                  padding: '16px',
                  marginBottom: '10px',
                  borderRadius: '8px',
                  border: '1px solid var(--ifm-color-emphasis-200)',
                  background: 'var(--ifm-card-background-color, var(--ifm-background-color))',
                  transition: 'border-color 0.2s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '1em', lineHeight: 1.4, marginBottom: '6px' }}>
                      {arxivUrl ? (
                        <a href={arxivUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ifm-color-primary)', textDecoration: 'none' }}>
                          {rec.title}
                        </a>
                      ) : (
                        rec.title
                      )}
                    </div>
                    <div style={{ fontSize: '0.88em', color: 'var(--ifm-color-emphasis-700)', marginBottom: '4px' }}>
                      {formatAuthors(rec.authors)}
                      {rec.year && <span> ({rec.year})</span>}
                      {rec.venue && <span> &mdash; {rec.venue}</span>}
                    </div>
                    <div style={{ fontSize: '0.82em', color: 'var(--ifm-color-emphasis-500)', marginTop: '6px' }}>
                      <span style={{ fontWeight: 500 }}>Recommended because you cited:</span>{' '}
                      {rec.recommendedBy.map((title, i) => (
                        <span key={i}>
                          {i > 0 && ', '}
                          <em>{title}</em>
                        </span>
                      ))}
                    </div>
                    {rec.score > 1 && (
                      <div style={{
                        display: 'inline-block',
                        marginTop: '6px',
                        padding: '2px 8px',
                        borderRadius: '10px',
                        fontSize: '0.75em',
                        fontWeight: 600,
                        background: 'var(--ifm-color-primary-contrast-background)',
                        color: 'var(--ifm-color-primary-dark)',
                      }}>
                        Score: {rec.score} (cited by {rec.score} of your papers)
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => handleAdd(rec, idx)}
                    disabled={isAdded || isAdding}
                    style={{
                      flexShrink: 0,
                      padding: '6px 14px',
                      fontSize: '0.82em',
                      fontWeight: 600,
                      borderRadius: '6px',
                      border: isAdded
                        ? '1px solid var(--ifm-color-success-dark)'
                        : '1px solid var(--ifm-color-primary)',
                      background: isAdded
                        ? 'var(--ifm-color-success-contrast-background)'
                        : 'transparent',
                      color: isAdded
                        ? 'var(--ifm-color-success-dark)'
                        : 'var(--ifm-color-primary)',
                      cursor: isAdded || isAdding ? 'default' : 'pointer',
                      opacity: isAdding ? 0.5 : 1,
                      whiteSpace: 'nowrap',
                      fontFamily: 'inherit',
                      marginTop: '2px',
                    }}
                    title={isAdded ? 'Already added to bibliography' : 'Add to bibliography'}
                  >
                    {isAdded ? 'Added' : isAdding ? 'Adding...' : 'Add to Bibliography'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function RecommendationsPage() {
  return (
    <Layout title="Discover" description="Paper recommendations based on your bibliography">
      <BrowserOnly>{() => <ErrorBoundary><RecommendationsDashboard /></ErrorBoundary>}</BrowserOnly>
    </Layout>
  );
}
