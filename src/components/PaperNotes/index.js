import React, {useState, useEffect, useCallback, useRef} from 'react';
import API_BASE from '@site/src/utils/api';

export default function PaperNotes({citationKey, title}) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!expanded || loaded) return;
    fetch(`${API_BASE}/api/notes?key=${encodeURIComponent(citationKey)}`)
      .then(r => r.json())
      .then(d => {
        if (d.note) setContent(d.note.content || '');
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [expanded, loaded, citationKey]);

  const save = useCallback(async (text) => {
    setSaving(true);
    try {
      await fetch(`${API_BASE}/api/notes`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({key: citationKey, content: text, title}),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* silent */ }
    setSaving(false);
  }, [citationKey, title]);

  const handleChange = useCallback((e) => {
    const text = e.target.value;
    setContent(text);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(text), 2000);
  }, [save]);

  const handleBlur = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    save(content);
  }, [save, content]);

  return (
    <div style={{marginTop: 8}}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '4px 8px', border: '1px solid var(--ifm-color-emphasis-200)',
          borderRadius: 4, background: 'transparent', cursor: 'pointer',
          fontSize: '0.78rem', color: 'var(--ifm-color-emphasis-600)',
          fontFamily: 'inherit',
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" style={{transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s'}}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        Reading Notes
        {saved && <span style={{color: 'var(--ifm-color-success)', marginLeft: 4}}>Saved</span>}
        {saving && <span style={{color: 'var(--ifm-color-emphasis-400)', marginLeft: 4}}>Saving...</span>}
      </button>
      {expanded && (
        <textarea
          value={content}
          onChange={handleChange}
          onBlur={handleBlur}
          placeholder="Write your reading notes here..."
          style={{
            display: 'block', width: '100%', minHeight: 100, marginTop: 6,
            padding: '8px 12px', border: '1px solid var(--ifm-color-emphasis-200)',
            borderRadius: 6, fontFamily: 'inherit', fontSize: '0.85rem',
            lineHeight: 1.6, resize: 'vertical',
            backgroundColor: 'var(--ifm-background-color)',
            color: 'var(--ifm-font-color-base)',
          }}
        />
      )}
    </div>
  );
}
