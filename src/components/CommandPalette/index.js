import React, {useState, useEffect, useRef, useMemo, useCallback} from 'react';
import {fuzzyMatch} from '@site/src/utils/fuzzyMatch';
import styles from './styles.module.css';

/* ── SVG icons (inline to avoid any external dependency) ────────── */
const icons = {
  navigate: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  ),
  editor: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
  book: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  chat: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  star: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  chart: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  ),
  shield: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  graph: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  ),
  plus: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  search: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  download: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  keyboard: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
      <line x1="6" y1="8" x2="6" y2="8" />
      <line x1="10" y1="8" x2="10" y2="8" />
      <line x1="14" y1="8" x2="14" y2="8" />
      <line x1="18" y1="8" x2="18" y2="8" />
      <line x1="6" y1="12" x2="6" y2="12" />
      <line x1="10" y1="12" x2="10" y2="12" />
      <line x1="14" y1="12" x2="14" y2="12" />
      <line x1="18" y1="12" x2="18" y2="12" />
      <line x1="8" y1="16" x2="16" y2="16" />
    </svg>
  ),
  info: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  ),
};

/* ── Command definitions ───────────────────────────────────────── */
const COMMANDS = [
  // Navigate
  {id: 'nav-editor', category: 'Navigate', icon: icons.editor, title: 'Go to Editor', description: 'Open the markdown editor', action: () => { window.location.href = '/editor'; }},
  {id: 'nav-bibliography', category: 'Navigate', icon: icons.book, title: 'Go to Bibliography', description: 'Browse your references', action: () => { window.location.href = '/bibliography'; }},
  {id: 'nav-discussions', category: 'Navigate', icon: icons.chat, title: 'Go to Discussions', description: 'View discussions', action: () => { window.location.href = '/discussions'; }},
  {id: 'nav-recommendations', category: 'Navigate', icon: icons.star, title: 'Go to Recommendations', description: 'Paper recommendations', action: () => { window.location.href = '/recommendations'; }},
  {id: 'nav-analytics', category: 'Navigate', icon: icons.chart, title: 'Go to Analytics', description: 'View site analytics', action: () => { window.location.href = '/analytics'; }},
  {id: 'nav-admin', category: 'Navigate', icon: icons.shield, title: 'Go to Admin', description: 'Administration panel', action: () => { window.location.href = '/admin'; }},
  {id: 'nav-graph', category: 'Navigate', icon: icons.graph, title: 'Go to Graph', description: 'Citation graph visualization', action: () => { window.location.href = '/graph'; }},
  {id: 'nav-home', category: 'Navigate', icon: icons.navigate, title: 'Go to Home', description: 'Return to the home page', action: () => { window.location.href = '/'; }},

  // Actions
  {id: 'act-new-file', category: 'Actions', icon: icons.plus, title: 'Create new file', description: 'Open the editor with a new file', action: () => { window.location.href = '/editor'; }},
  {id: 'act-search', category: 'Actions', icon: icons.search, title: 'Search files', description: 'Search through your documents', action: () => { window.location.href = '/editor'; }},
  {id: 'act-export-bib', category: 'Actions', icon: icons.download, title: 'Export bibliography', description: 'Download bibliography as BibTeX', action: () => { window.location.href = '/bibliography'; }},

  // Help
  {id: 'help-shortcuts', category: 'Help', icon: icons.keyboard, title: 'Keyboard shortcuts', description: 'View available keyboard shortcuts', action: () => { /* shown inline */ }},
  {id: 'help-about', category: 'Help', icon: icons.info, title: 'About Mochi Lab', description: 'Learn more about this project', action: () => { window.location.href = '/'; }},
];

/* ── Component ─────────────────────────────────────────────────── */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  const resultsRef = useRef(null);

  /* Open / close via Cmd+K / Ctrl+K */
  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  /* Focus input when opened, reset state when closed */
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      // Defer focus to after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  /* Filtered results with fuzzy matching */
  const results = useMemo(() => {
    if (!query.trim()) return COMMANDS;
    return COMMANDS
      .map(cmd => ({
        ...cmd,
        ...fuzzyMatch(query, cmd.title + ' ' + cmd.description + ' ' + cmd.category),
      }))
      .filter(cmd => cmd.match)
      .sort((a, b) => b.score - a.score);
  }, [query]);

  /* Reset selection when query changes */
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  /* Scroll selected item into view */
  useEffect(() => {
    if (!resultsRef.current) return;
    const items = resultsRef.current.querySelectorAll('[data-cmd-item]');
    if (items[selectedIndex]) {
      items[selectedIndex].scrollIntoView({block: 'nearest'});
    }
  }, [selectedIndex]);

  const close = useCallback(() => setOpen(false), []);

  const executeCommand = useCallback((cmd) => {
    close();
    // Defer action so the palette closes first
    requestAnimationFrame(() => cmd.action());
  }, [close]);

  /* Keyboard navigation */
  const handleKeyDown = useCallback((e) => {
    // Count only actionable items (skip category headers)
    const itemCount = results.length;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, itemCount - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) {
        executeCommand(results[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      close();
    }
  }, [results, selectedIndex, executeCommand, close]);

  if (!open) return null;

  /* Group results by category for display */
  const grouped = [];
  let lastCategory = null;
  results.forEach((cmd, flatIndex) => {
    if (cmd.category !== lastCategory) {
      grouped.push({type: 'category', label: cmd.category, key: 'cat-' + cmd.category});
      lastCategory = cmd.category;
    }
    grouped.push({type: 'item', cmd, flatIndex, key: cmd.id});
  });

  return (
    <div className={styles.overlay} onClick={close}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        {/* Search input */}
        <div className={styles.inputRow}>
          <span className={styles.inputIcon}>{icons.search}</span>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            placeholder="Type a command..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          <span className={styles.inputHint}>esc</span>
        </div>

        {/* Results */}
        <div className={styles.results} ref={resultsRef}>
          {grouped.map(entry => {
            if (entry.type === 'category') {
              return (
                <div key={entry.key} className={styles.category}>
                  {entry.label}
                </div>
              );
            }

            const {cmd, flatIndex} = entry;
            const isActive = flatIndex === selectedIndex;

            return (
              <button
                key={cmd.id}
                data-cmd-item
                className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
                onClick={() => executeCommand(cmd)}
                onMouseEnter={() => setSelectedIndex(flatIndex)}
              >
                <span className={styles.itemIcon}>{cmd.icon}</span>
                <span className={styles.itemText}>
                  <span className={styles.itemTitle}>{cmd.title}</span>
                  <span className={styles.itemDescription}>{cmd.description}</span>
                </span>
              </button>
            );
          })}
          {results.length === 0 && (
            <div className={styles.empty}>No commands found</div>
          )}
        </div>

        {/* Footer hints */}
        <div className={styles.footer}>
          <span className={styles.footerHint}>
            <span className={styles.kbd}>&uarr;</span>
            <span className={styles.kbd}>&darr;</span>
            navigate
          </span>
          <span className={styles.footerHint}>
            <span className={styles.kbd}>&crarr;</span>
            select
          </span>
          <span className={styles.footerHint}>
            <span className={styles.kbd}>esc</span>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
