import React, {useEffect, useRef, useCallback} from 'react';
import styles from './styles.module.css';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl';

const CATEGORIES = [
  {
    title: 'Editing',
    shortcuts: [
      {action: 'Save', keys: [mod, 'S']},
      {action: 'Bold', keys: [mod, 'B']},
      {action: 'Italic', keys: [mod, 'I']},
      {action: 'Strikethrough', keys: [mod, 'Shift', 'S']},
      {action: 'Inline code', keys: [mod, 'E']},
      {action: 'Heading 1', keys: [mod, 'Alt', '1']},
      {action: 'Heading 2', keys: [mod, 'Alt', '2']},
      {action: 'Heading 3', keys: [mod, 'Alt', '3']},
      {action: 'Bullet list', keys: [mod, 'Shift', '8']},
      {action: 'Ordered list', keys: [mod, 'Shift', '7']},
      {action: 'Blockquote', keys: [mod, 'Shift', 'B']},
      {action: 'Undo', keys: [mod, 'Z']},
      {action: 'Redo', keys: [mod, 'Shift', 'Z']},
    ],
  },
  {
    title: 'Navigation',
    shortcuts: [
      {action: 'File search', keys: [mod, 'O']},
      {action: 'Command palette', keys: [mod, 'K']},
      {action: 'Close panels', keys: ['Esc']},
    ],
  },
  {
    title: 'AI & Tools',
    shortcuts: [
      {action: 'AI Assistant', keys: [mod, 'J']},
      {action: 'Citation autocomplete', keys: ['[@']},
      {action: 'Insert table', keys: ['Toolbar']},
      {action: 'Insert math block', keys: ['Toolbar']},
    ],
  },
  {
    title: 'View',
    shortcuts: [
      {action: 'Toggle auto-save', keys: ['Auto-save button']},
      {action: 'Version history', keys: ['History button']},
      {action: 'Source / Rich toggle', keys: ['Source button']},
      {action: 'Table of Contents', keys: ['TOC button']},
      {action: 'Keyboard shortcuts', keys: [mod, '/']},
    ],
  },
];

export default function KeyboardShortcuts({open, onClose}) {
  const dialogRef = useRef(null);

  const handleOverlayClick = useCallback((e) => {
    if (dialogRef.current && !dialogRef.current.contains(e.target)) {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.overlay} onMouseDown={handleOverlayClick}>
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-label="Keyboard shortcuts">
        <div className={styles.header}>
          <span className={styles.title}>Keyboard Shortcuts</span>
          <button
            className={styles.closeBtn}
            onClick={onClose}
            title="Close"
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className={styles.body}>
          {CATEGORIES.map((cat) => (
            <div key={cat.title} className={styles.category}>
              <div className={styles.categoryTitle}>{cat.title}</div>
              {cat.shortcuts.map((sc) => (
                <div key={sc.action} className={styles.row}>
                  <span className={styles.action}>{sc.action}</span>
                  <span className={styles.keys}>
                    {sc.keys.map((k, i) => (
                      <kbd key={i} className={styles.kbd}>{k}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
