import React, {useState, useEffect, useCallback, useRef} from 'react';
import API_BASE from '@site/src/utils/api';
import {formatTime} from '@site/src/utils/time';
import {useClickOutside} from '@site/src/utils/useClickOutside';

const styles = {
  section: {
    marginTop: '2rem',
    borderTop: '1px solid var(--ifm-color-emphasis-300)',
    paddingTop: '1rem',
  },
  heading: {
    fontSize: '1.1rem',
    fontWeight: 600,
    marginBottom: '0.75rem',
  },
  popup: {
    position: 'fixed',
    zIndex: 1000,
    background: 'var(--ifm-card-background-color, #fff)',
    border: '1px solid var(--ifm-color-emphasis-300)',
    borderRadius: '6px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
    padding: '4px',
    display: 'flex',
    gap: '4px',
  },
  popupBtn: {
    background: 'none',
    border: 'none',
    padding: '4px 10px',
    cursor: 'pointer',
    borderRadius: '4px',
    fontSize: '0.85rem',
    fontWeight: 500,
    color: 'var(--ifm-font-color-base)',
  },
  noteInput: {
    position: 'fixed',
    zIndex: 1001,
    background: 'var(--ifm-card-background-color, #fff)',
    border: '1px solid var(--ifm-color-emphasis-300)',
    borderRadius: '6px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
    padding: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    width: '280px',
  },
  input: {
    padding: '6px 8px',
    border: '1px solid var(--ifm-color-emphasis-300)',
    borderRadius: '4px',
    fontSize: '0.85rem',
    outline: 'none',
    backgroundColor: 'var(--ifm-background-color)',
    color: 'var(--ifm-font-color-base)',
  },
  saveBtn: {
    padding: '4px 12px',
    background: 'var(--ifm-color-primary)',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 500,
    alignSelf: 'flex-end',
  },
  annotationItem: {
    padding: '8px 12px',
    marginBottom: '6px',
    background: 'rgba(255, 255, 80, 0.15)',
    borderLeft: '3px solid #ffd54f',
    borderRadius: '4px',
    position: 'relative',
  },
  annotationText: {
    fontSize: '0.85rem',
    fontStyle: 'italic',
    color: 'var(--ifm-color-emphasis-700)',
    marginBottom: '4px',
  },
  annotationNote: {
    fontSize: '0.85rem',
    color: 'var(--ifm-color-emphasis-900)',
  },
  annotationMeta: {
    fontSize: '0.75rem',
    color: 'var(--ifm-color-emphasis-500)',
    marginTop: '4px',
  },
  deleteBtn: {
    position: 'absolute',
    top: '4px',
    right: '6px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--ifm-color-emphasis-500)',
    fontSize: '1rem',
    lineHeight: 1,
    padding: '2px',
  },
  emptyMsg: {
    fontSize: '0.85rem',
    color: 'var(--ifm-color-emphasis-500)',
    fontStyle: 'italic',
  },
};

export default function Annotations({pageId}) {
  const [annotations, setAnnotations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [popup, setPopup] = useState(null); // {x, y, text, startOffset, endOffset}
  const [noteMode, setNoteMode] = useState(null); // {x, y, text, startOffset, endOffset}
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);
  const popupRef = useRef(null);
  const noteRef = useRef(null);

  const fetchAnnotations = useCallback(async () => {
    if (!pageId) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/annotations?page=${encodeURIComponent(pageId)}`,
      );
      if (!res.ok) throw new Error(`Failed to load annotations (${res.status})`);
      const data = await res.json();
      setAnnotations(data.annotations ?? []);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [pageId]);

  useEffect(() => {
    setLoading(true);
    fetchAnnotations();
  }, [fetchAnnotations]);

  // Listen for text selection within the doc content area
  useEffect(() => {
    function handleMouseUp() {
      // Small delay to let the browser finalize the selection
      setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.toString().trim()) {
          return;
        }

        const text = selection.toString().trim();
        if (text.length < 2 || text.length > 2000) return;

        // Check that the selection is within doc content
        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        const docContent = document.querySelector('article') || document.querySelector('.markdown');
        if (!docContent || !docContent.contains(container)) return;

        const rect = range.getBoundingClientRect();
        const startOffset = range.startOffset;
        const endOffset = range.endOffset;

        setPopup({
          x: rect.left + rect.width / 2,
          y: rect.top - 4,
          text,
          startOffset,
          endOffset,
        });
        setNoteMode(null);
      }, 10);
    }

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, []);

  // Close popup on click outside
  useClickOutside(popupRef, () => setPopup(null));
  useClickOutside(noteRef, () => {
    setNoteMode(null);
    setNoteText('');
  });

  const saveAnnotation = useCallback(async (text, note, startOffset, endOffset) => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/annotations`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          page: pageId,
          text,
          note: note || '',
          startOffset,
          endOffset,
          author: 'Anonymous',
        }),
      });
      if (res.ok) {
        await fetchAnnotations();
      }
    } catch {
      // silently fail
    } finally {
      setSaving(false);
      setPopup(null);
      setNoteMode(null);
      setNoteText('');
      window.getSelection()?.removeAllRanges();
    }
  }, [pageId, fetchAnnotations]);

  const deleteAnnotation = useCallback(async (id) => {
    try {
      await fetch(`${API_BASE}/api/annotations`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({page: pageId, id}),
      });
      setAnnotations(prev => prev.filter(a => a.id !== id));
    } catch {
      // silently fail
    }
  }, [pageId]);

  const handleHighlight = () => {
    if (!popup) return;
    saveAnnotation(popup.text, '', popup.startOffset, popup.endOffset);
  };

  const handleAddNote = () => {
    if (!popup) return;
    setNoteMode({
      x: popup.x,
      y: popup.y,
      text: popup.text,
      startOffset: popup.startOffset,
      endOffset: popup.endOffset,
    });
    setPopup(null);
  };

  const handleSaveNote = () => {
    if (!noteMode) return;
    saveAnnotation(noteMode.text, noteText, noteMode.startOffset, noteMode.endOffset);
  };

  return (
    <>
      {/* Selection popup */}
      {popup && (
        <div
          ref={popupRef}
          style={{
            ...styles.popup,
            left: popup.x - 80,
            top: popup.y - 36,
          }}
        >
          <button
            style={{...styles.popupBtn, background: '#fff9c4'}}
            onClick={handleHighlight}
            type="button"
            disabled={saving}
          >
            Highlight
          </button>
          <button
            style={styles.popupBtn}
            onClick={handleAddNote}
            type="button"
          >
            Add Note
          </button>
        </div>
      )}

      {/* Note input popup */}
      {noteMode && (
        <div
          ref={noteRef}
          style={{
            ...styles.noteInput,
            left: Math.min(noteMode.x - 140, window.innerWidth - 300),
            top: noteMode.y - 100,
          }}
        >
          <div style={{fontSize: '0.8rem', color: 'var(--ifm-color-emphasis-600)', fontStyle: 'italic'}}>
            &ldquo;{noteMode.text.length > 60 ? noteMode.text.slice(0, 60) + '...' : noteMode.text}&rdquo;
          </div>
          <input
            style={styles.input}
            type="text"
            placeholder="Add your note..."
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSaveNote(); }}
            autoFocus
          />
          <button
            style={styles.saveBtn}
            onClick={handleSaveNote}
            type="button"
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}

      {/* Annotations list at the bottom */}
      <section style={styles.section}>
        <h3 style={styles.heading}>Annotations</h3>
        {loading && <p style={styles.emptyMsg}>Loading annotations...</p>}
        {!loading && annotations.length === 0 && (
          <p style={styles.emptyMsg}>
            No annotations yet. Select text in the document to highlight or add notes.
          </p>
        )}
        {annotations.map((ann) => (
          <div key={ann.id} style={styles.annotationItem}>
            <button
              style={styles.deleteBtn}
              onClick={() => deleteAnnotation(ann.id)}
              type="button"
              title="Delete annotation"
              aria-label="Delete annotation"
            >
              &times;
            </button>
            <div style={styles.annotationText}>
              &ldquo;{ann.text}&rdquo;
            </div>
            {ann.note && (
              <div style={styles.annotationNote}>{ann.note}</div>
            )}
            <div style={styles.annotationMeta}>
              {ann.author} &middot; {formatTime(ann.createdAt)}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
