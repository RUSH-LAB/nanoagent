import React, {useState, useRef, useEffect} from 'react';
import {toast} from '@site/src/components/Toast/toast';
import {useClickOutside} from '@site/src/utils/useClickOutside';

/**
 * ShareButton — sits next to BookmarkButton on doc pages.
 *
 * Default click: copies the current page URL to clipboard and shows a toast.
 * Dropdown options:
 *   - Copy Link
 *   - Copy as Markdown  (e.g. [Title](url))
 *   - Copy as Citation   (e.g. [@slug])
 */
export default function ShareButton({pageTitle, pagePath}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close dropdown on outside click
  useClickOutside(ref, () => setOpen(false), open);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  function getUrl() {
    return typeof window !== 'undefined' ? window.location.href : '';
  }

  function citationKey() {
    // Derive a BibTeX-style key from the path, e.g. /docs/math/topology -> topology
    const slug = (pagePath || '')
      .replace(/^\/docs\//, '')
      .replace(/\//g, '-')
      .replace(/^-|-$/g, '');
    return slug || 'page';
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied!`);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
    setOpen(false);
  }

  function handleCopyLink() {
    copyText(getUrl(), 'Link');
  }

  function handleCopyMarkdown() {
    const url = getUrl();
    const title = pageTitle || 'Untitled';
    copyText(`[${title}](${url})`, 'Markdown link');
  }

  function handleCopyCitation() {
    copyText(`[@${citationKey()}]`, 'Citation');
  }

  // Default click copies plain URL
  function handleClick(e) {
    // If the dropdown toggle (caret) was clicked, let it handle itself
    if (e.target.dataset.caret) return;
    copyText(getUrl(), 'Link');
  }

  const btnStyle = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: '1.1rem',
    padding: '4px 6px',
    lineHeight: 1,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    position: 'relative',
    color: 'var(--ifm-font-color-base)',
  };

  const caretStyle = {
    fontSize: '0.65rem',
    padding: '2px 3px',
    cursor: 'pointer',
    opacity: 0.6,
  };

  const dropdownStyle = {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: '4px',
    background: 'var(--ifm-background-surface-color, #fff)',
    border: '1px solid var(--ifm-color-emphasis-300, #ccc)',
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
    zIndex: 100,
    minWidth: '180px',
    padding: '4px 0',
    whiteSpace: 'nowrap',
  };

  const itemStyle = {
    display: 'block',
    width: '100%',
    padding: '6px 12px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: '0.85rem',
    color: 'var(--ifm-font-color-base)',
    lineHeight: 1.5,
  };

  const itemHoverProps = {
    onMouseEnter: (e) => {
      e.currentTarget.style.background = 'var(--ifm-color-emphasis-100, #f5f5f5)';
    },
    onMouseLeave: (e) => {
      e.currentTarget.style.background = 'none';
    },
  };

  return (
    <span ref={ref} style={{position: 'relative', display: 'inline-flex', alignItems: 'center'}}>
      <button
        onClick={handleClick}
        style={btnStyle}
        aria-label="Share this page"
        title="Share this page"
      >
        {/* Share / link icon (Unicode) */}
        <span aria-hidden="true">&#x1F517;</span>
        <span
          data-caret="true"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          style={caretStyle}
          aria-label="Share options"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen((v) => !v);
            }
          }}
        >
          &#9662;
        </span>
      </button>

      {open && (
        <div style={dropdownStyle} role="menu">
          <button
            style={itemStyle}
            role="menuitem"
            onClick={handleCopyLink}
            {...itemHoverProps}
          >
            Copy Link
          </button>
          <button
            style={itemStyle}
            role="menuitem"
            onClick={handleCopyMarkdown}
            {...itemHoverProps}
          >
            Copy as Markdown
          </button>
          <button
            style={itemStyle}
            role="menuitem"
            onClick={handleCopyCitation}
            {...itemHoverProps}
          >
            Copy as Citation [@{citationKey()}]
          </button>
        </div>
      )}
    </span>
  );
}
