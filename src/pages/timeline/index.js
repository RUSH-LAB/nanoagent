import React, { useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import API_BASE, { apiFetch } from '@site/src/utils/api';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import { displayDirPath } from '@site/src/utils/paths';
import pageStyles from '@site/src/css/page.module.css';

// ── Color map for content types ─────────────────────────────────

const TYPE_COLORS = {
  books: { dot: '#3b82f6', bg: 'rgba(59, 130, 246, 0.08)', label: '#2563eb' },
  posts: { dot: '#22c55e', bg: 'rgba(34, 197, 94, 0.08)', label: '#16a34a' },
};

const DEFAULT_COLOR = { dot: '#94a3b8', bg: 'rgba(148, 163, 184, 0.08)', label: '#64748b' };

function getContentType(filePath) {
  if (!filePath) return 'other';
  const lower = filePath.toLowerCase();
  if (lower.includes('/books/')) return 'books';
  if (lower.includes('/posts/') || lower.includes('/blog/')) return 'posts';
  return 'other';
}

function getColors(type) {
  return TYPE_COLORS[type] || DEFAULT_COLOR;
}

// ── Helpers ─────────────────────────────────────────────────────

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function extractFileName(filePath) {
  if (!filePath) return 'Untitled';
  const parts = filePath.split('/');
  const raw = parts[parts.length - 1];
  return raw.replace(/\.(md|mdx)$/, '');
}

function groupByDay(files) {
  const groups = {};
  for (const f of files) {
    const date = f.modified || f.mtime || f.date || '';
    if (!date) continue;
    const dayKey = new Date(date).toISOString().slice(0, 10);
    if (!groups[dayKey]) groups[dayKey] = [];
    groups[dayKey].push(f);
  }
  // Sort days descending (most recent first)
  return Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, items]) => ({ day, items }));
}

// ── Timeline component ──────────────────────────────────────────

function ContentTimeline() {
  const [files, setFiles] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fetchKey, setFetchKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch(`${API_BASE}/api/files/recent?limit=50`)
      .then((r) => {
        if (!r.ok) throw new Error(`API returned ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setFiles(d.files || (Array.isArray(d) ? d : []));
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [fetchKey]);

  // ── Loading ───────────────────────────────────────────────────

  if (loading) {
    return (
      <div className={pageStyles.pageContainer}>
        <LoadingSkeleton shape="text" width="200px" height={32} style={{ marginBottom: '2rem' }} />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={{ display: 'flex', gap: '1.5rem', marginBottom: '1.5rem' }}>
            <LoadingSkeleton shape="text" width="100px" height={16} />
            <LoadingSkeleton shape="block" width="100%" height={60} />
          </div>
        ))}
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem' }}>
        <p role="alert" style={{ color: '#e74c3c', marginBottom: '1rem' }}>
          Failed to load timeline: {error}
        </p>
        <button
          onClick={() => setFetchKey(k => k + 1)}
          style={{
            padding: '8px 20px',
            border: '1px solid var(--ifm-color-emphasis-300, #ccc)',
            borderRadius: '6px',
            background: 'var(--ifm-color-primary, #2568c2)',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '0.9rem',
            fontWeight: 600,
            fontFamily: 'inherit',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Empty ─────────────────────────────────────────────────────

  if (!files || files.length === 0) {
    return (
      <p style={{ textAlign: 'center', padding: '3rem', color: '#888' }}>
        No recent file activity found.
      </p>
    );
  }

  // ── Group and render ──────────────────────────────────────────

  const dayGroups = groupByDay(files);

  return (
    <div className={pageStyles.pageContainer}>
      <h1 style={{ marginBottom: '0.5rem' }}>Content Timeline</h1>
      <p style={{ color: '#888', fontSize: '0.9rem', marginBottom: '2rem' }}>
        Recent content activity across the knowledge base
      </p>

      {/* Legend */}
      <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '2rem', fontSize: '0.8rem' }}>
        {Object.entries(TYPE_COLORS).map(([type, colors]) => (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: colors.dot, display: 'inline-block',
            }} />
            <span style={{ color: '#666', textTransform: 'capitalize' }}>{type}</span>
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{
            width: 10, height: 10, borderRadius: '50%',
            background: DEFAULT_COLOR.dot, display: 'inline-block',
          }} />
          <span style={{ color: '#666' }}>Other</span>
        </div>
      </div>

      {/* Timeline */}
      <div style={{ position: 'relative' }} role="feed" aria-label="Content timeline">
        {dayGroups.map((group) => {
          const dateLabel = formatDate(group.day);
          return (
            <div key={group.day} style={{ marginBottom: '2rem' }}>
              {/* Day header */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '1rem',
                marginBottom: '1rem',
              }}>
                <div style={{
                  fontSize: '0.8rem', fontWeight: 700,
                  color: 'var(--ifm-color-primary, #2568c2)',
                  whiteSpace: 'nowrap', minWidth: '120px',
                  textAlign: 'right',
                }}>
                  {dateLabel}
                </div>
                <div style={{
                  flex: 1, height: '1px',
                  background: 'var(--ifm-color-emphasis-300, #ccc)',
                }} />
              </div>

              {/* Items for this day */}
              <div style={{ position: 'relative', paddingLeft: '140px' }}>
                {/* Vertical connecting line */}
                {group.items.length > 1 && (
                  <div style={{
                    position: 'absolute',
                    left: '147px',
                    top: '10px',
                    bottom: '10px',
                    width: '2px',
                    background: 'var(--ifm-color-emphasis-200, #e0e0e0)',
                  }} />
                )}

                {group.items.map((file, fi) => {
                  const filePath = file.file || file.path || file.name || '';
                  const type = getContentType(filePath);
                  const colors = getColors(type);
                  const wordCount = file.words || file.wordCount || 0;
                  const fileName = file.title || extractFileName(filePath);
                  const displayPath = displayDirPath(filePath);
                  const modified = file.modified || file.mtime || file.date || '';
                  const timeStr = modified
                    ? new Date(modified).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '';

                  return (
                    <div
                      key={fi}
                      style={{
                        position: 'relative',
                        marginBottom: fi < group.items.length - 1 ? '0.75rem' : 0,
                        paddingLeft: '24px',
                      }}
                    >
                      {/* Dot node */}
                      <div style={{
                        position: 'absolute',
                        left: '4px',
                        top: '12px',
                        width: '12px',
                        height: '12px',
                        borderRadius: '50%',
                        background: colors.dot,
                        border: '2px solid var(--ifm-background-color, #fff)',
                        boxShadow: `0 0 0 2px ${colors.dot}`,
                        zIndex: 1,
                      }} />

                      {/* Card */}
                      <div
                        style={{
                          display: 'block',
                          padding: '12px 16px',
                          borderRadius: '8px',
                          background: colors.bg,
                          border: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
                        }}
                      >
                        <div style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          gap: '1rem',
                        }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontWeight: 600,
                              fontSize: '0.95rem',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}>
                              {fileName}
                            </div>
                            <div style={{
                              fontSize: '0.78rem',
                              color: 'var(--ifm-color-emphasis-600, #666)',
                              marginTop: '3px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}>
                              {displayPath}
                            </div>
                          </div>
                          <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'flex-end',
                            flexShrink: 0,
                            gap: '2px',
                          }}>
                            {timeStr && (
                              <span style={{
                                fontSize: '0.75rem',
                                color: 'var(--ifm-color-emphasis-500, #888)',
                              }}>
                                {timeStr}
                              </span>
                            )}
                            {wordCount > 0 && (
                              <span style={{
                                fontSize: '0.72rem',
                                color: colors.label,
                                fontWeight: 600,
                              }}>
                                {wordCount.toLocaleString()} words
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Page export ──────────────────────────────────────────────────

export default function TimelinePage() {
  return (
    <Layout title="Timeline" description="Visual timeline of content creation and modification">
      <BrowserOnly>
        {() => (
          <ErrorBoundary>
            <ContentTimeline />
          </ErrorBoundary>
        )}
      </BrowserOnly>
    </Layout>
  );
}
