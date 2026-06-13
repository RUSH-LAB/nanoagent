import React, {useState, useRef, useCallback, useEffect} from 'react';
import styles from './AIAssistant.module.css';
import API_BASE from '@site/src/utils/api';

const API_URL = `${API_BASE}/api/ai/complete`;

const ACTION_TYPES = [
  {type: 'continue', label: 'Continue'},
  {type: 'improve', label: 'Improve'},
  {type: 'explain', label: 'Explain'},
  {type: 'summarize', label: 'Summarize'},
];

export default function AIAssistant({editor, onClose}) {
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeType, setActiveType] = useState(null);
  const [copied, setCopied] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const abortRef = useRef(null);

  // Get selected text or current paragraph from editor
  const getContextText = useCallback(() => {
    if (!editor) return '';
    const {from, to, empty} = editor.state.selection;
    if (!empty) {
      return editor.state.doc.textBetween(from, to, '\n');
    }
    // No selection: get current paragraph text
    const resolved = editor.state.doc.resolve(from);
    const parentNode = resolved.parent;
    return parentNode?.textContent || '';
  }, [editor]);

  // Track selection changes
  useEffect(() => {
    if (!editor) return;
    const handleSelectionUpdate = () => {
      const {empty} = editor.state.selection;
      setHasSelection(!empty);
    };
    editor.on('selectionUpdate', handleSelectionUpdate);
    // Check initial state
    handleSelectionUpdate();
    return () => {
      editor.off('selectionUpdate', handleSelectionUpdate);
    };
  }, [editor]);

  // Abort any in-flight request when the component unmounts
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const contextText = getContextText();

  const handleAction = useCallback(async (type) => {
    const text = getContextText();
    if (!text) return;

    setActiveType(type);
    setLoading(true);
    setError(null);
    setResult('');
    setCopied(false);

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Include the start of the document as context for the model
      let context = '';
      if (editor) {
        const fullText = editor.state.doc.textContent;
        if (fullText.length > text.length) {
          // Send the leading portion of the document, trimmed to a reasonable size
          const maxContext = 500;
          context = fullText.length > maxContext
            ? fullText.slice(0, maxContext) + '...'
            : fullText;
        }
      }

      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          prompt: text,
          context: context || undefined,
          type,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server error (${res.status})`);
      }

      const data = await res.json();
      setResult(data.text || '');
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [editor, getContextText]);

  const handleInsert = useCallback(() => {
    if (!result || !editor) return;
    // Insert at the cursor, replacing the active selection if there is one
    editor.chain().focus().insertContent(result).run();
  }, [result, editor]);

  const handleReplace = useCallback(() => {
    if (!result || !editor) return;
    const {from, to, empty} = editor.state.selection;
    if (empty) {
      // If no selection, insert at cursor
      editor.chain().focus().insertContent(result).run();
    } else {
      // Replace the selected text
      editor.chain().focus().deleteRange({from, to}).insertContent(result).run();
    }
  }, [result, editor]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(result).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Clipboard API unavailable or permission denied; ignore silently
    });
  }, [result]);

  return (
    <div className={styles.panel}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
          </svg>
          AI Assistant
        </span>
        <button className={styles.closeBtn} onClick={onClose} title="Close (Cmd+J)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className={styles.body}>
        {/* Context preview */}
        {contextText && (
          <div className={styles.contextSection}>
            <div className={styles.label}>
              {hasSelection ? 'Selected text' : 'Current paragraph'}
            </div>
            <div className={styles.contextPreview}>
              {contextText.length > 200
                ? contextText.slice(0, 200) + '...'
                : contextText}
            </div>
          </div>
        )}

        {!contextText && (
          <div className={styles.contextSection}>
            <div className={styles.contextPreview} style={{textAlign: 'center', color: 'var(--ifm-color-emphasis-400)'}}>
              Select text or place cursor in a paragraph to get started.
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className={styles.contextSection}>
          <div className={styles.label}>Actions</div>
          <div className={styles.actions}>
            {ACTION_TYPES.map(({type, label}) => (
              <button
                key={type}
                className={`${styles.actionBtn} ${activeType === type ? styles.actionBtnActive : ''}`}
                onClick={() => handleAction(type)}
                disabled={loading || !contextText}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Loading indicator */}
        {loading && (
          <div className={styles.loadingIndicator}>
            <svg className={styles.spinner} width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" opacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" />
            </svg>
            Generating response...
          </div>
        )}

        {/* Error */}
        {error && <div className={styles.error}>{error}</div>}

        {/* Result area */}
        {result && (
          <div className={styles.resultSection}>
            <div className={styles.label}>Result</div>
            <div className={styles.resultText}>{result}</div>
          </div>
        )}

        {/* Shortcut hint */}
        <div className={styles.shortcutHint}>
          <span className={styles.kbd}>Cmd</span> + <span className={styles.kbd}>J</span> to toggle
        </div>
      </div>

      {/* Footer with insert/replace actions */}
      {result && (
        <div className={styles.footer}>
          <button className={styles.insertBtn} onClick={handleInsert} title="Insert at cursor">
            Insert
          </button>
          {hasSelection && (
            <button className={styles.replaceBtn} onClick={handleReplace} title="Replace selected text">
              Replace
            </button>
          )}
          <button className={styles.copyBtn} onClick={handleCopy} title="Copy to clipboard">
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}
