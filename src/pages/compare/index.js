import React, { useEffect, useState, useMemo } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import API_BASE from '@site/src/utils/api';

function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function diffLines(linesA, linesB) {
  // Simple line-by-line comparison producing a side-by-side diff view
  // Uses a basic LCS approach for small files, falls back to line-by-line for large ones
  const result = [];
  const maxLen = Math.max(linesA.length, linesB.length);

  if (maxLen > 5000) {
    // For very large files, do simple line-by-line
    for (let i = 0; i < maxLen; i++) {
      const a = i < linesA.length ? linesA[i] : undefined;
      const b = i < linesB.length ? linesB[i] : undefined;
      if (a === b) {
        result.push({ type: 'equal', left: a, right: b });
      } else {
        result.push({
          type: 'changed',
          left: a !== undefined ? a : null,
          right: b !== undefined ? b : null,
        });
      }
    }
    return result;
  }

  // Build a simple diff using the longest common subsequence
  const n = linesA.length;
  const m = linesB.length;

  // LCS length table; the 5000-line cap above bounds dp values, so a typed array keeps it compact.
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (linesA[i - 1] === linesB[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      ops.push({ type: 'equal', left: linesA[i - 1], right: linesB[j - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'added', left: null, right: linesB[j - 1] });
      j--;
    } else {
      ops.push({ type: 'removed', left: linesA[i - 1], right: null });
      i--;
    }
  }
  ops.reverse();
  return ops;
}

function flattenTree(nodes, result = []) {
  for (const node of nodes) {
    if (node.type === 'file') {
      result.push(node.path);
    } else if (node.children) {
      flattenTree(node.children, result);
    }
  }
  return result;
}

function CompareView() {
  const [files, setFiles] = useState([]);
  const [leftPath, setLeftPath] = useState('');
  const [rightPath, setRightPath] = useState('');
  const [leftContent, setLeftContent] = useState(null);
  const [rightContent, setRightContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch file list on mount
  useEffect(() => {
    fetch(`${API_BASE}/api/files`)
      .then((r) => r.json())
      .then((d) => {
        const flat = flattenTree(d.files || []).sort();
        setFiles(flat);
      })
      .catch((err) => setError('Failed to load file list: ' + err.message));
  }, []);

  // Fetch contents when both files are selected
  useEffect(() => {
    if (!leftPath || !rightPath) {
      setLeftContent(null);
      setRightContent(null);
      return;
    }
    setLoading(true);
    setError(null);

    Promise.all([
      fetch(`${API_BASE}/api/file?path=${encodeURIComponent(leftPath)}`).then((r) => r.json()),
      fetch(`${API_BASE}/api/file?path=${encodeURIComponent(rightPath)}`).then((r) => r.json()),
    ])
      .then(([left, right]) => {
        if (left.error) throw new Error(`Left file: ${left.error}`);
        if (right.error) throw new Error(`Right file: ${right.error}`);
        setLeftContent(left.content);
        setRightContent(right.content);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [leftPath, rightPath]);

  const diff = useMemo(() => {
    if (leftContent === null || rightContent === null) return null;
    const linesA = leftContent.split('\n');
    const linesB = rightContent.split('\n');
    return diffLines(linesA, linesB);
  }, [leftContent, rightContent]);

  const stats = useMemo(() => {
    if (leftContent === null || rightContent === null) return null;
    const leftWords = wordCount(leftContent);
    const rightWords = wordCount(rightContent);
    const added = diff ? diff.filter((d) => d.type === 'added').length : 0;
    const removed = diff ? diff.filter((d) => d.type === 'removed').length : 0;
    return { leftWords, rightWords, wordDiff: rightWords - leftWords, added, removed };
  }, [leftContent, rightContent, diff]);

  const selectStyle = {
    flex: 1,
    padding: '8px 12px',
    fontSize: '0.9rem',
    borderRadius: '6px',
    border: '1px solid var(--ifm-color-emphasis-300, #ccc)',
    background: 'var(--ifm-background-color, #fff)',
    color: 'var(--ifm-font-color-base, #1c1e21)',
    minWidth: 0,
  };

  const lineStyle = {
    padding: '1px 8px',
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    lineHeight: 1.5,
    minHeight: '1.5em',
  };

  return (
    <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '1.5rem 1rem' }}>
      <h1>Compare Documents</h1>

      {/* File selectors */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <select
          value={leftPath}
          onChange={(e) => setLeftPath(e.target.value)}
          aria-label="Select left file for comparison"
          style={selectStyle}
        >
          <option value="">-- Select left file --</option>
          {files.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
        <select
          value={rightPath}
          onChange={(e) => setRightPath(e.target.value)}
          aria-label="Select right file for comparison"
          style={selectStyle}
        >
          <option value="">-- Select right file --</option>
          {files.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </div>

      {error && (
        <p role="alert" style={{ color: '#e74c3c', padding: '0.5rem 0' }}>{error}</p>
      )}

      {loading && (
        <p style={{ color: '#888', padding: '1rem 0' }}>Loading file contents...</p>
      )}

      {/* Stats bar */}
      {stats && !loading && (
        <div
          role="region"
          aria-label="Comparison statistics"
          style={{
            display: 'flex',
            gap: '1.5rem',
            flexWrap: 'wrap',
            padding: '12px 16px',
            marginBottom: '1rem',
            borderRadius: '8px',
            background: 'var(--ifm-color-emphasis-100, #f5f5f5)',
            fontSize: '0.85rem',
          }}
        >
          <span>
            <strong>Left:</strong> {stats.leftWords.toLocaleString()} words
          </span>
          <span>
            <strong>Right:</strong> {stats.rightWords.toLocaleString()} words
          </span>
          <span style={{ color: stats.wordDiff > 0 ? '#27ae60' : stats.wordDiff < 0 ? '#e74c3c' : '#888' }}>
            <strong>Diff:</strong> {stats.wordDiff > 0 ? '+' : ''}{stats.wordDiff.toLocaleString()} words
          </span>
          <span style={{ color: '#27ae60' }}>+{stats.added} lines</span>
          <span style={{ color: '#e74c3c' }}>-{stats.removed} lines</span>
        </div>
      )}

      {/* Side-by-side diff */}
      {diff && !loading && (
        <div
          role="region"
          aria-label="Side-by-side file diff"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            border: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
            borderRadius: '8px',
            overflow: 'hidden',
          }}
        >
          {/* Headers */}
          <div
            style={{
              padding: '8px 12px',
              fontWeight: 600,
              fontSize: '0.85rem',
              background: 'var(--ifm-color-emphasis-100, #f5f5f5)',
              borderBottom: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
              borderRight: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={leftPath}
          >
            {leftPath}
          </div>
          <div
            style={{
              padding: '8px 12px',
              fontWeight: 600,
              fontSize: '0.85rem',
              background: 'var(--ifm-color-emphasis-100, #f5f5f5)',
              borderBottom: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={rightPath}
          >
            {rightPath}
          </div>

          {/* Diff lines */}
          {diff.map((entry, idx) => {
            let leftBg = 'transparent';
            let rightBg = 'transparent';
            let leftText = entry.left ?? '';
            let rightText = entry.right ?? '';

            if (entry.type === 'removed') {
              leftBg = 'rgba(231, 76, 60, 0.12)';
            } else if (entry.type === 'added') {
              rightBg = 'rgba(39, 174, 96, 0.12)';
            } else if (entry.type === 'changed') {
              leftBg = entry.left !== null ? 'rgba(231, 76, 60, 0.12)' : 'transparent';
              rightBg = entry.right !== null ? 'rgba(39, 174, 96, 0.12)' : 'transparent';
            }

            return (
              <React.Fragment key={idx}>
                <div
                  style={{
                    ...lineStyle,
                    background: leftBg,
                    borderRight: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
                    borderBottom: '1px solid var(--ifm-color-emphasis-100, #f0f0f0)',
                    color: entry.type === 'removed' || (entry.type === 'changed' && entry.left !== null)
                      ? '#c0392b'
                      : 'inherit',
                  }}
                >
                  {leftText || ' '}
                </div>
                <div
                  style={{
                    ...lineStyle,
                    background: rightBg,
                    borderBottom: '1px solid var(--ifm-color-emphasis-100, #f0f0f0)',
                    color: entry.type === 'added' || (entry.type === 'changed' && entry.right !== null)
                      ? '#1e8449'
                      : 'inherit',
                  }}
                >
                  {rightText || ' '}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {!leftPath && !rightPath && !loading && (
        <p style={{ color: '#888', textAlign: 'center', padding: '3rem 0' }}>
          Select two files above to compare them side by side.
        </p>
      )}
    </div>
  );
}

export default function ComparePage() {
  return (
    <Layout title="Compare Documents" description="Compare two documents side by side">
      <BrowserOnly fallback={<div style={{ padding: 40, textAlign: 'center' }}>Loading...</div>}>
        {() => <ErrorBoundary><CompareView /></ErrorBoundary>}
      </BrowserOnly>
    </Layout>
  );
}
