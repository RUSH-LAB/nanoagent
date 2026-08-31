import React, {useState, useEffect} from 'react';
import API_BASE, { apiFetch } from '@site/src/utils/api';
import { contentPathToUrl } from '@site/src/utils/paths';

const styles = {
  container: {
    marginTop: '2rem',
    padding: '1rem 1.5rem',
    borderTop: '1px solid var(--ifm-toc-border-color, #e3e3e3)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    cursor: 'pointer',
    userSelect: 'none',
    gap: '0.5rem',
    fontSize: '0.9rem',
    fontWeight: 600,
    color: 'var(--ifm-color-emphasis-700, #555)',
    marginBottom: '0.5rem',
  },
  arrow: {
    display: 'inline-block',
    transition: 'transform 0.2s',
    fontSize: '0.7rem',
  },
  count: {
    fontSize: '0.75rem',
    fontWeight: 400,
    color: 'var(--ifm-color-emphasis-500, #999)',
    marginLeft: '0.25rem',
  },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  item: {
    padding: '0.4rem 0',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.85rem',
  },
  link: {
    color: 'var(--ifm-link-color)',
    textDecoration: 'none',
  },
  badge: {
    fontSize: '0.65rem',
    padding: '0.1rem 0.4rem',
    borderRadius: '3px',
    background: 'var(--ifm-color-emphasis-200, #eee)',
    color: 'var(--ifm-color-emphasis-600, #666)',
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    flexShrink: 0,
  },
  empty: {
    fontSize: '0.8rem',
    color: 'var(--ifm-color-emphasis-500, #999)',
    fontStyle: 'italic',
  },
};

export default function Backlinks({filePath}) {
  const [backlinks, setBacklinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!filePath) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function fetchBacklinks() {
      try {
        const resp = await apiFetch(
          `${API_BASE}/api/backlinks?path=${encodeURIComponent(filePath)}`
        );
        if (!resp.ok) throw new Error('Failed');
        const data = await resp.json();
        if (!cancelled) setBacklinks(data.backlinks || []);
      } catch {
        // Editor server may not be running; silently fail
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchBacklinks();
    return () => { cancelled = true; };
  }, [filePath]);

  if (loading || backlinks.length === 0) return null;

  return (
    <div style={styles.container}>
      <div
        style={styles.header}
        onClick={() => setCollapsed(c => !c)}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setCollapsed(c => !c); }}
      >
        <span style={{...styles.arrow, transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)'}}>
          &#9660;
        </span>
        Backlinks
        <span style={styles.count}>({backlinks.length})</span>
      </div>
      {!collapsed && (
        <ul style={styles.list}>
          {backlinks.map((bl, i) => (
            <li key={`${bl.sourcePath}-${bl.linkType}-${i}`} style={styles.item}>
              <a href={contentPathToUrl(bl.sourcePath)} style={styles.link}>
                {bl.sourceTitle}
              </a>
              <span style={styles.badge}>{bl.linkType}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
