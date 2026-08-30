import React, {useState, useEffect, useRef} from 'react';
import API_BASE, { apiFetch } from '@site/src/utils/api';
import {toast} from '@site/src/components/Toast/toast';
import styles from './styles.module.css';

/**
 * Modal for jotting a note straight to the content tree.
 *
 * Lifted out of the old QuickActions floating button so the bottom CommandBar
 * can raise it from its `note` command. Purely controlled: the caller owns
 * `open` and gets `onClose` when the dialog wants to go away.
 */
export default function QuickNoteDialog({open, onClose}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  async function handleSave() {
    if (!text.trim()) {
      toast.warning('Note text cannot be empty');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch(`${API_BASE}/api/quicknote`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          text: text.trim(),
          title: title.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`Note saved to ${data.filename || data.path}`);
        setTitle('');
        setText('');
        onClose();
      } else {
        toast.error(data.error || 'Failed to save note');
      }
    } catch {
      toast.error('Failed to save note');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Quick note">
        <div className={styles.heading}>Quick Note</div>
        <input
          className={styles.input}
          type="text"
          placeholder="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
        />
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          placeholder="Write your note..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={10000}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSave();
            }
          }}
        />
        <div className={styles.hint}>Cmd/Ctrl+Enter to save</div>
        <div className={styles.actions}>
          <button className={styles.cancelBtn} type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className={styles.saveBtn}
            type="button"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
