import React, {useState, useRef, useEffect} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {toast} from '@site/src/components/Toast/toast';
import {useClickOutside} from '@site/src/hooks/useClickOutside';

const fabStyle = {
  position: 'fixed',
  bottom: '24px',
  right: '24px',
  zIndex: 1000,
  fontFamily: 'system-ui, -apple-system, sans-serif',
};

const buttonStyle = {
  width: '52px',
  height: '52px',
  borderRadius: '50%',
  border: 'none',
  background: 'var(--ifm-color-primary)',
  color: '#fff',
  fontSize: '24px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
  transition: 'transform 0.2s ease, background 0.2s ease',
};

const menuStyle = {
  position: 'absolute',
  bottom: '62px',
  right: '0',
  background: 'var(--ifm-background-surface-color, #fff)',
  border: '1px solid var(--ifm-color-emphasis-300, #ddd)',
  borderRadius: '12px',
  padding: '8px 0',
  minWidth: '200px',
  boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
  animation: 'fabMenuIn 0.15s ease-out',
};

const linkStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '10px 16px',
  color: 'var(--ifm-font-color-base)',
  textDecoration: 'none',
  fontSize: '14px',
  transition: 'background 0.15s',
  cursor: 'pointer',
  border: 'none',
  background: 'none',
  width: '100%',
  textAlign: 'left',
};

const linkHoverBg = 'var(--ifm-color-emphasis-100, #f5f5f5)';

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.4)',
  zIndex: 1100,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  animation: 'fabMenuIn 0.15s ease-out',
};

const popupStyle = {
  background: 'var(--ifm-background-surface-color, #fff)',
  border: '1px solid var(--ifm-color-emphasis-300, #ddd)',
  borderRadius: '12px',
  padding: '20px',
  width: '90%',
  maxWidth: '480px',
  boxShadow: '0 12px 40px rgba(0,0,0,0.2)',
};

const inputStyle = {
  width: '100%',
  padding: '8px 12px',
  border: '1px solid var(--ifm-color-emphasis-300, #ddd)',
  borderRadius: '8px',
  fontSize: '14px',
  fontFamily: 'inherit',
  background: 'var(--ifm-background-color, #fff)',
  color: 'var(--ifm-font-color-base)',
  outline: 'none',
  boxSizing: 'border-box',
};

const textareaStyle = {
  ...inputStyle,
  minHeight: '120px',
  resize: 'vertical',
  marginTop: '10px',
};

const btnRowStyle = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '8px',
  marginTop: '14px',
};

const saveBtnStyle = {
  padding: '8px 20px',
  borderRadius: '8px',
  border: 'none',
  background: 'var(--ifm-color-primary)',
  color: '#fff',
  fontSize: '14px',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'opacity 0.15s',
};

const cancelBtnStyle = {
  padding: '8px 20px',
  borderRadius: '8px',
  border: '1px solid var(--ifm-color-emphasis-300, #ddd)',
  background: 'transparent',
  color: 'var(--ifm-font-color-base)',
  fontSize: '14px',
  cursor: 'pointer',
  transition: 'opacity 0.15s',
};

function QuickActionsInner() {
  const [open, setOpen] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState(-1);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);
  const containerRef = useRef(null);
  const textareaRef = useRef(null);

  useClickOutside(containerRef, () => setOpen(false), open);

  useEffect(() => {
    if (noteOpen && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [noteOpen]);

  // Close popup on Escape
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape' && noteOpen) {
        setNoteOpen(false);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [noteOpen]);

  async function handleSaveNote() {
    if (!noteText.trim()) {
      toast.warning('Note text cannot be empty');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/quicknote', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          text: noteText.trim(),
          title: noteTitle.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`Note saved to ${data.filename || data.path}`);
        setNoteTitle('');
        setNoteText('');
        setNoteOpen(false);
      } else {
        toast.error(data.error || 'Failed to save note');
      }
    } catch (err) {
      toast.error('Failed to save note');
    } finally {
      setSaving(false);
    }
  }

  function openQuickNote() {
    setOpen(false);
    setNoteOpen(true);
  }

  const links = [
    {
      label: 'Quick Note',
      icon: '\u{1F4DD}',
      action: openQuickNote,
    },
    {
      label: 'New Discussion',
      icon: '\u{270F}\u{FE0F}',
      href: '/discussions?new=1',
    },
    {
      label: 'View Discussions',
      icon: '\u{1F4AC}',
      href: '/discussions',
    },
    {
      label: 'Recent Activity',
      icon: '\u{1F525}',
      href: '/discussions?sort=recent',
    },
  ];

  return (
    <>
      <div ref={containerRef} style={fabStyle}>
        {open && (
          <div style={menuStyle}>
            {links.map((link, i) => {
              const commonProps = {
                key: link.label,
                style: {
                  ...linkStyle,
                  background: hoveredIndex === i ? linkHoverBg : 'transparent',
                },
                onMouseEnter: () => setHoveredIndex(i),
                onMouseLeave: () => setHoveredIndex(-1),
              };
              if (link.action) {
                return (
                  <button {...commonProps} onClick={link.action}>
                    <span style={{fontSize: '16px'}}>{link.icon}</span>
                    {link.label}
                  </button>
                );
              }
              return (
                <a {...commonProps} href={link.href} onClick={() => setOpen(false)}>
                  <span style={{fontSize: '16px'}}>{link.icon}</span>
                  {link.label}
                </a>
              );
            })}
          </div>
        )}
        <button
          style={{
            ...buttonStyle,
            transform: open ? 'rotate(45deg)' : 'rotate(0deg)',
          }}
          onClick={() => setOpen((v) => !v)}
          aria-label="Quick actions"
          title="Quick actions"
        >
          +
        </button>
      </div>

      {noteOpen && (
        <div
          style={overlayStyle}
          onClick={(e) => {
            if (e.target === e.currentTarget) setNoteOpen(false);
          }}
        >
          <div style={popupStyle}>
            <div style={{fontWeight: 600, fontSize: '16px', marginBottom: '12px'}}>
              Quick Note
            </div>
            <input
              type="text"
              placeholder="Title (optional)"
              value={noteTitle}
              onChange={(e) => setNoteTitle(e.target.value)}
              style={inputStyle}
              maxLength={120}
            />
            <textarea
              ref={textareaRef}
              placeholder="Write your note..."
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              style={textareaStyle}
              maxLength={10000}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSaveNote();
                }
              }}
            />
            <div style={{fontSize: '11px', color: 'var(--ifm-color-emphasis-600)', marginTop: '4px'}}>
              Cmd/Ctrl+Enter to save
            </div>
            <div style={btnRowStyle}>
              <button
                style={cancelBtnStyle}
                onClick={() => setNoteOpen(false)}
              >
                Cancel
              </button>
              <button
                style={{
                  ...saveBtnStyle,
                  opacity: saving ? 0.6 : 1,
                  pointerEvents: saving ? 'none' : 'auto',
                }}
                onClick={handleSaveNote}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function QuickActions() {
  return (
    <BrowserOnly>{() => <QuickActionsInner />}</BrowserOnly>
  );
}
