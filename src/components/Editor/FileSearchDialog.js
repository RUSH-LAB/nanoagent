import React, {useState, useEffect, useRef, useMemo} from 'react';
import {fuzzyMatch} from '@site/src/utils/fuzzyMatch';
import styles from './styles.module.css';

export default function FileSearchDialog({files, onSelect, onClose}) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    // Store the previously focused element so we can restore it on close
    previousFocusRef.current = document.activeElement;
    inputRef.current?.focus();

    return () => {
      // Restore focus to the previously focused element when dialog unmounts
      previousFocusRef.current?.focus?.();
    };
  }, []);

  const results = useMemo(() => {
    if (!query.trim()) return files.slice(0, 20);
    return files
      .map(f => ({...f, ...fuzzyMatch(query, f.name + ' ' + f.path)}))
      .filter(f => f.match)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }, [query, files]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const dialogContainerRef = useRef(null);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      onSelect(results[selectedIndex].path);
    } else if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Tab') {
      // Trap focus within the dialog
      if (!dialogContainerRef.current) return;
      const focusable = dialogContainerRef.current.querySelectorAll(
        'input, button, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className={styles.searchOverlay} onClick={onClose} role="dialog" aria-label="Search files" aria-modal="true">
      <div ref={dialogContainerRef} className={styles.searchDialog} onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className={styles.searchInput}
          type="text"
          placeholder="Search files... (type to filter)"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className={styles.searchResults}>
          {results.map((file, i) => (
            <button
              key={file.path}
              className={`${styles.searchResult} ${i === selectedIndex ? styles.searchResultActive : ''}`}
              onClick={() => onSelect(file.path)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className={styles.searchFileName}>{file.name.replace(/\.(md|mdx)$/, '')}</span>
              <span className={styles.searchFilePath}>{file.path}</span>
            </button>
          ))}
          {results.length === 0 && (
            <div className={styles.searchEmpty}>No files found</div>
          )}
        </div>
      </div>
    </div>
  );
}
