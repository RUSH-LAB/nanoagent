import React, {useState, useEffect, useRef, useCallback} from 'react';
import styles from './TemplateModal.module.css';
import API_BASE from '@site/src/utils/api';

// Built-in "Blank Page" descriptors. The modal and the empty-state cards use
// different descriptions, so keep two separate constants.
const BLANK_TEMPLATE = {
  name: 'Blank Page',
  description: 'Start with a minimal frontmatter and heading.',
  builtin: true,
};
const BLANK_TEMPLATE_CARD = {
  name: 'Blank Page',
  description: 'Empty document with frontmatter',
  builtin: true,
};

/**
 * Build the initial content for a new file created from a template.
 *
 * Returns blank frontmatter with a title heading when the template is absent or
 * builtin; otherwise the template's own content with its title and date
 * placeholders substituted. The title comes from the file path's basename
 * (extension stripped, dashes turned into spaces).
 */
function buildTemplateContent(tpl, filePath) {
  const title = filePath.split('/').pop().replace(/\.(md|mdx)$/, '').replace(/-/g, ' ');
  const today = new Date().toISOString().split('T')[0];
  if (!tpl || tpl.builtin) {
    return `---\ntitle: "${title}"\ndate: ${today}\n---\n\n# ${title}\n\n`;
  }
  return (tpl.content || '')
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{date\}\}/g, today);
}

/**
 * TemplateModal — a two-step inline modal for creating a new file.
 *
 * Step 1: Enter file path (relative to content/).
 * Step 2: Pick a template from cards fetched from GET /api/templates.
 *
 * Props:
 *   open                – boolean, whether the modal is visible
 *   onClose             – () => void
 *   onCreate            – (filePath: string, content: string) => void
 *   defaultDir          – optional default directory prefix (e.g. "posts/blog/")
 *   preselectedTemplate – optional template object; when set, step 1 creates directly and step 2 is skipped
 */
export default function TemplateModal({open, onClose, onCreate, defaultDir = '', preselectedTemplate = null}) {
  const [step, setStep] = useState(1);
  const [filePath, setFilePath] = useState(defaultDir);
  const [templates, setTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [error, setError] = useState(null);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const inputRef = useRef(null);
  const overlayRef = useRef(null);

  // Reset when modal opens/closes
  useEffect(() => {
    if (open) {
      setStep(1);
      setFilePath(defaultDir);
      setError(null);
      setSelectedTemplate(preselectedTemplate || null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, defaultDir, preselectedTemplate]);

  // Fetch templates when entering step 2
  useEffect(() => {
    if (step !== 2) return;
    setLoadingTemplates(true);
    fetch(`${API_BASE}/api/templates`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load templates');
        return res.json();
      })
      .then(data => {
        const fetched = (data.templates || []).filter(
          t => t.name.toLowerCase() !== 'blank page'
        );
        // Always prepend the built-in "Blank Page" option
        setTemplates([BLANK_TEMPLATE, ...fetched]);
        setLoadingTemplates(false);
      })
      .catch(() => {
        // If the endpoint fails, still show the blank page option
        setTemplates([BLANK_TEMPLATE]);
        setLoadingTemplates(false);
      });
  }, [step]);

  const handlePathSubmit = useCallback((e) => {
    e.preventDefault();
    const trimmed = filePath.trim();
    if (!trimmed) return;
    const fullPath = trimmed.startsWith('content/') ? trimmed : `content/${trimmed}`;
    if (!fullPath.endsWith('.md') && !fullPath.endsWith('.mdx')) {
      setError('File must end with .md or .mdx');
      return;
    }
    setError(null);
    setFilePath(fullPath);

    // If a template was pre-selected (from empty state cards), skip step 2 and create directly
    if (preselectedTemplate) {
      onCreate(fullPath, buildTemplateContent(preselectedTemplate, fullPath));
      onClose();
      return;
    }

    setStep(2);
  }, [filePath, preselectedTemplate, onCreate, onClose]);

  const handleTemplateSelect = useCallback((tpl) => {
    setSelectedTemplate(tpl);
  }, []);

  const handleCreate = useCallback(() => {
    onCreate(filePath, buildTemplateContent(selectedTemplate, filePath));
    onClose();
  }, [selectedTemplate, filePath, onCreate, onClose]);

  const handleOverlayClick = useCallback((e) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (step === 2) {
          setStep(1);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [open, step, onClose]);

  if (!open) return null;

  return (
    <div className={styles.overlay} ref={overlayRef} onClick={handleOverlayClick}>
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.header}>
          <span className={styles.headerTitle}>
            {step === 1
              ? (preselectedTemplate ? `New File — ${preselectedTemplate.name}` : 'New File')
              : 'Choose Template'}
          </span>
          {step === 2 && (
            <button
              className={styles.headerBackBtn}
              onClick={() => setStep(1)}
              title="Back to file path"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Back
            </button>
          )}
          <button className={styles.closeBtn} onClick={onClose} title="Cancel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Step 1: File path */}
        {step === 1 && (
          <form onSubmit={handlePathSubmit} className={styles.stepBody}>
            <label className={styles.label} htmlFor="tpl-file-path">
              File path <span className={styles.labelHint}>(relative to content/)</span>
            </label>
            <input
              ref={inputRef}
              id="tpl-file-path"
              className={styles.input}
              type="text"
              placeholder="e.g. posts/blog/my-new-post.md"
              value={filePath}
              onChange={(e) => {
                setFilePath(e.target.value);
                setError(null);
              }}
              autoComplete="off"
              spellCheck="false"
            />
            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.actions}>
              <button type="button" className={styles.cancelBtn} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className={styles.primaryBtn} disabled={!filePath.trim()}>
                {preselectedTemplate ? 'Create' : 'Next'}
              </button>
            </div>
          </form>
        )}

        {/* Step 2: Template selection */}
        {step === 2 && (
          <div className={styles.stepBody}>
            <div className={styles.pathPreview}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink: 0, opacity: 0.5}}>
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className={styles.pathPreviewText}>{filePath}</span>
            </div>

            {loadingTemplates ? (
              <div className={styles.loadingRow}>Loading templates...</div>
            ) : (
              <div className={styles.templateGrid}>
                {templates.map((tpl) => (
                  <button
                    key={tpl.name}
                    className={`${styles.templateCard} ${
                      selectedTemplate?.name === tpl.name ? styles.templateCardSelected : ''
                    }`}
                    onClick={() => handleTemplateSelect(tpl)}
                    onDoubleClick={() => {
                      handleTemplateSelect(tpl);
                      // Small delay so selectedTemplate state is set
                      setTimeout(() => {
                        // Directly trigger create
                        onCreate(filePath, buildTemplateContent(tpl, filePath));
                        onClose();
                      }, 0);
                    }}
                    type="button"
                  >
                    <span className={styles.templateIcon}>
                      {tpl.builtin ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <line x1="3" y1="9" x2="21" y2="9" />
                          <line x1="9" y1="21" x2="9" y2="9" />
                        </svg>
                      )}
                    </span>
                    <span className={styles.templateName}>{tpl.name}</span>
                    {tpl.description && (
                      <span className={styles.templateDesc}>{tpl.description}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            <div className={styles.actions}>
              <button type="button" className={styles.cancelBtn} onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={!selectedTemplate}
                onClick={handleCreate}
              >
                Create File
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * TemplateCards — a standalone set of template cards for the empty state.
 * Clicking a card fires onSelect(template) which the parent can use
 * to open the full new-file flow pre-seeded with that template.
 *
 * Props:
 *   onSelectTemplate – (template) => void
 */
export function TemplateCards({onSelectTemplate}) {
  const [templates, setTemplates] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/templates`)
      .then(res => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then(data => {
        const fetched = (data.templates || []).filter(
          t => t.name.toLowerCase() !== 'blank page'
        );
        setTemplates([BLANK_TEMPLATE_CARD, ...fetched]);
        setLoaded(true);
      })
      .catch(() => {
        setTemplates([BLANK_TEMPLATE_CARD]);
        setLoaded(true);
      });
  }, []);

  if (!loaded || templates.length === 0) return null;

  return (
    <div className={styles.emptyTemplates}>
      <p className={styles.emptyTemplatesLabel}>Create from Template</p>
      <div className={styles.emptyTemplateGrid}>
        {templates.map((tpl) => (
          <button
            key={tpl.name}
            className={styles.emptyTemplateCard}
            onClick={() => onSelectTemplate(tpl)}
            type="button"
          >
            <span className={styles.emptyTemplateIcon}>
              {tpl.builtin ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="3" y1="9" x2="21" y2="9" />
                  <line x1="9" y1="21" x2="9" y2="9" />
                </svg>
              )}
            </span>
            <span className={styles.emptyTemplateName}>{tpl.name}</span>
            {tpl.description && (
              <span className={styles.emptyTemplateDesc}>{tpl.description}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
