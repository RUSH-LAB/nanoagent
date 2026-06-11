import React, {useState, useEffect} from 'react';
import styles from './RecentFiles.module.css';

export default function RecentFiles({onSelectFile, selectedFile}) {
  const [collapsed, setCollapsed] = useState(false);
  const [recentFiles, setRecentFiles] = useState([]);

  useEffect(() => {
    function load() {
      try {
        const raw = localStorage.getItem('mochi-recent-files');
        if (!raw) return;
        const paths = JSON.parse(raw);
        if (!Array.isArray(paths)) return;
        // Stored as an access-ordered list of paths (first = most recent)
        setRecentFiles(paths.slice(0, 5));
      } catch {}
    }
    load();
    // Re-read when storage changes (e.g. from handleSelectFile in parent)
    const handler = () => load();
    window.addEventListener('storage', handler);
    // Also poll on focus to catch same-tab updates
    window.addEventListener('focus', handler);
    // Listen for custom event from parent
    window.addEventListener('mochi-recent-updated', handler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener('focus', handler);
      window.removeEventListener('mochi-recent-updated', handler);
    };
  }, []);

  // Re-read whenever selectedFile changes (means a file was just opened)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('mochi-recent-files');
      if (!raw) return;
      const paths = JSON.parse(raw);
      if (Array.isArray(paths)) setRecentFiles(paths.slice(0, 5));
    } catch {}
  }, [selectedFile]);

  if (recentFiles.length === 0) return null;

  const fileName = (path) => {
    const parts = path.split('/');
    const name = parts.pop();
    // If it's index.md/index.mdx, show parent folder name too
    if (/^index\.(md|mdx)$/.test(name) && parts.length > 0) {
      return `${parts.pop()}/${name}`;
    }
    return name;
  };

  return (
    <div className={styles.recentSection}>
      <button
        className={styles.recentHeader}
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? 'Expand recent files' : 'Collapse recent files'}
      >
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={collapsed ? styles.chevronCollapsed : styles.chevronExpanded}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span>Recent</span>
      </button>
      {!collapsed && (
        <div className={styles.recentList}>
          {recentFiles.map((path) => (
            <button
              key={path}
              className={`${styles.recentItem} ${path === selectedFile ? styles.recentItemActive : ''}`}
              onClick={() => onSelectFile(path)}
              title={path}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className={styles.recentIcon}>
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span className={styles.recentName}>{fileName(path)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
