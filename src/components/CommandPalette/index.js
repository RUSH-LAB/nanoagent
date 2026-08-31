import React, {useState, useEffect, useRef, useMemo, useCallback} from 'react';
import {useHistory} from '@docusaurus/router';
import {fuzzyMatch} from '@site/src/utils/fuzzyMatch';
import {icons, useCommands, commandHaystack} from '@site/src/components/commands';
import styles from './styles.module.css';

/* ── Component ─────────────────────────────────────────────────── */
export default function CommandPalette() {
  const history = useHistory();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Whatever the installed plugins offer. Not a list in this file any more.
  const commands = useCommands();
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
    if (!query.trim()) return commands;
    return commands
      .map(cmd => ({
        ...cmd,
        ...fuzzyMatch(query, commandHaystack(cmd)),
      }))
      .filter(cmd => cmd.match)
      .sort((a, b) => b.score - a.score);
  }, [query, commands]);

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
    // Defer so the palette closes before the route swaps behind it. The bottom
    // CommandBar owns the action commands (it hosts their dialogs), so here they
    // only dismiss; navigation is the palette's job.
    if (!cmd.href) return;
    requestAnimationFrame(() => history.push(cmd.href));
  }, [close, history]);

  /* Keyboard navigation */
  const handleKeyDown = useCallback((e) => {
    // results holds only commands; category headers are inserted later into `grouped`,
    // so its length is the actionable item count.
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
