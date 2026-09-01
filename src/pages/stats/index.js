import React, { useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import API_BASE, { apiFetch } from '@site/src/utils/api';
import { CHART_HUES } from '@site/src/utils/chartColors';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import pageStyles from '@site/src/css/page.module.css';

// ── Shared styles ────────────────────────────────────────────────

const cardStyle = {
  flex: '1 1 180px',
  padding: '1.25rem',
  borderRadius: '8px',
  background: 'var(--ifm-card-background-color, #fff)',
  border: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
  textAlign: 'center',
};

const sectionStyle = {
  marginBottom: '2.5rem',
};

const hues = CHART_HUES;

// ── Helper: format large numbers ─────────────────────────────────

function fmt(n) {
  return (n || 0).toLocaleString();
}

// ── Main dashboard component ─────────────────────────────────────

function StatsDashboard() {
  const [stats, setStats] = useState(null);
  const [references, setReferences] = useState(null);
  const [topics, setTopics] = useState(null);
  const [orphans, setOrphans] = useState(null);
  const [duplicates, setDuplicates] = useState(null);
  const [recentFiles, setRecentFiles] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fetchKey, setFetchKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    const { signal } = controller;

    const fetchJSON = (url) =>
      apiFetch(`${API_BASE}${url}`, { signal }).then((r) => {
        if (!r.ok) throw new Error(`${url} returned ${r.status}`);
        return r.json();
      });

    Promise.all([
      fetchJSON('/api/stats').catch(() => null),
      fetchJSON('/api/references?summary=1').catch(() => null),
      fetchJSON('/api/analytics/topics').catch(() => null),
      fetchJSON('/api/analytics/orphans').catch(() => null),
      fetchJSON('/api/analytics/duplicates').catch(() => null),
      fetchJSON('/api/documents/recent').catch(() => null),
    ])
      .then(([s, r, t, o, d, rf]) => {
        if (signal.aborted) return;
        setStats(s);
        setReferences(r);
        setTopics(t);
        setOrphans(o);
        setDuplicates(d);
        setRecentFiles(rf);
        setLoading(false);
      })
      .catch((err) => {
        if (signal.aborted) return;
        setError(err.message);
        setLoading(false);
      });

    return () => controller.abort();
  }, [fetchKey]);

  // ── Loading state ───────────────────────────────────────────────

  if (loading) {
    return (
      <div className={`${pageStyles.pageContainer} ${pageStyles.wide}`}>
        <LoadingSkeleton shape="text" width="260px" height={36} style={{ marginBottom: '1.5rem' }} />
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={cardStyle}>
              <LoadingSkeleton shape="text" width="60%" height={36} style={{ margin: '0 auto 8px' }} />
              <LoadingSkeleton shape="text" width="80%" height={14} style={{ margin: '0 auto' }} />
            </div>
          ))}
        </div>
        <LoadingSkeleton shape="block" width="100%" height={200} style={{ marginBottom: '2rem' }} />
        <LoadingSkeleton shape="block" width="100%" height={160} />
      </div>
    );
  }

  // ── Error state ─────────────────────────────────────────────────

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem' }}>
        <p role="alert" style={{ color: 'var(--ifm-color-danger-dark, #e74c3c)', marginBottom: '1rem' }}>
          Failed to load statistics: {error}
        </p>
        <button
          onClick={() => setFetchKey(k => k + 1)}
          style={{
            padding: '8px 20px',
            border: '1px solid var(--ifm-color-primary)',
            borderRadius: '6px',
            background: 'var(--ifm-color-primary)',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '0.9em',
            fontWeight: 600,
            fontFamily: 'inherit',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Derived values ──────────────────────────────────────────────

  const totalFiles = stats?.totalFiles || 0;
  const totalWords = stats?.totalWords || 0;

  const totalRefs = references?.total || 0;


  // By-directory breakdown
  const byDir = stats?.byDirectory || {};
  const sections = Object.entries(byDir)
    .map(([name, info]) => ({ name, words: info.words || 0, files: info.files || 0 }))
    .filter((s) => s.words > 0)
    .sort((a, b) => b.words - a.words);
  const maxSectionWords = sections.length > 0 ? sections[0].words : 1;

  // Topics
  const topicList = topics?.topics || (Array.isArray(topics) ? topics : []);

  // Orphans & duplicates
  const orphanList = orphans?.orphans || (Array.isArray(orphans) ? orphans : []);
  const dupList = duplicates?.duplicates || (Array.isArray(duplicates) ? duplicates : []);

  // Recent files
  const recentList = recentFiles?.files || (Array.isArray(recentFiles) ? recentFiles : []);

  // Reference type & year breakdowns
  const refsByType = references?.byType || {};
  const refsByYear = references?.byYear || {};
  const typeSorted = Object.entries(refsByType).sort((a, b) => b[1] - a[1]);
  const maxTypeCount = typeSorted.length > 0 ? typeSorted[0][1] : 1;

  const yearSorted = Object.entries(refsByYear)
    .map(([y, c]) => [Number(y), c])
    .sort((a, b) => a[0] - b[0]);
  const maxYearCount = yearSorted.length > 0 ? Math.max(...yearSorted.map((y) => y[1])) : 1;

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className={`${pageStyles.pageContainer} ${pageStyles.wide}`} role="main" aria-label="Content statistics dashboard">
      <h1>Content Statistics</h1>

      {/* ── 1. Overview Cards ─────────────────────────────────────── */}
      <div
        role="region"
        aria-label="Overview statistics"
        style={{
          display: 'flex',
          gap: '1rem',
          marginBottom: '2.5rem',
          flexWrap: 'wrap',
        }}
      >
        {[
          { value: fmt(totalFiles), label: 'Total Files' },
          { value: fmt(totalWords), label: 'Total Words' },
          { value: fmt(totalRefs), label: 'References' },
        ].map(({ value, label }) => (
          <div key={label} style={cardStyle}>
            <div style={{ fontSize: '2rem', fontWeight: 700, lineHeight: 1.2 }}>{value}</div>
            <div style={{ color: '#888', fontSize: '0.9rem', marginTop: '4px' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* ── 2. Content by Section (bar chart) ─────────────────────── */}
      {sections.length > 0 && (
        <div style={sectionStyle} role="region" aria-label="Content by section">
          <h2>Content by Section</h2>
          <div>
            {sections.map((s, i) => {
              const pct = (s.words / maxSectionWords) * 100;
              return (
                <div key={s.name} style={{ marginBottom: '10px' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '0.85rem',
                      marginBottom: '3px',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{s.name}</span>
                    <span style={{ color: '#888' }}>
                      {fmt(s.words)} words &middot; {fmt(s.files)} files
                    </span>
                  </div>
                  <div
                    style={{
                      height: '12px',
                      borderRadius: '6px',
                      background: 'var(--ifm-color-emphasis-200, #e0e0e0)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.max(pct, 1)}%`,
                        borderRadius: '6px',
                        background: `hsl(${hues[i % hues.length]}, 60%, 50%)`,
                        transition: 'width 0.3s ease',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 3. Top Keywords (word cloud) ──────────────────────────── */}
      {topicList.length > 0 && (
        <div style={sectionStyle}>
          <h2>Top Keywords</h2>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '8px 14px',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '1.25rem',
              borderRadius: '8px',
              background: 'var(--ifm-card-background-color, #fff)',
              border: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
            }}
          >
            {(() => {
              const top40 = topicList.slice(0, 40);
              const counts = top40.map((t) => t.count);
              const minC = Math.min(...counts);
              const maxC = Math.max(...counts);
              const range = maxC - minC || 1;

              return top40.map((t, i) => {
                const ratio = (t.count - minC) / range;
                const fontSize = 0.7 + ratio * 1.4;
                const hue = hues[i % hues.length];
                const lightness = 35 + (1 - ratio) * 20;
                return (
                  <span
                    key={t.word}
                    title={`${t.word}: ${fmt(t.count)} occurrences`}
                    style={{
                      fontSize: `${fontSize}rem`,
                      fontWeight: ratio > 0.5 ? 700 : 500,
                      color: `hsl(${hue}, 65%, ${lightness}%)`,
                      cursor: 'default',
                      lineHeight: 1.4,
                    }}
                  >
                    {t.word}
                  </span>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* ── 4. Content Health ─────────────────────────────────────── */}
      <div style={sectionStyle}>
        <h2>Content Health</h2>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <div
            style={{
              ...cardStyle,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                fontSize: '2rem',
                fontWeight: 700,
                color:
                  orphanList.length === 0
                    ? 'var(--ifm-color-success-dark, #2e7d32)'
                    : 'var(--ifm-color-warning-dark, #e67e22)',
              }}
            >
              {orphanList.length}
            </div>
            <div style={{ color: '#888', fontSize: '0.9rem' }}>Orphan Pages</div>
            <div style={{ color: '#aaa', fontSize: '0.75rem', marginTop: '4px' }}>
              Pages not linked from any other page
            </div>
          </div>
          <div
            style={{
              ...cardStyle,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                fontSize: '2rem',
                fontWeight: 700,
                color:
                  dupList.length === 0
                    ? 'var(--ifm-color-success-dark, #2e7d32)'
                    : 'var(--ifm-color-warning-dark, #e67e22)',
              }}
            >
              {dupList.length}
            </div>
            <div style={{ color: '#888', fontSize: '0.9rem' }}>Duplicate Pairs</div>
            <div style={{ color: '#aaa', fontSize: '0.75rem', marginTop: '4px' }}>
              Pages with highly similar content
            </div>
          </div>
        </div>
      </div>

      {/* ── 5. Writing Activity (recent modifications) ────────────── */}
      {recentList.length > 0 && (
        <div style={sectionStyle}>
          <h2>Writing Activity</h2>
          <p style={{ fontSize: '0.85rem', color: '#888', marginBottom: '12px' }}>
            Most recently modified files
          </p>
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '480px' }}>
              <thead>
                <tr>
                  <th style={thStyle}>File</th>
                  <th style={{ ...thStyle, textAlign: 'right', width: '120px' }}>Words</th>
                  <th style={{ ...thStyle, width: '180px' }}>Modified</th>
                </tr>
              </thead>
              <tbody>
                {recentList.slice(0, 20).map((f, i) => {
                  const path = f.file || f.path || f.name || '';
                  const words = f.words || f.wordCount || 0;
                  const modified = f.modified || f.mtime || f.date || '';
                  const dateStr = modified
                    ? new Date(modified).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })
                    : '--';
                  return (
                    <tr key={i}>
                      <td style={tdStyle}>
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            display: 'block',
                            maxWidth: '350px',
                          }}
                          title={path}
                        >
                          {path}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                        {fmt(words)}
                      </td>
                      <td style={tdStyle}>{dateStr}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 6. Reference Statistics ───────────────────────────────── */}
      {totalRefs > 0 && (
        <div style={sectionStyle}>
          <h2>Reference Statistics</h2>

          {/* By type */}
          {typeSorted.length > 0 && (
            <div style={{ marginBottom: '2rem' }}>
              <h3>References by Type</h3>
              {typeSorted.map(([type, count], i) => {
                const pct = (count / maxTypeCount) * 100;
                return (
                  <div key={type} style={{ marginBottom: '8px' }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: '0.85rem',
                        marginBottom: '2px',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{type}</span>
                      <span style={{ fontWeight: 600 }}>{count}</span>
                    </div>
                    <div
                      style={{
                        height: '10px',
                        borderRadius: '5px',
                        background: 'var(--ifm-color-emphasis-200, #e0e0e0)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.max(pct, 2)}%`,
                          borderRadius: '5px',
                          background: `hsl(${hues[i % hues.length]}, 55%, 50%)`,
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* By year */}
          {yearSorted.length > 0 && (
            <div>
              <h3>References by Year</h3>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-end',
                  gap: '2px',
                  height: '200px',
                  padding: '0.5rem 0',
                  borderBottom: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
                }}
              >
                {yearSorted.map(([year, count]) => {
                  const heightPct = (count / maxYearCount) * 100;
                  return (
                    <div
                      key={year}
                      style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        height: '100%',
                        position: 'relative',
                        minWidth: '14px',
                      }}
                      title={`${year}: ${count} reference${count !== 1 ? 's' : ''}`}
                    >
                      {count > 0 && (
                        <span
                          style={{
                            fontSize: '0.6rem',
                            color: '#888',
                            marginBottom: '2px',
                          }}
                        >
                          {count}
                        </span>
                      )}
                      <div
                        style={{
                          width: '100%',
                          maxWidth: '36px',
                          height: count > 0 ? `${Math.max(heightPct, 4)}%` : '0%',
                          background: 'var(--ifm-color-primary, #2568c2)',
                          borderRadius: '3px 3px 0 0',
                          transition: 'height 0.3s ease',
                          minHeight: count > 0 ? '4px' : '0',
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: '2px',
                  marginTop: '4px',
                }}
              >
                {yearSorted.map(([year]) => (
                  <div
                    key={year}
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      fontSize: '0.55rem',
                      color: '#888',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: '14px',
                    }}
                  >
                    {year}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Table styles ─────────────────────────────────────────────────

const thStyle = {
  textAlign: 'left',
  padding: '0.5rem 0.75rem',
  borderBottom: '2px solid var(--ifm-color-emphasis-300, #ccc)',
  fontSize: '0.8rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#888',
};

const tdStyle = {
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
  fontSize: '0.9rem',
};

// ── Page export ──────────────────────────────────────────────────

export default function StatsPage() {
  return (
    <Layout title="Content Statistics" description="Deep insights into the knowledge base">
      <BrowserOnly>
        {() => (
          <ErrorBoundary>
            <StatsDashboard />
          </ErrorBoundary>
        )}
      </BrowserOnly>
    </Layout>
  );
}
