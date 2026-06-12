import React, { useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import API_BASE from '@site/src/utils/api';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import { buildHeatmapWeeks } from '@site/src/utils/heatmap.mjs';

function AnalyticsDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [topics, setTopics] = useState(null);
  const [stats, setStats] = useState(null);
  const [duplicates, setDuplicates] = useState(null);
  const [orphans, setOrphans] = useState(null);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [showOrphans, setShowOrphans] = useState(false);
  const [recentFiles, setRecentFiles] = useState(null);
  const [streak, setStreak] = useState(null);
  const [heatmap, setHeatmap] = useState(null);
  const [writingHeatmapFiles, setWritingHeatmapFiles] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    const fetchJSON = (url) =>
      fetch(`${API_BASE}${url}`, { signal }).then((r) => r.json());

    // Fire all fetches in parallel, each updating its own state slice
    fetchJSON('/api/files/recent?limit=50')
      .then(d => setWritingHeatmapFiles(d.files || []))
      .catch(() => { if (!signal.aborted) setWritingHeatmapFiles([]); });

    fetchJSON('/api/activity-heatmap?days=180')
      .then(d => setHeatmap(d.days || {}))
      .catch(() => { if (!signal.aborted) setHeatmap(null); });

    fetchJSON('/api/analytics')
      .then((d) => { setData(d); setLoading(false); })
      .catch((err) => { if (!signal.aborted) { setError(err.message); setLoading(false); } });

    fetchJSON('/api/streak?userId=default')
      .then(d => setStreak(d))
      .catch(() => { if (!signal.aborted) setStreak(null); });

    fetchJSON('/api/files/recent?limit=8&includeStats=true')
      .then(d => setRecentFiles(d.files || []))
      .catch(() => { if (!signal.aborted) setRecentFiles([]); });

    fetchJSON('/api/analytics/topics')
      .then((d) => setTopics(d.topics || []))
      .catch(() => { if (!signal.aborted) setTopics([]); });

    fetchJSON('/api/stats')
      .then((d) => setStats(d))
      .catch(() => { if (!signal.aborted) setStats(null); });

    fetchJSON('/api/analytics/duplicates')
      .then((d) => setDuplicates(d.duplicates || []))
      .catch(() => { if (!signal.aborted) setDuplicates([]); });

    fetchJSON('/api/analytics/orphans')
      .then((d) => setOrphans(d.orphans || []))
      .catch(() => { if (!signal.aborted) setOrphans([]); });

    return () => controller.abort();
  }, []);

  if (loading) {
    return (
      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '1.5rem 1rem' }}>
        <LoadingSkeleton shape="text" width="220px" height={32} style={{ marginBottom: '1.5rem' }} />
        <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={cardStyle}>
              <LoadingSkeleton shape="text" width="60%" height={32} style={{ margin: '0 auto 8px' }} />
              <LoadingSkeleton shape="text" width="80%" height={14} style={{ margin: '0 auto' }} />
            </div>
          ))}
        </div>
        <LoadingSkeleton shape="block" width="100%" height={180} style={{ marginBottom: '2rem' }} />
        <LoadingSkeleton shape="block" width="100%" height={120} />
      </div>
    );
  }

  if (error) {
    return (
      <p style={{ textAlign: 'center', padding: '2rem', color: '#e74c3c' }}>
        Failed to load analytics: {error}
      </p>
    );
  }

  const { pageviews = {}, recent = [] } = data || {};

  // Sort pages by count descending
  const sorted = Object.entries(pageviews).sort((a, b) => b[1] - a[1]);
  const totalViews = sorted.reduce((sum, [, count]) => sum + count, 0);
  const top20 = sorted.slice(0, 20);
  const maxCount = top20.length > 0 ? top20[0][1] : 1;

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', padding: '1.5rem 1rem' }}>
      <h1>Analytics Dashboard</h1>

      <div
        style={{
          display: 'flex',
          gap: '1.5rem',
          marginBottom: '2rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={cardStyle}>
          <div style={{ fontSize: '2rem', fontWeight: 700 }}>{totalViews}</div>
          <div style={{ color: '#888', fontSize: '0.9rem' }}>Total Pageviews</div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: '2rem', fontWeight: 700 }}>{sorted.length}</div>
          <div style={{ color: '#888', fontSize: '0.9rem' }}>Unique Pages</div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: '2rem', fontWeight: 700 }}>{recent.length}</div>
          <div style={{ color: '#888', fontSize: '0.9rem' }}>Recent Events</div>
        </div>
      </div>

      {/* --- Pageviews Over Time (last 14 days) --- */}
      {(() => {
        // Build a map of date-string -> count from recent entries
        const dayCounts = {};
        recent.forEach((entry) => {
          const d = new Date(entry.timestamp);
          if (!isNaN(d)) {
            const key = d.toISOString().slice(0, 10); // "YYYY-MM-DD"
            dayCounts[key] = (dayCounts[key] || 0) + 1;
          }
        });

        // Generate last 14 days (including today)
        const days = [];
        const now = new Date();
        for (let i = 13; i >= 0; i--) {
          const d = new Date(now);
          d.setDate(d.getDate() - i);
          const key = d.toISOString().slice(0, 10);
          days.push({ key, count: dayCounts[key] || 0 });
        }

        const dayMax = Math.max(...days.map((d) => d.count), 1);

        return (
          <div style={{ marginBottom: '2rem' }}>
            <h2>Pageviews Over Time</h2>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: '4px',
                height: '180px',
                padding: '0.5rem 0',
                borderBottom: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
              }}
            >
              {days.map(({ key, count }) => {
                const heightPct = (count / dayMax) * 100;
                return (
                  <div
                    key={key}
                    style={{
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      height: '100%',
                      position: 'relative',
                    }}
                    title={`${key}: ${count} view${count !== 1 ? 's' : ''}`}
                  >
                    {count > 0 && (
                      <span
                        style={{
                          fontSize: '0.65rem',
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
                        maxWidth: '40px',
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
                gap: '4px',
                marginTop: '4px',
              }}
            >
              {days.map(({ key }) => (
                <div
                  key={key}
                  style={{
                    flex: 1,
                    textAlign: 'center',
                    fontSize: '0.6rem',
                    color: '#888',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {key.slice(5)}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* --- Most Active Hours (0-23) --- */}
      {(() => {
        const hourCounts = new Array(24).fill(0);
        recent.forEach((entry) => {
          const d = new Date(entry.timestamp);
          if (!isNaN(d)) {
            hourCounts[d.getHours()] += 1;
          }
        });

        const hourMax = Math.max(...hourCounts, 1);

        return (
          <div style={{ marginBottom: '2rem' }}>
            <h2>Most Active Hours</h2>
            <div>
              {hourCounts.map((count, hour) => {
                const pct = (count / hourMax) * 100;
                const hourLabel = `${hour.toString().padStart(2, '0')}:00`;
                return (
                  <div
                    key={hour}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      marginBottom: '3px',
                    }}
                    title={`${hourLabel} — ${count} view${count !== 1 ? 's' : ''}`}
                  >
                    <span
                      style={{
                        width: '48px',
                        fontSize: '0.75rem',
                        color: '#888',
                        textAlign: 'right',
                        marginRight: '8px',
                        flexShrink: 0,
                      }}
                    >
                      {hourLabel}
                    </span>
                    <div
                      style={{
                        flex: 1,
                        height: '14px',
                        background: 'var(--ifm-color-emphasis-200, #e0e0e0)',
                        borderRadius: '3px',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: count > 0 ? `${Math.max(pct, 2)}%` : '0%',
                          background: 'var(--ifm-color-primary, #2568c2)',
                          borderRadius: '3px',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                    <span
                      style={{
                        width: '36px',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        textAlign: 'right',
                        marginLeft: '8px',
                        flexShrink: 0,
                      }}
                    >
                      {count}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      <h2>Top Pages</h2>
      {top20.length === 0 ? (
        <p style={{ color: '#888' }}>No pageview data yet.</p>
      ) : (
        <div style={{ marginBottom: '2rem' }}>
          {top20.map(([pagePath, count]) => {
            const pct = (count / maxCount) * 100;
            return (
              <div key={pagePath} style={{ marginBottom: '0.5rem' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '0.85rem',
                    marginBottom: '2px',
                  }}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '75%',
                    }}
                    title={pagePath}
                  >
                    {pagePath}
                  </span>
                  <span style={{ fontWeight: 600, flexShrink: 0 }}>{count}</span>
                </div>
                <div
                  style={{
                    height: '8px',
                    borderRadius: '4px',
                    background: 'var(--ifm-color-emphasis-200, #e0e0e0)',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${pct}%`,
                      borderRadius: '4px',
                      background: 'var(--ifm-color-primary, #2568c2)',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h2>All Pages by Views</h2>
      {sorted.length === 0 ? (
        <p style={{ color: '#888' }}>No data yet.</p>
      ) : (
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '400px' }}>
          <thead>
            <tr>
              <th style={thStyle}>Page</th>
              <th style={{ ...thStyle, textAlign: 'right', width: '100px' }}>Views</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(([pagePath, count]) => (
              <tr key={pagePath}>
                <td style={tdStyle}>{pagePath}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <h2 style={{ marginTop: '2rem' }}>Recent Activity</h2>
      {recent.length === 0 ? (
        <p style={{ color: '#888' }}>No recent activity.</p>
      ) : (
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '400px' }}>
          <thead>
            <tr>
              <th style={thStyle}>Page</th>
              <th style={{ ...thStyle, width: '200px' }}>Time</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((entry, i) => (
              <tr key={i}>
                <td style={tdStyle}>{entry.path}</td>
                <td style={tdStyle}>{new Date(entry.timestamp).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {/* --- Content Insights --- */}
      <h2 style={{ marginTop: '2rem' }}>Content Insights</h2>

      {/* Word Cloud */}
      {(() => {
        if (!topics || topics.length === 0) {
          return <p style={{ color: '#888' }}>No topic data available.</p>;
        }

        const top30 = topics.slice(0, 30);
        const counts = top30.map((t) => t.count);
        const minCount = Math.min(...counts);
        const maxCountT = Math.max(...counts);
        const range = maxCountT - minCount || 1;

        const hues = [210, 340, 150, 30, 270, 180, 0, 60, 300, 120];

        return (
          <div style={{ marginBottom: '2rem' }}>
            <h3>Keyword Cloud</h3>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px 12px',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1rem',
                borderRadius: '8px',
                background: 'var(--ifm-card-background-color, #fff)',
                border: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
              }}
            >
              {top30.map((t, i) => {
                const ratio = (t.count - minCount) / range;
                const fontSize = 0.7 + ratio * 1.3;
                const hue = hues[i % hues.length];
                const lightness = 35 + (1 - ratio) * 20;
                return (
                  <span
                    key={t.word}
                    title={`${t.word}: ${t.count} occurrences`}
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
              })}
            </div>
          </div>
        );
      })()}

      {/* Content Breakdown Pie Chart */}
      {(() => {
        if (!stats || !stats.byDirectory) {
          return null;
        }

        const sections = Object.entries(stats.byDirectory)
          .map(([name, { words }]) => ({ name, words }))
          .filter((s) => s.words > 0)
          .sort((a, b) => b.words - a.words);

        if (sections.length === 0) return null;

        const totalWords = sections.reduce((sum, s) => sum + s.words, 0);
        const pieHues = [210, 340, 150, 30, 270, 60, 0, 180, 300, 120];
        let cumPct = 0;
        const gradientStops = sections.map((s, i) => {
          const pct = (s.words / totalWords) * 100;
          const start = cumPct;
          cumPct += pct;
          return `hsl(${pieHues[i % pieHues.length]}, 60%, 50%) ${start}% ${cumPct}%`;
        });

        return (
          <div style={{ marginBottom: '2rem' }}>
            <h3>Words by Section</h3>
            <div
              style={{
                display: 'flex',
                gap: '2rem',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <div
                style={{
                  width: '180px',
                  height: '180px',
                  borderRadius: '50%',
                  background: `conic-gradient(${gradientStops.join(', ')})`,
                  flexShrink: 0,
                }}
                title="Words per section"
              />
              <div style={{ flex: 1, minWidth: '200px' }}>
                {sections.map((s, i) => {
                  const pct = ((s.words / totalWords) * 100).toFixed(1);
                  return (
                    <div
                      key={s.name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        marginBottom: '6px',
                        fontSize: '0.9rem',
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-block',
                          width: '12px',
                          height: '12px',
                          borderRadius: '3px',
                          background: `hsl(${pieHues[i % pieHues.length]}, 60%, 50%)`,
                          marginRight: '8px',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontWeight: 600, marginRight: '6px' }}>{s.name}</span>
                      <span style={{ color: '#888' }}>
                        {s.words.toLocaleString()} words ({pct}%)
                      </span>
                    </div>
                  );
                })}
                <div
                  style={{
                    marginTop: '12px',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: 'var(--ifm-color-emphasis-100, #f5f5f5)',
                    fontSize: '0.85rem',
                    color: '#555',
                  }}
                >
                  <strong>{stats.totalWords?.toLocaleString() || totalWords.toLocaleString()}</strong> total words across{' '}
                  <strong>{stats.totalFiles || sections.reduce((s2, sec) => s2 + (stats.byDirectory[sec.name]?.files || 0), 0)}</strong> files
                  {stats.references > 0 && (
                    <span> with <strong>{stats.references}</strong> references</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* --- Writing Streak --- */}
      {streak && (
        <div style={{marginTop: '2rem'}}>
          <h2>Writing Streak</h2>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.75rem', marginBottom: '1rem'}}>
            <div style={{textAlign: 'center', padding: '16px', borderRadius: 8, border: '1px solid var(--ifm-color-emphasis-200)'}}>
              <div style={{fontSize: '2rem', fontWeight: 700, color: 'var(--ifm-color-primary)'}}>{streak.currentStreak}</div>
              <div style={{fontSize: '0.8rem', color: 'var(--ifm-color-emphasis-600)'}}>Current Streak</div>
            </div>
            <div style={{textAlign: 'center', padding: '16px', borderRadius: 8, border: '1px solid var(--ifm-color-emphasis-200)'}}>
              <div style={{fontSize: '2rem', fontWeight: 700, color: 'var(--ifm-color-emphasis-700)'}}>{streak.longestStreak}</div>
              <div style={{fontSize: '0.8rem', color: 'var(--ifm-color-emphasis-600)'}}>Longest Streak</div>
            </div>
            <div style={{textAlign: 'center', padding: '16px', borderRadius: 8, border: '1px solid var(--ifm-color-emphasis-200)'}}>
              <div style={{fontSize: '2rem', fontWeight: 700, color: 'var(--ifm-color-emphasis-700)'}}>{(streak.totalWords || 0).toLocaleString()}</div>
              <div style={{fontSize: '0.8rem', color: 'var(--ifm-color-emphasis-600)'}}>Total Words</div>
            </div>
          </div>
          {streak.dailyLog && streak.dailyLog.length > 0 && (() => {
            const recent30 = streak.dailyLog.slice(-30);
            const streakMax = Math.max(...recent30.map(e => e.words), 1);
            return (
              <div style={{
                display: 'flex', gap: 2, alignItems: 'flex-end', height: 60,
                padding: '8px 0', borderBottom: '1px solid var(--ifm-color-emphasis-200)',
              }}>
                {recent30.map((entry, i) => {
                  const height = Math.max(2, (entry.words / streakMax) * 50);
                  return (
                    <div
                      key={i}
                      title={`${entry.date}: ${entry.words} words`}
                      style={{
                        flex: 1, height,
                        background: entry.words >= 50 ? 'var(--ifm-color-primary)' : 'var(--ifm-color-emphasis-300)',
                        borderRadius: 2, minWidth: 3,
                      }}
                    />
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {/* --- Activity Heatmap --- */}
      {heatmap && Object.keys(heatmap).length > 0 && (() => {
        const maxVal = Math.max(...Object.values(heatmap), 1);
        const weeks = buildHeatmapWeeks(heatmap, { days: 180, today: new Date() });
        return (
          <div style={{marginTop: '2rem'}}>
            <h2>Activity Heatmap</h2>
            <div style={{display: 'flex', gap: 2, overflow: 'auto', padding: '4px 0'}}>
              {weeks.map((w, wi) => (
                <div key={wi} style={{display: 'flex', flexDirection: 'column', gap: 2}}>
                  {w.map((cell, di) => (
                    <div
                      key={di}
                      title={cell ? `${cell.key}: ${cell.count} actions` : ''}
                      style={{
                        width: 12, height: 12, borderRadius: 2,
                        background: cell
                          ? (cell.count > 0 ? `rgba(34, 197, 94, ${Math.max(0.15, Math.min(1, cell.count / maxVal))})` : 'var(--ifm-color-emphasis-200)')
                          : 'transparent',
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
            <div style={{fontSize: '0.75rem', color: 'var(--ifm-color-emphasis-500)', marginTop: 4}}>
              Less <span style={{display: 'inline-flex', gap: 2, margin: '0 4px', verticalAlign: 'middle'}}>
                {[0, 0.2, 0.4, 0.7, 1].map((v, i) => (
                  <span key={i} style={{width: 10, height: 10, borderRadius: 2, display: 'inline-block',
                    background: v === 0 ? 'var(--ifm-color-emphasis-200)' : `rgba(34, 197, 94, ${v})`}} />
                ))}
              </span> More
            </div>
          </div>
        );
      })()}

      {/* --- Recently Modified --- */}
      {recentFiles && recentFiles.length > 0 && (
        <div style={{marginTop: '2rem'}}>
          <h2>Recently Modified</h2>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '0.75rem'}}>
            {recentFiles.map(f => (
              <div key={f.path} style={{
                padding: '12px 16px', borderRadius: 8,
                border: '1px solid var(--ifm-color-emphasis-200)',
                background: 'var(--ifm-background-color)',
              }}>
                <div style={{fontWeight: 600, fontSize: '0.9rem', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                  {f.title || f.name.replace(/\.(md|mdx)$/, '')}
                </div>
                <div style={{fontSize: '0.78rem', color: 'var(--ifm-color-emphasis-500)', display: 'flex', gap: 12}}>
                  <span>{f.path.replace(/^content\//, '').replace(/\/[^/]+$/, '')}</span>
                  {f.wordCount && <span>{f.wordCount} words</span>}
                  {f.readingTimeMin && <span>{f.readingTimeMin} min read</span>}
                  <span>{new Date(f.mtime).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* --- Content Health --- */}
      <h2 style={{ marginTop: '2rem' }}>Content Health</h2>

      {/* Potential Duplicates */}
      <div style={{ marginBottom: '1.5rem' }}>
        <button
          onClick={() => setShowDuplicates((v) => !v)}
          style={{
            background: 'none',
            border: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
            borderRadius: '6px',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontSize: '0.95rem',
            fontWeight: 600,
            width: '100%',
            textAlign: 'left',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            color: 'var(--ifm-font-color-base, inherit)',
          }}
        >
          <span>Potential Duplicates {duplicates && `(${duplicates.length})`}</span>
          <span style={{ fontSize: '0.8rem', color: '#888' }}>{showDuplicates ? '▲ Collapse' : '▼ Expand'}</span>
        </button>
        {showDuplicates && (
          <div style={{ marginTop: '0.75rem' }}>
            {!duplicates ? (
              <p style={{ color: '#888', fontSize: '0.9rem' }}>Loading...</p>
            ) : duplicates.length === 0 ? (
              <p style={{ color: '#888', fontSize: '0.9rem' }}>No potential duplicates found.</p>
            ) : (
              <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '500px' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>File A</th>
                      <th style={thStyle}>File B</th>
                      <th style={{ ...thStyle, textAlign: 'right', width: '120px' }}>Similarity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {duplicates.map((d, i) => (
                      <tr key={i}>
                        <td style={tdStyle}>{d.fileA}</td>
                        <td style={tdStyle}>{d.fileB}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                          <span
                            style={{
                              color: d.similarity >= 0.8 ? '#e74c3c' : d.similarity >= 0.6 ? '#e67e22' : '#888',
                            }}
                          >
                            {(d.similarity * 100).toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Orphan Pages */}
      <div style={{ marginBottom: '2rem' }}>
        <button
          onClick={() => setShowOrphans((v) => !v)}
          style={{
            background: 'none',
            border: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
            borderRadius: '6px',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontSize: '0.95rem',
            fontWeight: 600,
            width: '100%',
            textAlign: 'left',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            color: 'var(--ifm-font-color-base, inherit)',
          }}
        >
          <span>Orphan Pages {orphans && `(${orphans.length})`}</span>
          <span style={{ fontSize: '0.8rem', color: '#888' }}>{showOrphans ? '▲ Collapse' : '▼ Expand'}</span>
        </button>
        {showOrphans && (
          <div style={{ marginTop: '0.75rem' }}>
            {!orphans ? (
              <p style={{ color: '#888', fontSize: '0.9rem' }}>Loading...</p>
            ) : orphans.length === 0 ? (
              <p style={{ color: '#888', fontSize: '0.9rem' }}>No orphan pages found. All pages are linked from at least one other page.</p>
            ) : (
              <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '400px' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Page</th>
                      <th style={{ ...thStyle, textAlign: 'right', width: '120px' }}>Word Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orphans.map((o, i) => (
                      <tr key={i}>
                        <td style={tdStyle}>{o.file}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                          {(o.words || 0).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* --- Writing Activity Heatmap --- */}
      {writingHeatmapFiles && writingHeatmapFiles.length > 0 && (() => {
        // Group files by mtime date
        const dateCounts = {};
        writingHeatmapFiles.forEach(f => {
          if (f.mtime) {
            const key = new Date(f.mtime).toISOString().slice(0, 10);
            dateCounts[key] = (dateCounts[key] || 0) + 1;
          }
        });

        // Build 12 weeks (84 days) ending today, padding the final partial
        // week so every column has 7 rows (Sun=0 ... Sat=6).
        const maxVal = Math.max(...Object.values(dateCounts), 1);
        const weeks = buildHeatmapWeeks(dateCounts, { days: 12 * 7, today: new Date(), trailingPad: true });

        // Green color scale (GitHub-style)
        const getColor = (count) => {
          if (count === 0) return 'var(--ifm-color-emphasis-200, #ebedf0)';
          const ratio = count / maxVal;
          if (ratio <= 0.25) return '#9be9a8';
          if (ratio <= 0.5) return '#40c463';
          if (ratio <= 0.75) return '#30a14e';
          return '#216e39';
        };

        const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        return (
          <div style={{ marginTop: '2rem' }}>
            <h2>Writing Activity</h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--ifm-color-emphasis-600)', marginBottom: '0.75rem' }}>
              File modifications over the last 12 weeks
            </p>
            <div style={{ display: 'flex', gap: 0, overflow: 'auto', padding: '4px 0' }}>
              {/* Day-of-week labels */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 4, paddingTop: 0 }}>
                {dayLabels.map((label, i) => (
                  <div
                    key={i}
                    style={{
                      width: 28,
                      height: 12,
                      fontSize: '0.6rem',
                      color: 'var(--ifm-color-emphasis-500)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      paddingRight: 4,
                      visibility: (i === 1 || i === 3 || i === 5) ? 'visible' : 'hidden',
                    }}
                  >
                    {label}
                  </div>
                ))}
              </div>
              {/* Grid of weeks */}
              {weeks.map((w, wi) => (
                <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {w.map((cell, di) => (
                    <div
                      key={di}
                      title={cell ? `${cell.count} file${cell.count !== 1 ? 's' : ''} modified on ${cell.key}` : ''}
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 2,
                        background: cell ? getColor(cell.count) : 'transparent',
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
            {/* Legend */}
            <div style={{ fontSize: '0.75rem', color: 'var(--ifm-color-emphasis-500)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
              Less
              <span style={{ display: 'inline-flex', gap: 2 }}>
                {['var(--ifm-color-emphasis-200, #ebedf0)', '#9be9a8', '#40c463', '#30a14e', '#216e39'].map((bg, i) => (
                  <span
                    key={i}
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      display: 'inline-block',
                      background: bg,
                    }}
                  />
                ))}
              </span>
              More
            </div>
          </div>
        );
      })()}
    </div>
  );
}

const cardStyle = {
  flex: '1 1 150px',
  padding: '1.25rem',
  borderRadius: '8px',
  background: 'var(--ifm-card-background-color, #fff)',
  border: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
  textAlign: 'center',
};

const thStyle = {
  textAlign: 'left',
  padding: '0.5rem 0.75rem',
  borderBottom: '2px solid var(--ifm-color-emphasis-300, #ccc)',
  fontSize: '0.85rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#888',
};

const tdStyle = {
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
  fontSize: '0.9rem',
};

export default function AnalyticsPage() {
  return (
    <Layout title="Analytics" description="Site analytics dashboard">
      <BrowserOnly>{() => <ErrorBoundary><AnalyticsDashboard /></ErrorBoundary>}</BrowserOnly>
    </Layout>
  );
}
