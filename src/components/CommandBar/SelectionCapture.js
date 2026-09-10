import React, {useEffect, useRef, useState} from 'react';
import {formatSharedSelection, selectionContextFrom, sourceLocationFromRange} from './selectionContext';
import {CONTEXT_SELECTION_EVENT} from './contextSelectionEvent';
import styles from './selectionCapture.module.css';

/** Floating action shown beside selected page text. */
export default function SelectionCapture({onCopy}) {
  const [selection, setSelection] = useState(null);
  const rootRef = useRef(null);

  useEffect(() => {
    const inspect = event => {
      if (rootRef.current?.contains(event.target)) return;
      const selected = window.getSelection();
      const node = selected?.anchorNode?.nodeType === 1
        ? selected.anchorNode
        : selected?.anchorNode?.parentElement;
      // CodeMirror owns its logical selection and emits exact file/line data.
      if (node?.closest?.('.cm-editor')) return;
      if (node?.closest?.('[data-command-bar]')) {
        setSelection(null);
        return;
      }
      const range = selected?.rangeCount ? selected.getRangeAt(0) : null;
      const context = selectionContextFrom(selected, {
        title: document.title,
        path: window.location.pathname,
        url: window.location.href,
        ...sourceLocationFromRange(range),
      });
      if (!context) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        setSelection(null);
        return;
      }
      const below = rect.top < 54;
      setSelection({
        context,
        left: Math.min(Math.max(rect.left + rect.width / 2, 76), window.innerWidth - 76),
        top: below ? rect.bottom + 8 : rect.top - 8,
        below,
      });
    };
    const inspectKeyboardSelection = event => {
      if (event.shiftKey || event.key === 'Shift') inspect(event);
    };
    const dismiss = event => {
      if (!rootRef.current?.contains(event.target)) setSelection(null);
    };
    const showExternal = event => {
      const detail = event.detail;
      if (detail?.dismiss) {
        setSelection(null);
        return;
      }
      if (!detail?.context || !Number.isFinite(detail.left) || !Number.isFinite(detail.top)) return;
      setSelection(detail);
    };
    document.addEventListener('pointerup', inspect);
    document.addEventListener('keyup', inspectKeyboardSelection);
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener(CONTEXT_SELECTION_EVENT, showExternal);
    return () => {
      document.removeEventListener('pointerup', inspect);
      document.removeEventListener('keyup', inspectKeyboardSelection);
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener(CONTEXT_SELECTION_EVENT, showExternal);
    };
  }, []);

  if (!selection) return null;

  const copy = () => {
    onCopy(selection.context);
    navigator.clipboard?.writeText(formatSharedSelection('', selection.context)).catch(() => {});
    setSelection(null);
  };

  return (
    <button
      ref={rootRef}
      type="button"
      className={`${styles.capture} ${selection.below ? styles.below : ''}`}
      style={{left: selection.left, top: selection.top}}
      onPointerDown={event => event.preventDefault()}
      onClick={copy}
      aria-label="Copy selected text as chat context"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      Copy as context
    </button>
  );
}
