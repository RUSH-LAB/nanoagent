import React, {useEffect, useState, useCallback, useRef, useMemo} from 'react';
import {useEditor, EditorContent} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import {Markdown} from 'tiptap-markdown';
import styles from './styles.module.css';
import CitationAutocomplete from './CitationAutocomplete';
import AIAssistant from './AIAssistant';
import PresenceIndicator from './PresenceIndicator';
import KeyboardShortcuts from './KeyboardShortcuts';
import shortcutStyles from './KeyboardShortcuts.module.css';
import API_BASE from '@site/src/utils/api';
import {TemplateCards} from './TemplateModal';
const PRESENCE_INTERVAL = 5000; // 5 seconds

// katex is a large library needed only by two opt-in surfaces (the Split view
// preview and the Math preview panel), so it is fetched on demand via a dynamic
// import behind a memoized loader instead of being pulled into the editor's
// initial chunk. Rendered output is unchanged once it resolves; only the timing
// of the fetch moves to first Split or Math use.
let katexModule = null;
let katexPromise;
function loadKatex() {
  return (katexPromise ??= import('katex').then((m) => {
    katexModule = m.default ?? m;
    return katexModule;
  }));
}

// Returns the loaded katex module, or null until the dynamic import resolves.
function useKatex() {
  const [katex, setKatex] = useState(katexModule);
  useEffect(() => {
    if (katex) return undefined;
    let mounted = true;
    loadKatex().then((m) => {
      if (mounted) setKatex(m);
    });
    return () => {
      mounted = false;
    };
  }, [katex]);
  return katex;
}

// Generate or retrieve a stable session userId
function getSessionUserId() {
  let id = sessionStorage.getItem('mochi-presence-userId');
  if (!id) {
    id = 'user_' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('mochi-presence-userId', id);
  }
  return id;
}

function getSessionUserName() {
  return sessionStorage.getItem('mochi-presence-userName') || 'Anonymous';
}

function offlineKey(path) {
  return `mochi_offline_${path}`;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_RE);
  if (match) {
    return {frontmatter: match[0], body: content.slice(match[0].length)};
  }
  return {frontmatter: '', body: content};
}

function isDraft(frontmatter) {
  return /^draft:\s*true/m.test(frontmatter);
}

function parseTags(frontmatter) {
  const match = frontmatter.match(/^tags:\s*\[([^\]]*)\]/m);
  if (!match) return [];
  return match[1].split(',').map(t => t.trim()).filter(Boolean);
}

function updateTagsInFrontmatter(frontmatter, newTags) {
  const tagLine = `tags: [${newTags.join(', ')}]`;
  if (/^tags:\s*\[([^\]]*)\]/m.test(frontmatter)) {
    return frontmatter.replace(/^tags:\s*\[([^\]]*)\]/m, tagLine);
  }
  // Insert tags line before closing ---
  return frontmatter.replace(/\n---\n?$/, `\n${tagLine}\n---\n`);
}

function ToolbarButton({active, onClick, title, children}) {
  return (
    <button
      className={`${styles.toolbarBtn} ${active ? styles.toolbarBtnActive : ''}`}
      onClick={onClick}
      title={title}
      type="button"
      aria-label={title}
      aria-pressed={active || false}
    >
      {children}
    </button>
  );
}

function Toolbar({editor, onImageUpload, onToggleAI, aiOpen}) {
  const [snippetsOpen, setSnippetsOpen] = useState(false);

  const snippets = [
    {name: 'Theorem', text: '<Theorem id="thm-" name="">...</Theorem>'},
    {name: 'Definition', text: '<Definition id="def-" name="">...</Definition>'},
    {name: 'Proof', text: '<Proof>...</Proof>'},
    {name: 'Algorithm', text: '<Algorithm id="alg-" caption="">...</Algorithm>'},
    {name: 'Figure', text: '<Figure id="fig-" caption="">![alt](url)</Figure>'},
    {name: 'Footnote', text: '[^1]: footnote text'},
    {name: 'Admonition', text: ':::note\nContent\n:::'},
    {name: 'Citation', text: '[@key]'},
    {name: 'Equation ref', text: '$\\eqref{eq-name}$'},
  ];

  const handleSnippetInsert = useCallback((text) => {
    editor.chain().focus().insertContent(text).run();
    setSnippetsOpen(false);
  }, [editor]);

  if (!editor) return null;

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Text formatting">
      <div className={styles.toolbarGroup}>
        <ToolbarButton
          active={editor.isActive('heading', {level: 1})}
          onClick={() => editor.chain().focus().toggleHeading({level: 1}).run()}
          title="Heading 1"
        >H1</ToolbarButton>
        <ToolbarButton
          active={editor.isActive('heading', {level: 2})}
          onClick={() => editor.chain().focus().toggleHeading({level: 2}).run()}
          title="Heading 2"
        >H2</ToolbarButton>
        <ToolbarButton
          active={editor.isActive('heading', {level: 3})}
          onClick={() => editor.chain().focus().toggleHeading({level: 3}).run()}
          title="Heading 3"
        >H3</ToolbarButton>
      </div>

      <div className={styles.toolbarDivider} />

      <div className={styles.toolbarGroup}>
        <ToolbarButton
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold (Cmd+B)"
        ><strong>B</strong></ToolbarButton>
        <ToolbarButton
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic (Cmd+I)"
        ><em>I</em></ToolbarButton>
        <ToolbarButton
          active={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title="Strikethrough"
        ><s>S</s></ToolbarButton>
        <ToolbarButton
          active={editor.isActive('code')}
          onClick={() => editor.chain().focus().toggleCode().run()}
          title="Inline code"
        ><code>&lt;/&gt;</code></ToolbarButton>
      </div>

      <div className={styles.toolbarDivider} />

      <div className={styles.toolbarGroup}>
        <ToolbarButton
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Bullet list"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Numbered list"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="10" y1="6" x2="21" y2="6" /><line x1="10" y1="12" x2="21" y2="12" />
            <line x1="10" y1="18" x2="21" y2="18" />
            <path d="M4 6h1v4" /><path d="M4 10h2" /><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title="Blockquote"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z" />
            <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3z" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive('codeBlock')}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          title="Code block"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
          </svg>
        </ToolbarButton>
      </div>

      <div className={styles.toolbarDivider} />

      <div className={styles.toolbarGroup}>
        <ToolbarButton
          onClick={() => {
            const url = window.prompt('URL:');
            if (url) editor.chain().focus().setLink({href: url}).run();
          }}
          active={editor.isActive('link')}
          title="Insert link"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          onClick={onImageUpload}
          title="Insert image"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title="Horizontal rule"
        >---</ToolbarButton>
        <ToolbarButton
          onClick={() => {
            editor.chain().focus().insertContent(
              '\n\n| Header 1 | Header 2 | Header 3 |\n|----------|----------|----------|\n| Cell 1   | Cell 2   | Cell 3   |\n| Cell 4   | Cell 5   | Cell 6   |\n\n'
            ).run();
          }}
          title="Insert table"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="3" y1="15" x2="21" y2="15" />
            <line x1="9" y1="3" x2="9" y2="21" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            editor.chain().focus().insertContent('\n\n$$\nequation\n$$\n\n').run();
          }}
          title="Math block (LaTeX)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 20h4l4-12 4 12h4" />
            <line x1="2" y1="20" x2="6" y2="20" />
            <line x1="18" y1="20" x2="22" y2="20" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            const page = window.prompt('Link to page (e.g. math/intro):');
            if (page) {
              editor.chain().focus().insertContent(`[[${page}]]`).run();
            }
          }}
          title="Wiki link [[page]]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            <line x1="2" y1="2" x2="22" y2="22" opacity="0" />
          </svg>
          [[]]
        </ToolbarButton>
      </div>

      <div className={styles.toolbarDivider} />

      <div className={styles.toolbarGroup}>
        <ToolbarButton
          onClick={onToggleAI}
          active={aiOpen}
          title="AI Assistant (Cmd+J)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
          </svg>
        </ToolbarButton>
      </div>

      <div className={styles.toolbarDivider} />

      <div className={styles.toolbarGroup} style={{position: 'relative'}}>
        <ToolbarButton
          onClick={() => setSnippetsOpen(prev => !prev)}
          active={snippetsOpen}
          title="Insert snippet"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </ToolbarButton>
        {snippetsOpen && (
          <>
            <div
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 99,
              }}
              onClick={() => setSnippetsOpen(false)}
            />
            <div style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: 4,
              background: 'var(--ifm-background-color, #fff)',
              border: '1px solid var(--ifm-color-emphasis-300, #ccc)',
              borderRadius: 6,
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              zIndex: 100,
              minWidth: 220,
              padding: '4px 0',
              fontSize: '0.85rem',
            }}>
              {snippets.map((snippet) => (
                <button
                  key={snippet.name}
                  onClick={() => handleSnippetInsert(snippet.text)}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '6px 12px',
                    border: 'none',
                    background: 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                    color: 'var(--ifm-font-color-base, #1c1e21)',
                    fontFamily: 'inherit',
                    fontSize: 'inherit',
                    lineHeight: 1.4,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--ifm-color-emphasis-100, #f0f0f0)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                >
                  {snippet.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

async function uploadImage(file, filePath) {
  const dir = filePath
    ? `static/img/${filePath.split('/').slice(0, -1).join('/')}`
    : 'static/img/uploads';
  const res = await fetch(
    `${API_BASE}/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`,
    {method: 'POST', body: file}
  );
  if (!res.ok) throw new Error('Upload failed');
  const data = await res.json();
  return data.url;
}

/* ── Line-numbered textarea for raw/source mode ──────────── */
function RawEditor({value, onChange}) {
  const textareaRef = useRef(null);
  const lineNumbersRef = useRef(null);
  const [focused, setFocused] = useState(false);

  const lineCount = useMemo(() => value.split('\n').length, [value]);

  const lineNumbers = useMemo(() => {
    const nums = [];
    for (let i = 1; i <= lineCount; i++) {
      nums.push(i);
    }
    return nums;
  }, [lineCount]);

  // Sync scroll between textarea and line numbers
  const handleScroll = useCallback(() => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  return (
    <div
      className={`${styles.rawEditorWrapper} ${focused ? styles.rawEditorWrapperFocused : ''}`}
    >
      <div
        ref={lineNumbersRef}
        className={styles.lineNumbers}
        aria-hidden="true"
      >
        {lineNumbers.map((num) => (
          <div key={num} className={styles.lineNumber}>{num}</div>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        className={styles.rawTextarea}
        value={value}
        onChange={onChange}
        onScroll={handleScroll}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        spellCheck={false}
        aria-label="Raw markdown editor"
      />
    </div>
  );
}

/* ── Client-side markdown-to-HTML conversion ──────────────── */
function markdownToHtml(md, katex) {
  // Strip frontmatter
  let text = md.replace(/^---\n[\s\S]*?\n---\n?/, '');

  // Fenced code blocks (``` ... ```)
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code class="language-${lang || 'text'}">${escaped}</code></pre>`;
  });

  // Block-level math ($$...$$) -- must come before inline processing
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, latex) => {
    if (katex) {
      try {
        return `<div class="math-display">${katex.renderToString(latex.trim(), {displayMode: true, throwOnError: false})}</div>`;
      } catch {
        return `<div class="math-display"><code>${latex.trim()}</code></div>`;
      }
    }
    return `<div class="math-display"><code>${latex.trim()}</code></div>`;
  });

  const lines = text.split('\n');
  const result = [];
  let inList = false;
  let listType = null; // 'ul' or 'ol'
  let inBlockquote = false;
  let blockquoteLines = [];
  let inTable = false;
  let tableRows = [];

  function flushList() {
    if (inList) {
      result.push(`</${listType}>`);
      inList = false;
      listType = null;
    }
  }

  function flushBlockquote() {
    if (inBlockquote) {
      result.push(`<blockquote><p>${blockquoteLines.join('<br>')}</p></blockquote>`);
      inBlockquote = false;
      blockquoteLines = [];
    }
  }

  function flushTable() {
    if (inTable && tableRows.length > 0) {
      let html = '<table>';
      tableRows.forEach((row, idx) => {
        const tag = idx === 0 ? 'th' : 'td';
        const rowTag = idx === 0 ? 'thead' : (idx === 1 ? 'tbody' : '');
        const cells = row.split('|').filter(c => c.trim() !== '').map(c => `<${tag}>${processInline(c.trim())}</${tag}>`).join('');
        if (idx === 0) html += `<thead><tr>${cells}</tr></thead><tbody>`;
        else html += `<tr>${cells}</tr>`;
      });
      html += '</tbody></table>';
      result.push(html);
      inTable = false;
      tableRows = [];
    }
  }

  function processInline(line) {
    // Inline math ($...$) -- before other inline processing
    line = line.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_, latex) => {
      if (katex) {
        try {
          return katex.renderToString(latex.trim(), {displayMode: false, throwOnError: false});
        } catch {
          return `<code>${latex.trim()}</code>`;
        }
      }
      return `<code>${latex.trim()}</code>`;
    });
    // Images
    line = line.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">');
    // Links
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    // Bold + italic
    line = line.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    // Bold
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    line = line.replace(/__(.+?)__/g, '<strong>$1</strong>');
    // Italic
    line = line.replace(/\*(.+?)\*/g, '<em>$1</em>');
    line = line.replace(/_(.+?)_/g, '<em>$1</em>');
    // Strikethrough
    line = line.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Inline code
    line = line.replace(/`([^`]+)`/g, (_, code) => {
      const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<code>${escaped}</code>`;
    });
    return line;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip pre-rendered blocks (already processed code blocks become single lines after replace)
    if (line.startsWith('<pre>') || line.startsWith('<div class="math-display">')) {
      flushList();
      flushBlockquote();
      flushTable();
      result.push(line);
      continue;
    }

    // Table rows
    if (/^\|(.+)\|$/.test(line.trim())) {
      flushList();
      flushBlockquote();
      // Skip separator rows (|---|---|)
      if (/^\|[\s\-:|]+\|$/.test(line.trim())) {
        continue;
      }
      inTable = true;
      tableRows.push(line.trim());
      continue;
    } else {
      flushTable();
    }

    // Blockquote
    if (/^>\s?(.*)/.test(line)) {
      flushList();
      flushTable();
      inBlockquote = true;
      blockquoteLines.push(processInline(line.replace(/^>\s?/, '')));
      continue;
    } else {
      flushBlockquote();
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      const id = headingMatch[2].toLowerCase().replace(/[^\w]+/g, '-').replace(/(^-|-$)/g, '');
      result.push(`<h${level} id="${id}">${processInline(headingMatch[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
      flushList();
      result.push('<hr>');
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        flushList();
        inList = true;
        listType = 'ul';
        result.push('<ul>');
      }
      result.push(`<li>${processInline(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.*)/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        flushList();
        inList = true;
        listType = 'ol';
        result.push('<ol>');
      }
      result.push(`<li>${processInline(olMatch[2])}</li>`);
      continue;
    }

    flushList();

    // Empty line
    if (line.trim() === '') {
      continue;
    }

    // Paragraph
    result.push(`<p>${processInline(line)}</p>`);
  }

  flushList();
  flushBlockquote();
  flushTable();

  return result.join('\n');
}

/* ── Split View editor (raw markdown + live HTML preview) ──── */
function SplitEditor({value, onChange}) {
  const textareaRef = useRef(null);
  const lineNumbersRef = useRef(null);
  const previewRef = useRef(null);
  const [focused, setFocused] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const debounceRef = useRef(null);
  const katex = useKatex();

  const lineCount = useMemo(() => value.split('\n').length, [value]);

  const lineNumbers = useMemo(() => {
    const nums = [];
    for (let i = 1; i <= lineCount; i++) {
      nums.push(i);
    }
    return nums;
  }, [lineCount]);

  // Debounced preview update (300ms). markdownToHtml renders math only once katex
  // has lazily loaded; until then it falls back to plain source text, and the
  // effect re-runs when katex resolves to upgrade the preview.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPreviewHtml(markdownToHtml(value, katex));
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, katex]);

  // Sync scroll: textarea -> line numbers + preview
  const handleScroll = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textarea.scrollTop;
    }

    if (previewRef.current) {
      const scrollRatio = textarea.scrollTop / (textarea.scrollHeight - textarea.clientHeight || 1);
      previewRef.current.scrollTop = scrollRatio * (previewRef.current.scrollHeight - previewRef.current.clientHeight || 1);
    }
  }, []);

  // Sync scroll: preview -> textarea + line numbers
  const handlePreviewScroll = useCallback(() => {
    const preview = previewRef.current;
    const textarea = textareaRef.current;
    if (!preview || !textarea || focused) return; // Only sync when not editing

    const scrollRatio = preview.scrollTop / (preview.scrollHeight - preview.clientHeight || 1);
    textarea.scrollTop = scrollRatio * (textarea.scrollHeight - textarea.clientHeight || 1);
    if (lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textarea.scrollTop;
    }
  }, [focused]);

  return (
    <div className={styles.splitEditorWrapper}>
      <div className={`${styles.splitEditorPane} ${styles.splitEditorLeft}`}>
        <div className={styles.splitPaneHeader}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
          </svg>
          Markdown
        </div>
        <div className={`${styles.rawEditorWrapper} ${focused ? styles.rawEditorWrapperFocused : ''}`} style={{borderRadius: 0}}>
          <div
            ref={lineNumbersRef}
            className={styles.lineNumbers}
            aria-hidden="true"
          >
            {lineNumbers.map((num) => (
              <div key={num} className={styles.lineNumber}>{num}</div>
            ))}
          </div>
          <textarea
            ref={textareaRef}
            className={styles.rawTextarea}
            value={value}
            onChange={onChange}
            onScroll={handleScroll}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            spellCheck={false}
            aria-label="Split view markdown editor"
          />
        </div>
      </div>
      <div className={styles.splitEditorDivider} />
      <div className={`${styles.splitEditorPane} ${styles.splitEditorRight}`}>
        <div className={styles.splitPaneHeader}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          Preview
        </div>
        <div
          ref={previewRef}
          className={styles.splitPreview}
          onScroll={handlePreviewScroll}
          dangerouslySetInnerHTML={{__html: previewHtml}}
        />
      </div>
    </div>
  );
}

/* ── Math Preview Panel ──────────────────────────────────── */
function extractMathBlocks(text) {
  const blocks = [];
  // Match display math $$...$$ first (greedy across lines)
  const displayRe = /\$\$([\s\S]+?)\$\$/g;
  let m;
  while ((m = displayRe.exec(text)) !== null) {
    blocks.push({type: 'display', latex: m[1].trim(), index: m.index});
  }
  // Match inline math $...$ (not preceded/followed by $)
  const inlineRe = /(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g;
  while ((m = inlineRe.exec(text)) !== null) {
    // Skip if this position falls inside a display block
    const insideDisplay = blocks.some(
      b => b.type === 'display' && m.index >= b.index && m.index < b.index + m[0].length + 4
    );
    if (!insideDisplay) {
      blocks.push({type: 'inline', latex: m[1].trim(), index: m.index});
    }
  }
  // Sort by position in document
  blocks.sort((a, b) => a.index - b.index);
  return blocks;
}

function MathPreviewPanel({editor, rawMode, rawContent, onClose}) {
  const [blocks, setBlocks] = useState([]);
  const katex = useKatex();

  useEffect(() => {
    function update() {
      let text = '';
      if (rawMode) {
        text = rawContent || '';
      } else if (editor) {
        // Get the markdown content from the editor
        try {
          text = editor.storage.markdown?.getMarkdown?.() || editor.getText() || '';
        } catch {
          text = editor.getText() || '';
        }
      }
      setBlocks(extractMathBlocks(text));
    }

    update();

    // Listen for editor updates
    if (editor && !rawMode) {
      editor.on('update', update);
      return () => editor.off('update', update);
    }
  }, [editor, rawMode, rawContent]);

  // Re-extract when rawContent changes (for raw mode)
  useEffect(() => {
    if (rawMode) {
      setBlocks(extractMathBlocks(rawContent || ''));
    }
  }, [rawMode, rawContent]);

  return (
    <div className={styles.mathPreviewPanel}>
      <div className={styles.mathPreviewHeader}>
        <span>Math Preview</span>
        <button
          className={styles.treeActionBtn}
          onClick={onClose}
          aria-label="Close math preview"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className={styles.mathPreviewList}>
        {blocks.length === 0 && (
          <div className={styles.mathPreviewEmpty}>
            No math expressions found. Use <code>$...$</code> for inline math or <code>$$...$$</code> for display math.
          </div>
        )}
        {blocks.map((block, i) => {
          let html = '';
          let error = null;
          if (katex) {
            try {
              html = katex.renderToString(block.latex, {
                displayMode: block.type === 'display',
                throwOnError: false,
                trust: true,
              });
            } catch (e) {
              error = e.message;
            }
          }
          return (
            <div key={`${block.index}-${i}`} className={styles.mathPreviewItem}>
              <div className={styles.mathPreviewLabel}>
                <span className={styles.mathPreviewBadge}>
                  {block.type === 'display' ? 'Display' : 'Inline'}
                </span>
                <span className={styles.mathPreviewIndex}>#{i + 1}</span>
              </div>
              {error ? (
                <div className={styles.mathPreviewError}>{error}</div>
              ) : (
                <div
                  className={block.type === 'display' ? styles.mathPreviewDisplay : styles.mathPreviewInline}
                  dangerouslySetInnerHTML={{__html: html}}
                />
              )}
              <div className={styles.mathPreviewSource}>
                <code>{block.type === 'display' ? `$$${block.latex}$$` : `$${block.latex}$`}</code>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TableOfContents({editor, onClose}) {
  const [headings, setHeadings] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const scrollContainerRef = useRef(null);

  // Extract headings from the editor document
  const extractHeadings = useCallback(() => {
    if (!editor) return;
    const items = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        const level = node.attrs.level;
        if (level >= 1 && level <= 4) {
          const text = node.textContent;
          if (text.trim()) {
            items.push({level, text, pos, id: `toc-${pos}`});
          }
        }
      }
    });
    setHeadings(items);
  }, [editor]);

  // Update headings on editor changes
  useEffect(() => {
    extractHeadings();
    if (!editor) return;
    const handler = () => extractHeadings();
    editor.on('update', handler);
    return () => editor.off('update', handler);
  }, [editor, extractHeadings]);

  // Track which heading is currently active based on scroll position
  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;

  useEffect(() => {
    if (!editor || headings.length === 0) return;

    const editorElement = editor.view.dom.closest(`.${styles.editorScroll}`);
    if (!editorElement) return;

    const handleScroll = () => {
      const containerRect = editorElement.getBoundingClientRect();
      let current = null;

      for (const heading of headings) {
        try {
          const domPos = editor.view.domAtPos(heading.pos);
          const el = domPos.node.nodeType === 1
            ? domPos.node
            : domPos.node.parentElement;
          if (!el) continue;
          const headingEl = el.closest('h1, h2, h3, h4') || el;
          const rect = headingEl.getBoundingClientRect();
          // If the heading is above or at the top area of the visible editor
          if (rect.top <= containerRect.top + 80) {
            current = heading.id;
          }
        } catch {
          // pos may be stale, skip
        }
      }

      if (current !== activeIdRef.current) {
        setActiveId(current);
      }
    };

    editorElement.addEventListener('scroll', handleScroll, {passive: true});
    handleScroll(); // initial check
    return () => editorElement.removeEventListener('scroll', handleScroll);
  }, [editor, headings]);

  const handleClick = useCallback((heading) => {
    if (!editor) return;
    try {
      // Focus editor at the heading position
      editor.chain().focus().setTextSelection(heading.pos).run();
      // Scroll the heading into view
      const domPos = editor.view.domAtPos(heading.pos);
      const el = domPos.node.nodeType === 1
        ? domPos.node
        : domPos.node.parentElement;
      if (el) {
        const headingEl = el.closest('h1, h2, h3, h4') || el;
        headingEl.scrollIntoView({behavior: 'smooth', block: 'start'});
      }
    } catch {
      // pos may be stale
    }
  }, [editor]);

  const minLevel = headings.length > 0
    ? Math.min(...headings.map(h => h.level))
    : 1;

  return (
    <div className={styles.tocPanel} role="navigation" aria-label="Table of contents">
      <div className={styles.tocHeader}>
        <span>Contents</span>
        <button
          className={styles.treeActionBtn}
          onClick={onClose}
          aria-label="Close table of contents"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className={styles.tocList} ref={scrollContainerRef}>
        {headings.length === 0 ? (
          <div className={styles.tocEmpty}>
            No headings found
          </div>
        ) : (
          headings.map((heading) => (
            <button
              key={heading.id}
              className={`${styles.tocItem} ${activeId === heading.id ? styles.tocItemActive : ''}`}
              style={{paddingLeft: `${12 + (heading.level - minLevel) * 14}px`}}
              onClick={() => handleClick(heading)}
              title={heading.text}
            >
              <span className={styles.tocLevel}>H{heading.level}</span>
              <span className={styles.tocText}>{heading.text}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

const POMODORO_WORK = 25 * 60; // 25 minutes in seconds
const POMODORO_BREAK = 5 * 60; // 5 minutes in seconds

function getPomodoroCountToday() {
  const today = new Date().toISOString().slice(0, 10);
  const stored = localStorage.getItem('mochi-pomodoro');
  if (stored) {
    try {
      const data = JSON.parse(stored);
      if (data.date === today) return data.count;
    } catch {}
  }
  return 0;
}

function incrementPomodoroCount() {
  const today = new Date().toISOString().slice(0, 10);
  const current = getPomodoroCountToday();
  localStorage.setItem('mochi-pomodoro', JSON.stringify({date: today, count: current + 1}));
  return current + 1;
}

function DocumentStats({editor, rawMode, rawContent}) {
  const [stats, setStats] = useState({words: 0, chars: 0, readingTime: 0, lines: 0});
  const [streak, setStreak] = useState(0);
  const [goalProgress, setGoalProgress] = useState(null); // {wordsWritten, target, type, progress}
  const debounceRef = useRef(null);
  const streakFetchedRef = useRef(false);
  const goalFetchedRef = useRef(false);

  // Pomodoro state
  const [pomodoroActive, setPomodoroActive] = useState(false);
  const [pomodoroSeconds, setPomodoroSeconds] = useState(POMODORO_WORK);
  const [pomodoroOnBreak, setPomodoroOnBreak] = useState(false);
  const [pomodoroCount, setPomodoroCount] = useState(() => getPomodoroCountToday());
  const pomodoroRef = useRef(null);
  const pomodoroOnBreakRef = useRef(false);
  pomodoroOnBreakRef.current = pomodoroOnBreak;

  // Pomodoro countdown
  useEffect(() => {
    if (!pomodoroActive) {
      if (pomodoroRef.current) {
        clearInterval(pomodoroRef.current);
        pomodoroRef.current = null;
      }
      return;
    }
    const intervalId = setInterval(() => {
      setPomodoroSeconds(prev => {
        if (prev <= 1) {
          clearInterval(intervalId);
          pomodoroRef.current = null;
          if (!pomodoroOnBreakRef.current) {
            // Work session complete
            const newCount = incrementPomodoroCount();
            setPomodoroCount(newCount);
            setPomodoroOnBreak(true);
            setPomodoroActive(true);
            // Start break timer after a tick
            setTimeout(() => setPomodoroSeconds(POMODORO_BREAK), 0);
            try {
              const {toast} = require('@site/src/components/Toast/toast');
              toast.success(`Pomodoro #${newCount} complete! Take a 5-min break.`);
            } catch {
              alert('Pomodoro complete! Take a 5-min break.');
            }
          } else {
            // Break complete — reset for next session
            setPomodoroOnBreak(false);
            setPomodoroActive(false);
            setTimeout(() => setPomodoroSeconds(POMODORO_WORK), 0);
            try {
              const {toast} = require('@site/src/components/Toast/toast');
              toast.info('Break over! Ready for the next Pomodoro.');
            } catch {
              alert('Break over! Ready for the next Pomodoro.');
            }
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    pomodoroRef.current = intervalId;
    return () => {
      clearInterval(intervalId);
      pomodoroRef.current = null;
    };
  }, [pomodoroActive]);

  const handlePomodoroClick = useCallback(() => {
    if (pomodoroActive) {
      // Stop timer
      setPomodoroActive(false);
      setPomodoroOnBreak(false);
      setPomodoroSeconds(POMODORO_WORK);
    } else {
      // Start work session
      setPomodoroSeconds(POMODORO_WORK);
      setPomodoroOnBreak(false);
      setPomodoroActive(true);
    }
  }, [pomodoroActive]);

  const formatTime = (secs) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // Fetch streak on mount
  useEffect(() => {
    if (streakFetchedRef.current) return;
    streakFetchedRef.current = true;
    let mounted = true;
    const userId = sessionStorage.getItem('mochi-presence-userId') || 'default';
    fetch(`${API_BASE}/api/streak?userId=${encodeURIComponent(userId)}`)
      .then(r => r.json())
      .then(data => { if (mounted) setStreak(data.currentStreak || 0); })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Fetch daily goal progress on mount
  useEffect(() => {
    if (goalFetchedRef.current) return;
    goalFetchedRef.current = true;
    let mounted = true;
    const userId = sessionStorage.getItem('mochi-presence-userId') || 'default';
    fetch(`${API_BASE}/api/goals?userId=${encodeURIComponent(userId)}`)
      .then(r => r.json())
      .then(data => {
        if (!mounted) return;
        if (data.goals && data.goals.length > 0) {
          // Prefer daily goal, fall back to weekly
          const daily = data.goals.find(g => g.type === 'daily' && !g.isExpired);
          const weekly = data.goals.find(g => g.type === 'weekly' && !g.isExpired);
          const goal = daily || weekly;
          if (goal) {
            setGoalProgress({
              wordsWritten: goal.wordsWritten,
              target: goal.target,
              type: goal.type,
              progress: goal.progress,
            });
          }
        }
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Compute stats from raw content (for raw mode) or editor text
  const computeStats = useCallback(() => {
    let text = '';
    if (rawMode) {
      // Strip frontmatter for counting
      const {body} = parseFrontmatter(rawContent);
      text = body;
    } else if (editor) {
      text = editor.getText();
    }

    const trimmed = text.trim();
    const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
    const chars = text.length;
    const readingTime = Math.max(1, Math.ceil(words / 200));
    const lines = rawMode ? rawContent.split('\n').length : text.split('\n').length;

    setStats({words, chars, readingTime, lines});
  }, [editor, rawMode, rawContent]);

  // Debounced update on editor changes
  useEffect(() => {
    computeStats();

    if (!editor || rawMode) return;

    const handler = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(computeStats, 300);
    };

    editor.on('update', handler);
    return () => {
      editor.off('update', handler);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [editor, rawMode, rawContent, computeStats]);

  return (
    <div className={styles.statsBar}>
      <span className={styles.statItem}>{stats.words} words</span>
      <span className={styles.statItem}>{stats.chars} chars</span>
      <span className={styles.statItem}>~{stats.readingTime} min read</span>
      {rawMode && <span className={styles.statItem}>{stats.lines} lines</span>}
      {streak > 0 && (
        <span className={styles.statItem} title={`${streak} day writing streak`}>
          {'🔥'} {streak} day streak
        </span>
      )}
      {goalProgress && (() => {
        const radius = 8;
        const circumference = 2 * Math.PI * radius;
        const pct = Math.min(1, goalProgress.progress);
        const offset = circumference * (1 - pct);
        const isComplete = pct >= 1;
        return (
          <span
            className={`${styles.goalProgress} ${isComplete ? styles.goalProgressComplete : ''}`}
            title={`${goalProgress.type === 'daily' ? 'Daily' : 'Weekly'} goal: ${goalProgress.wordsWritten}/${goalProgress.target} words`}
          >
            <svg className={styles.goalProgressRing} width="22" height="22">
              <circle className={styles.goalProgressBg} cx="11" cy="11" r={radius} />
              <circle
                className={styles.goalProgressFill}
                cx="11" cy="11" r={radius}
                strokeDasharray={circumference}
                strokeDashoffset={offset}
              />
            </svg>
            <span className={styles.goalProgressLabel}>
              {goalProgress.wordsWritten}/{goalProgress.target} {goalProgress.type === 'daily' ? 'today' : 'this week'}
            </span>
          </span>
        );
      })()}
      <span
        className={styles.statItem}
        style={{cursor: 'pointer', userSelect: 'none', marginLeft: 'auto'}}
        onClick={handlePomodoroClick}
        title={pomodoroActive ? 'Click to stop Pomodoro' : 'Click to start a 25-min Pomodoro'}
      >
        {'🍅'}{' '}
        {pomodoroActive
          ? (pomodoroOnBreak ? `Break ${formatTime(pomodoroSeconds)}` : formatTime(pomodoroSeconds))
          : '25:00'}
      </span>
      {pomodoroCount > 0 && (
        <span className={styles.statItem} title={`${pomodoroCount} Pomodoro sessions today`}>
          {'🍅'} {pomodoroCount} today
        </span>
      )}
    </div>
  );
}

export default function TipTapEditor({filePath, onSaveStatus, readOnly = false, onNavigate, onSelectFile, onNewFile, onCreateFile}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [splitMode, setSplitMode] = useState(false);
  const [rawContent, setRawContent] = useState('');
  const [frontmatter, setFrontmatter] = useState('');
  const [draft, setDraft] = useState(false);
  const [tags, setTags] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [selectedDiff, setSelectedDiff] = useState(null);
  const [compareView, setCompareView] = useState(null); // {version1, version2}
  const [uploading, setUploading] = useState(false);
  const [editorFocused, setEditorFocused] = useState(false);
  const [citationVisible, setCitationVisible] = useState(false);
  const [citationCoords, setCitationCoords] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [presenceUsers, setPresenceUsers] = useState([]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mathPreviewOpen, setMathPreviewOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  const [autoSaveStatus, setAutoSaveStatus] = useState(null); // null | 'saving' | 'saved HH:MM'
  const [exportOpen, setExportOpen] = useState(false);
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  const [externalModified, setExternalModified] = useState(false);
  const knownMtimeRef = useRef(null);
  const fileInputRef = useRef(null);
  const autoSaveTimerRef = useRef(null);
  const exportRef = useRef(null);

  // ── Presence polling ──
  useEffect(() => {
    if (!filePath) {
      setPresenceUsers([]);
      return;
    }
    let mounted = true;
    const controller = new AbortController();
    const userId = getSessionUserId();
    const userName = getSessionUserName();

    function tick() {
      // POST own presence
      fetch(`${API_BASE}/api/presence`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({filePath, userId, userName}),
        signal: controller.signal,
      }).catch(() => {});

      // GET presence for this file
      fetch(`${API_BASE}/api/presence?path=${encodeURIComponent(filePath)}`, {signal: controller.signal})
        .then(r => r.json())
        .then(data => {
          if (!mounted) return;
          const others = (data.users || []).filter(u => u.userId !== userId);
          // Only update state if the user list actually changed to avoid unnecessary re-renders
          setPresenceUsers(prev => {
            const prevIds = prev.map(u => u.userId).join(',');
            const newIds = others.map(u => u.userId).join(',');
            return prevIds === newIds ? prev : others;
          });
        })
        .catch(() => {
          if (!mounted) return;
          setPresenceUsers(prev => prev.length === 0 ? prev : []);
        });
    }

    tick();
    const interval = setInterval(tick, PRESENCE_INTERVAL);
    return () => {
      mounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [filePath]);

  const editor = useEditor({
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        heading: {levels: [1, 2, 3, 4]},
      }),
      Placeholder.configure({
        placeholder: readOnly ? 'View-only mode' : 'Start writing...',
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {class: styles.editorLink},
      }),
      Markdown.configure({
        html: true,
        tightLists: true,
        bulletListMarker: '-',
      }),
    ],
    onUpdate: ({editor: ed}) => {
      setDirty(true);
      // Detect "[@" trigger for citation autocomplete
      const {state} = ed;
      const {from} = state.selection;
      if (from >= 2) {
        const textBefore = state.doc.textBetween(from - 2, from, '\n');
        if (textBefore === '[@') {
          // Get cursor coordinates for positioning the dropdown
          const coords = ed.view.coordsAtPos(from);
          setCitationCoords({top: coords.top, bottom: coords.bottom, left: coords.left});
          setCitationVisible(true);
          // Delete the "[@" trigger text so it doesn't appear in the document
          ed.commands.deleteRange({from: from - 2, to: from});
        }
      }
    },
    onFocus: () => {
      setEditorFocused(true);
    },
    onBlur: () => {
      setEditorFocused(false);
    },
    editorProps: {
      attributes: {
        class: styles.proseMirror,
      },
      handleDrop: (view, event) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
        if (imageFiles.length === 0) return false;
        event.preventDefault();
        setUploading(true);
        Promise.all(imageFiles.map(async (imgFile) => {
          try {
            const url = await uploadImage(imgFile, filePath);
            const {state} = view;
            const pos = view.posAtCoords({left: event.clientX, top: event.clientY})?.pos || state.selection.from;
            const node = state.schema.text(`\n![${imgFile.name}](${url})\n`);
            view.dispatch(state.tr.insert(pos, node));
            setDirty(true);
          } catch {
            setError('Image upload failed');
          }
        })).finally(() => setUploading(false));
        return true;
      },
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            event.preventDefault();
            const file = item.getAsFile();
            if (!file) continue;
            setUploading(true);
            (async () => {
              try {
                const url = await uploadImage(file, filePath);
                const {state} = view;
                const node = state.schema.text(`![${file.name || 'image'}](${url})`);
                view.dispatch(state.tr.replaceSelectionWith(node));
                setDirty(true);
              } catch {
                setError('Image upload failed');
              } finally {
                setUploading(false);
              }
            })();
            return true;
          }
        }
        // Smart URL paste: detect URL in plain text and auto-format
        const text = event.clipboardData?.getData('text/plain');
        if (text && /^https?:\/\//.test(text.trim())) {
          const url = text.trim();
          // arXiv URL → citation
          if (/arxiv\.org\/abs\//.test(url)) {
            const id = url.match(/arxiv\.org\/abs\/([\d.]+)/)?.[1];
            if (id) {
              event.preventDefault();
              editor.chain().focus().insertContent(`[@${id}]`).run();
              setDirty(true);
              return true;
            }
          }
          // Image URL → inline image
          if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url)) {
            event.preventDefault();
            editor.chain().focus().insertContent(`![image](${url})`).run();
            setDirty(true);
            return true;
          }
          // Regular URL → markdown link
          event.preventDefault();
          editor.chain().focus().insertContent(`[${url}](${url})`).run();
          setDirty(true);
          return true;
        }
        return false;
      },
    },
  });

  useEffect(() => {
    if (!filePath || !editor) return;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDirty(false);
    setHasLocalChanges(false);
    setExternalModified(false);
    knownMtimeRef.current = null;

    fetch(`${API_BASE}/api/file?path=${encodeURIComponent(filePath)}`, {signal: controller.signal})
      .then(res => {
        if (!res.ok) throw new Error('Failed to load');
        return res.json();
      })
      .then(data => {
        if (cancelled) return;
        const {frontmatter: fm, body} = parseFrontmatter(data.content);
        setFrontmatter(fm);
        setDraft(isDraft(fm));
        setTags(parseTags(fm));
        setRawContent(data.content);
        editor.commands.setContent(body);
        setLoading(false);
        setDirty(false);
        // Check if there are offline changes saved in localStorage
        try {
          const saved = localStorage.getItem(offlineKey(filePath));
          if (saved != null) {
            setHasLocalChanges(true);
          }
        } catch {
          // localStorage unavailable, ignore
        }
        // Fetch initial mtime for external modification detection
        fetch(`${API_BASE}/api/file/info?path=${encodeURIComponent(filePath)}`, {signal: controller.signal})
          .then(r => r.ok ? r.json() : null)
          .then(info => {
            if (!cancelled && info && info.mtime) {
              knownMtimeRef.current = info.mtime;
            }
          })
          .catch(() => {});
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        // Server unreachable — try to load from localStorage as a fallback
        try {
          const saved = localStorage.getItem(offlineKey(filePath));
          if (saved != null) {
            const {frontmatter: fm, body} = parseFrontmatter(saved);
            setFrontmatter(fm);
            setDraft(isDraft(fm));
            setTags(parseTags(fm));
            setRawContent(saved);
            editor.commands.setContent(body);
            setLoading(false);
            setDirty(true);
            return;
          }
        } catch {
          // localStorage unavailable
        }
        setError('Failed to load file. Is the editor server running? (npm start)');
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [filePath, editor]);

  // ── External modification detection: poll /api/file/info every 30s ──
  const dirtyForMtimeRef = useRef(dirty);
  dirtyForMtimeRef.current = dirty;

  useEffect(() => {
    if (!filePath) return;
    let mounted = true;

    const pollMtime = () => {
      if (!knownMtimeRef.current) return; // not yet initialized
      fetch(`${API_BASE}/api/file/info?path=${encodeURIComponent(filePath)}`)
        .then(r => r.ok ? r.json() : null)
        .then(info => {
          if (!mounted || !info || !info.mtime) return;
          if (knownMtimeRef.current && info.mtime !== knownMtimeRef.current) {
            // File changed on disk — only warn if the user has unsaved edits
            if (dirtyForMtimeRef.current) {
              setExternalModified(true);
            } else {
              // No local edits, silently update the known mtime
              knownMtimeRef.current = info.mtime;
            }
          }
        })
        .catch(() => {});
    };

    const intervalId = setInterval(pollMtime, 30000);
    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [filePath]);

  // Reset external-modified flag when the file path changes
  useEffect(() => {
    setExternalModified(false);
  }, [filePath]);

  // Handler: reload file after external modification
  const handleExternalReload = useCallback(() => {
    if (!filePath || !editor) return;
    setExternalModified(false);
    setLoading(true);
    fetch(`${API_BASE}/api/file?path=${encodeURIComponent(filePath)}`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to reload');
        return res.json();
      })
      .then(data => {
        const {frontmatter: fm, body} = parseFrontmatter(data.content);
        setFrontmatter(fm);
        setDraft(isDraft(fm));
        setTags(parseTags(fm));
        setRawContent(data.content);
        editor.commands.setContent(body);
        setDirty(false);
        setLoading(false);
        // Refresh the known mtime
        return fetch(`${API_BASE}/api/file/info?path=${encodeURIComponent(filePath)}`);
      })
      .then(r => r.ok ? r.json() : null)
      .then(info => {
        if (info && info.mtime) {
          knownMtimeRef.current = info.mtime;
        }
      })
      .catch(() => {
        setError('Failed to reload file');
        setLoading(false);
      });
  }, [filePath, editor]);

  // Handler: dismiss external modification warning
  const handleExternalDismiss = useCallback(() => {
    setExternalModified(false);
  }, []);

  // Sync editable state when readOnly prop changes
  useEffect(() => {
    if (editor) {
      editor.setEditable(!readOnly);
    }
  }, [editor, readOnly]);

  const getFullContent = useCallback(() => {
    if (!editor) return '';
    let md = editor.storage.markdown.getMarkdown();
    md = md.replace(/\{\/\\\*\s*(.*?)\s*\\\*\/\}/g, '{/* $1 */}');
    return frontmatter + md;
  }, [editor, frontmatter]);

  const handleSave = useCallback(async () => {
    if (!filePath || saving) return;
    setSaving(true);
    setError(null);
    const content = (rawMode || splitMode) ? rawContent : getFullContent();
    try {
      const res = await fetch(`${API_BASE}/api/file`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: filePath, content}),
      });
      if (!res.ok) throw new Error('Save failed');
      setDirty(false);
      onSaveStatus?.('saved');
      setTimeout(() => onSaveStatus?.(null), 2000);
      // Successful save — clear any offline backup
      try { localStorage.removeItem(offlineKey(filePath)); } catch {}
      setHasLocalChanges(false);
      setExternalModified(false);
      // Refresh known mtime after save so poll doesn't false-alarm
      fetch(`${API_BASE}/api/file/info?path=${encodeURIComponent(filePath)}`)
        .then(r => r.ok ? r.json() : null)
        .then(info => { if (info && info.mtime) knownMtimeRef.current = info.mtime; })
        .catch(() => {});

      // Update writing streak with current word count
      try {
        const text = (rawMode || splitMode) ? parseFrontmatter(rawContent).body : (editor ? editor.getText() : '');
        const trimmed = text.trim();
        const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
        const userId = sessionStorage.getItem('mochi-presence-userId') || 'default';
        fetch(`${API_BASE}/api/streak`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({userId, wordsWritten: wordCount}),
        }).catch(() => {});
      } catch {
        // Streak update is non-critical
      }
    } catch {
      // Save failed — persist content to localStorage for offline recovery
      try { localStorage.setItem(offlineKey(filePath), content); } catch {}
      setError('Failed to save — changes stored locally');
      onSaveStatus?.('error');
    } finally {
      setSaving(false);
    }
  }, [filePath, saving, rawMode, splitMode, rawContent, getFullContent, onSaveStatus, editor]);

  const handleToggleAI = useCallback(() => {
    setAiOpen(prev => !prev);
  }, []);

  const handleRestoreLocal = useCallback(() => {
    if (!filePath || !editor) return;
    try {
      const saved = localStorage.getItem(offlineKey(filePath));
      if (saved == null) return;
      const {frontmatter: fm, body} = parseFrontmatter(saved);
      setFrontmatter(fm);
      setDraft(isDraft(fm));
      setTags(parseTags(fm));
      setRawContent(saved);
      editor.commands.setContent(body);
      setDirty(true);
      setHasLocalChanges(false);
    } catch {
      setError('Failed to restore local changes');
    }
  }, [filePath, editor]);

  const handleDiscardLocal = useCallback(() => {
    if (!filePath) return;
    try { localStorage.removeItem(offlineKey(filePath)); } catch {}
    setHasLocalChanges(false);
  }, [filePath]);

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (dirtyRef.current) handleSaveRef.current();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        handleToggleAI();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setShortcutsOpen(prev => !prev);
      }
      if (e.key === 'Escape') {
        setFocusMode(prev => {
          if (prev) { e.preventDefault(); return false; }
          return prev;
        });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleToggleAI]);

  // ── Auto-save: debounce 3s after dirty changes ──
  const getFullContentRef = useRef(getFullContent);
  getFullContentRef.current = getFullContent;
  const onSaveStatusRef = useRef(onSaveStatus);
  onSaveStatusRef.current = onSaveStatus;
  const savingRef = useRef(saving);
  savingRef.current = saving;

  useEffect(() => {
    // Clear any pending auto-save timer
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    // Only auto-save when: enabled, content is dirty, not in raw/split mode, not read-only, and file is loaded
    if (!autoSaveEnabled || !dirty || rawMode || splitMode || readOnly || !filePath || saving) {
      return;
    }

    let cancelled = false;

    autoSaveTimerRef.current = setTimeout(async () => {
      // Double-check conditions are still valid when timer fires
      if (savingRef.current || cancelled) return;

      setAutoSaveStatus('saving');
      const content = getFullContentRef.current();
      try {
        const res = await fetch(`${API_BASE}/api/file`, {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({path: filePath, content}),
        });
        if (cancelled) return;
        if (!res.ok) throw new Error('Auto-save failed');
        setDirty(false);
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        setAutoSaveStatus(`saved ${timeStr}`);
        onSaveStatusRef.current?.('saved');
        setTimeout(() => onSaveStatusRef.current?.(null), 2000);
        // Successful auto-save — clear any offline backup
        try { localStorage.removeItem(offlineKey(filePath)); } catch {}
        setHasLocalChanges(false);
        setExternalModified(false);
        // Refresh known mtime after auto-save
        fetch(`${API_BASE}/api/file/info?path=${encodeURIComponent(filePath)}`)
          .then(r => r.ok ? r.json() : null)
          .then(info => { if (info && info.mtime) knownMtimeRef.current = info.mtime; })
          .catch(() => {});
        // Clear the "Auto-saved" indicator after 5 seconds
        setTimeout(() => {
          if (!cancelled) {
            setAutoSaveStatus(prev => prev?.startsWith('saved') ? null : prev);
          }
        }, 5000);
      } catch {
        if (cancelled) return;
        // Auto-save failed — persist content to localStorage for offline recovery
        try { localStorage.setItem(offlineKey(filePath), content); } catch {}
        setAutoSaveStatus(null);
      }
    }, 3000);

    return () => {
      cancelled = true;
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [autoSaveEnabled, dirty, rawMode, splitMode, readOnly, filePath, saving]);

  // Clear auto-save timer on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, []);

  // Close export dropdown on outside click
  useEffect(() => {
    if (!exportOpen) return;
    const handler = (e) => {
      if (exportRef.current && !exportRef.current.contains(e.target)) {
        setExportOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [exportOpen]);

  const handleExport = useCallback((format) => {
    if (!filePath) return;
    setExportOpen(false);
    const url = `${API_BASE}/api/file/export?path=${encodeURIComponent(filePath)}&format=${format}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [filePath]);

  const toggleRawMode = useCallback(() => {
    if (rawMode) {
      // Leaving Source mode -> go to Rich
      const {frontmatter: fm, body} = parseFrontmatter(rawContent);
      setFrontmatter(fm);
      setDraft(isDraft(fm));
      setTags(parseTags(fm));
      editor?.commands.setContent(body);
    } else if (splitMode) {
      // Leaving Split mode -> go to Source (rawContent already current)
    } else {
      // Leaving Rich mode -> go to Source
      setRawContent(getFullContent());
    }
    setSplitMode(false);
    setRawMode(!rawMode);
  }, [rawMode, splitMode, rawContent, editor, getFullContent]);

  const toggleSplitMode = useCallback(() => {
    if (splitMode) {
      // Leaving split mode -> go back to Rich
      const {frontmatter: fm, body} = parseFrontmatter(rawContent);
      setFrontmatter(fm);
      setDraft(isDraft(fm));
      setTags(parseTags(fm));
      editor?.commands.setContent(body);
      setSplitMode(false);
      setRawMode(false);
    } else {
      // Entering split mode
      if (rawMode) {
        // Already have rawContent from Source mode
      } else {
        setRawContent(getFullContent());
      }
      setRawMode(false);
      setSplitMode(true);
    }
  }, [splitMode, rawMode, rawContent, editor, getFullContent]);

  const handleToggleDraft = useCallback(async () => {
    if (!filePath) return;
    const newDraft = !draft;
    try {
      const res = await fetch(`${API_BASE}/api/file/draft`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: filePath, draft: newDraft}),
      });
      if (!res.ok) throw new Error('Failed to toggle draft');
      setDraft(newDraft);
      // Reload content to pick up frontmatter change
      const fileRes = await fetch(`${API_BASE}/api/file?path=${encodeURIComponent(filePath)}`);
      const data = await fileRes.json();
      const {frontmatter: fm, body} = parseFrontmatter(data.content);
      setFrontmatter(fm);
      setTags(parseTags(fm));
      setRawContent(data.content);
      if (!rawMode && !splitMode) editor?.commands.setContent(body);
    } catch {
      setError('Failed to toggle draft status');
    }
  }, [filePath, draft, editor, rawMode, splitMode]);

  const isPostFile = filePath?.startsWith('content/posts/');

  const handleRemoveTag = useCallback(async (tagToRemove) => {
    if (!filePath || readOnly) return;
    const newTags = tags.filter(t => t !== tagToRemove);
    const newFm = updateTagsInFrontmatter(frontmatter, newTags);
    setFrontmatter(newFm);
    setTags(newTags);
    // Save the file with updated frontmatter
    try {
      const content = (rawMode || splitMode) ? rawContent.replace(frontmatter, newFm) : newFm + (editor?.storage.markdown.getMarkdown() || '');
      await fetch(`${API_BASE}/api/file`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: filePath, content}),
      });
      if (rawMode || splitMode) setRawContent(content);
    } catch {
      setError('Failed to update tags');
    }
  }, [filePath, readOnly, tags, frontmatter, rawMode, splitMode, rawContent, editor]);

  const handleAddTag = useCallback(async () => {
    if (!filePath || readOnly) return;
    const newTag = prompt('Enter tag name:');
    if (!newTag || !newTag.trim()) return;
    const trimmed = newTag.trim().toLowerCase().replace(/\s+/g, '-');
    if (tags.includes(trimmed)) return;
    const newTags = [...tags, trimmed];
    const newFm = updateTagsInFrontmatter(frontmatter, newTags);
    setFrontmatter(newFm);
    setTags(newTags);
    // Save the file with updated frontmatter
    try {
      const content = (rawMode || splitMode) ? rawContent.replace(frontmatter, newFm) : newFm + (editor?.storage.markdown.getMarkdown() || '');
      await fetch(`${API_BASE}/api/file`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: filePath, content}),
      });
      if (rawMode || splitMode) setRawContent(content);
    } catch {
      setError('Failed to update tags');
    }
  }, [filePath, readOnly, tags, frontmatter, rawMode, splitMode, rawContent, editor]);

  const handleImageUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0 || !editor) return;
    setUploading(true);
    try {
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        const url = await uploadImage(file, filePath);
        editor.chain().focus().insertContent(`![${file.name}](${url})`).run();
        setDirty(true);
      }
    } catch {
      setError('Image upload failed');
    } finally {
      setUploading(false);
      // Reset input so the same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [editor, filePath]);

  const loadHistory = useCallback(() => {
    if (!filePath) return;
    fetch(`${API_BASE}/api/history?path=${encodeURIComponent(filePath)}`)
      .then(r => r.json())
      .then(d => setHistory(d.commits || []))
      .catch(() => setHistory([]));
  }, [filePath]);

  const handleToggleHistory = useCallback(() => {
    if (!historyOpen) loadHistory();
    setHistoryOpen(!historyOpen);
    setSelectedDiff(null);
    setCompareView(null);
  }, [historyOpen, loadHistory]);

  const handleViewDiff = useCallback(async (hash) => {
    try {
      const res = await fetch(`${API_BASE}/api/history/diff?path=${encodeURIComponent(filePath)}&hash=${hash}`);
      const data = await res.json();
      setSelectedDiff(data.diff || 'No diff available');
    } catch {
      setSelectedDiff('Failed to load diff');
    }
  }, [filePath]);

  const handleCompareWithCurrent = useCallback(async (hash) => {
    try {
      const res = await fetch(
        `${API_BASE}/api/file/compare?path=${encodeURIComponent(filePath)}&hash1=${hash}&hash2=current`
      );
      const data = await res.json();
      if (data.error) {
        setSelectedDiff(`Compare failed: ${data.error}`);
        return;
      }
      setCompareView(data);
    } catch {
      setSelectedDiff('Failed to load comparison');
    }
  }, [filePath]);

  const handleCitationClose = useCallback(() => {
    setCitationVisible(false);
    setCitationCoords(null);
  }, []);

  // ── Empty state: recent files, quick actions, stats ──
  const [emptyStats, setEmptyStats] = useState(null);
  const [recentFiles, setRecentFiles] = useState([]);

  useEffect(() => {
    if (filePath) return;
    let mounted = true;
    // Load recent files from localStorage
    try {
      const stored = JSON.parse(localStorage.getItem('mochi-recent-files') || '[]');
      setRecentFiles(stored.slice(0, 5));
    } catch {
      setRecentFiles([]);
    }
    // Fetch stats
    fetch(`${API_BASE}/api/stats`)
      .then(r => r.json())
      .then(data => { if (mounted) setEmptyStats(data); })
      .catch(() => { if (mounted) setEmptyStats(null); });
    return () => { mounted = false; };
  }, [filePath]);

  if (!filePath) {
    return (
      <div className={styles.emptyState} style={{gap: 0, padding: '48px 24px'}}>
        {/* Icon + title */}
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.3">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
        <p style={{margin: '12px 0 4px', fontSize: '1rem'}}>Select a file to start editing</p>

        {/* Recent files */}
        {recentFiles.length > 0 && (
          <div style={{
            marginTop: 20,
            width: '100%',
            maxWidth: 380,
          }}>
            <p style={{
              fontSize: '0.75rem',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--ifm-color-emphasis-500)',
              margin: '0 0 8px',
            }}>Recent Files</p>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}>
              {recentFiles.map((fp) => {
                const name = fp.split('/').pop();
                const dir = fp.split('/').slice(0, -1).join('/');
                return (
                  <button
                    key={fp}
                    onClick={() => onSelectFile && onSelectFile(fp)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      background: 'none',
                      border: 'none',
                      borderRadius: 6,
                      cursor: 'pointer',
                      textAlign: 'left',
                      color: 'var(--ifm-color-emphasis-700)',
                      fontSize: '0.85rem',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--ifm-color-emphasis-100)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'none'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink: 0, opacity: 0.5}}>
                      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span style={{fontWeight: 500}}>{name}</span>
                    <span style={{fontSize: '0.75rem', color: 'var(--ifm-color-emphasis-400)', marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160}}>
                      {dir}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Quick actions */}
        <div style={{
          marginTop: 20,
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          justifyContent: 'center',
          maxWidth: 380,
        }}>
          <button
            onClick={() => onNewFile && onNewFile()}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid var(--ifm-color-primary, #2563eb)',
              background: 'var(--ifm-color-primary, #2563eb)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '0.82rem',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New File
          </button>
          <button
            onClick={() => {
              // Trigger Cmd+O search
              document.dispatchEvent(new KeyboardEvent('keydown', {key: 'o', metaKey: true, bubbles: true}));
            }}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid var(--ifm-color-emphasis-200)',
              background: 'var(--ifm-color-emphasis-100)',
              color: 'var(--ifm-color-emphasis-700)',
              cursor: 'pointer',
              fontSize: '0.82rem',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            Search Files
            <kbd style={{fontSize: '0.7rem', padding: '1px 5px', borderRadius: 3, background: 'var(--ifm-color-emphasis-200)', color: 'var(--ifm-color-emphasis-500)', marginLeft: 2}}>
              Cmd+O
            </kbd>
          </button>
        </div>

        {/* Template cards */}
        <TemplateCards onSelectTemplate={(tpl) => {
          if (onNewFile) onNewFile(tpl);
        }} />

        {/* Keyboard hint */}
        <p style={{
          fontSize: '0.75rem',
          color: 'var(--ifm-color-emphasis-400)',
          marginTop: 16,
        }}>
          <kbd style={{fontSize: '0.7rem', padding: '1px 5px', borderRadius: 3, background: 'var(--ifm-color-emphasis-200)', color: 'var(--ifm-color-emphasis-500)'}}>Cmd+K</kbd>
          {' '}Command Palette
        </p>

        {/* Stats */}
        {emptyStats && (
          <div style={{
            marginTop: 24,
            display: 'flex',
            gap: 24,
            fontSize: '0.8rem',
            color: 'var(--ifm-color-emphasis-400)',
          }}>
            {emptyStats.totalFiles != null && (
              <span><strong style={{color: 'var(--ifm-color-emphasis-600)'}}>{emptyStats.totalFiles}</strong> files</span>
            )}
            {emptyStats.totalWords != null && (
              <span><strong style={{color: 'var(--ifm-color-emphasis-600)'}}>{emptyStats.totalWords.toLocaleString()}</strong> words</span>
            )}
            {emptyStats.totalReferences != null && (
              <span><strong style={{color: 'var(--ifm-color-emphasis-600)'}}>{emptyStats.totalReferences}</strong> references</span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`${styles.editorContainer} ${focusMode ? styles.focusModeActive : ''}`}>
      <div className={`${styles.editorHeader} ${focusMode ? styles.focusModeHeader : ''}`}>
        <span className={styles.filePath}>
          <span className={styles.breadcrumb}>
            {filePath.split('/').map((segment, i, arr) => {
              const isLast = i === arr.length - 1;
              const partialPath = arr.slice(0, i + 1).join('/');
              return (
                <React.Fragment key={i}>
                  {i > 0 && <span className={styles.breadcrumbSep}>/</span>}
                  {isLast ? (
                    <span className={styles.breadcrumbFile}>{segment}</span>
                  ) : (
                    <span
                      className={styles.breadcrumbSegment}
                      onClick={() => onNavigate?.(partialPath)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') onNavigate?.(partialPath); }}
                    >{segment}</span>
                  )}
                </React.Fragment>
              );
            })}
          </span>
          {draft && <span className={styles.draftBadge}>Draft</span>}
          {isPostFile && tags.length > 0 && (
            <span className={styles.tagList}>
              {tags.map(tag => (
                <span key={tag} className={styles.tagPill}>
                  {tag}
                  {!readOnly && (
                    <button
                      className={styles.tagRemove}
                      onClick={() => handleRemoveTag(tag)}
                      title={`Remove tag "${tag}"`}
                      aria-label={`Remove tag ${tag}`}
                    >&times;</button>
                  )}
                </span>
              ))}
            </span>
          )}
          {isPostFile && !readOnly && (
            <button
              className={styles.tagAddBtn}
              onClick={handleAddTag}
              title="Add tag"
              aria-label="Add tag"
            >+</button>
          )}
          <PresenceIndicator users={presenceUsers} />
        </span>
        <div className={styles.editorActions}>
          {readOnly && (
            <span style={{fontSize: '0.78rem', color: '#a16207', fontWeight: 500}}>View only</span>
          )}
          {!readOnly && autoSaveStatus === 'saving' && (
            <span className={styles.autoSaveIndicator}>Auto-saving...</span>
          )}
          {!readOnly && autoSaveStatus?.startsWith('saved') && (
            <span className={styles.autoSaveIndicator}>
              Auto-saved at {autoSaveStatus.slice(6)}
            </span>
          )}
          {!readOnly && dirty && !autoSaveStatus && <span className={styles.unsaved}>Unsaved</span>}
          {!readOnly && (
            <button
              className={styles.draftToggle}
              onClick={handleToggleDraft}
              title={draft ? 'Publish this file' : 'Mark as draft'}
            >
              {draft ? 'Publish' : 'Draft'}
            </button>
          )}
          {!readOnly && (
            <button
              className={`${styles.autoSaveToggle} ${autoSaveEnabled ? styles.autoSaveToggleOn : ''}`}
              onClick={() => {
                setAutoSaveEnabled(prev => !prev);
                setAutoSaveStatus(null);
              }}
              title={autoSaveEnabled ? 'Disable auto-save' : 'Enable auto-save'}
            >
              Auto-save: {autoSaveEnabled ? 'ON' : 'OFF'}
            </button>
          )}
          <button
            className={`${styles.modeToggle} ${tocOpen ? styles.modeToggleActive : ''}`}
            onClick={() => setTocOpen(prev => !prev)}
            title="Table of Contents"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="15" y2="12" />
              <line x1="3" y1="18" x2="18" y2="18" />
            </svg>
            TOC
          </button>
          <button
            className={`${styles.modeToggle} ${mathPreviewOpen ? styles.modeToggleActive : ''}`}
            onClick={() => setMathPreviewOpen(prev => !prev)}
            title="Math preview"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20h4l4-12 4 12h4" />
              <line x1="2" y1="20" x2="6" y2="20" />
              <line x1="18" y1="20" x2="22" y2="20" />
            </svg>
            Math
          </button>
          <button
            className={styles.modeToggle}
            onClick={handleToggleHistory}
            title="Version history"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            History
          </button>
          {!readOnly && (
            <button
              className={`${styles.modeToggle} ${rawMode && !splitMode ? styles.modeToggleActive : ''}`}
              onClick={toggleRawMode}
              title="Toggle raw markdown"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
              </svg>
              {rawMode && !splitMode ? 'Rich' : 'Source'}
            </button>
          )}
          {!readOnly && (
            <button
              className={`${styles.modeToggle} ${splitMode ? styles.modeToggleActive : ''}`}
              onClick={toggleSplitMode}
              title="Split view (markdown + preview)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="18" rx="2" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
              {splitMode ? 'Rich' : 'Split'}
            </button>
          )}
          <div ref={exportRef} style={{position: 'relative', display: 'inline-block'}}>
            <button
              className={styles.modeToggle}
              onClick={() => setExportOpen(prev => !prev)}
              title="Export document"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Export
            </button>
            {exportOpen && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4,
                background: 'var(--ifm-background-color, #fff)', border: '1px solid var(--ifm-color-emphasis-300, #ccc)',
                borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 100,
                minWidth: 170, overflow: 'hidden',
              }}>
                <button
                  onClick={() => handleExport('md')}
                  style={{
                    display: 'block', width: '100%', padding: '8px 14px', border: 'none',
                    background: 'none', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem',
                    color: 'var(--ifm-font-color-base, #333)',
                  }}
                  onMouseEnter={(e) => e.target.style.background = 'var(--ifm-color-emphasis-100, #f0f0f0)'}
                  onMouseLeave={(e) => e.target.style.background = 'none'}
                >
                  Download Markdown
                </button>
                <button
                  onClick={() => handleExport('html')}
                  style={{
                    display: 'block', width: '100%', padding: '8px 14px', border: 'none',
                    background: 'none', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem',
                    color: 'var(--ifm-font-color-base, #333)',
                  }}
                  onMouseEnter={(e) => e.target.style.background = 'var(--ifm-color-emphasis-100, #f0f0f0)'}
                  onMouseLeave={(e) => e.target.style.background = 'none'}
                >
                  Download HTML
                </button>
              </div>
            )}
          </div>
          <button
            className={`${styles.modeToggle} ${focusMode ? styles.modeToggleActive : ''}`}
            onClick={() => setFocusMode(prev => !prev)}
            title="Focus mode (distraction-free writing)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="6" />
              <circle cx="12" cy="12" r="2" />
            </svg>
            Focus
          </button>
          <button
            className={shortcutStyles.helpBtn}
            onClick={() => setShortcutsOpen(true)}
            title="Keyboard shortcuts (Cmd+/)"
            type="button"
          >?</button>
          {!readOnly && (
            <button
              className={styles.saveBtn}
              onClick={handleSave}
              disabled={saving || !dirty}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>

      {error && <div className={styles.error} role="alert">{error}</div>}

      {hasLocalChanges && (
        <div className={styles.localChangesBanner}>
          <span>Unsaved local changes found</span>
          <button className={styles.localChangesBtn} onClick={handleRestoreLocal}>Restore</button>
          <button className={styles.localChangesBtnDiscard} onClick={handleDiscardLocal}>Discard</button>
        </div>
      )}

      {externalModified && (
        <div className={styles.externalModifiedBanner} role="alert">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" style={{flexShrink: 0}}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>This file was modified externally. Reload to see changes?</span>
          <button className={styles.externalModifiedReloadBtn} onClick={handleExternalReload}>Reload</button>
          <button className={styles.externalModifiedDismissBtn} onClick={handleExternalDismiss}>Dismiss</button>
        </div>
      )}

      <div style={{flex: 1, display: 'flex', minHeight: 0, position: 'relative'}}>
        {loading ? (
          <div className={styles.loading}>Loading...</div>
        ) : splitMode ? (
          <SplitEditor
            value={rawContent}
            onChange={(e) => {
              setRawContent(e.target.value);
              setDirty(true);
            }}
          />
        ) : rawMode ? (
          <RawEditor
            value={rawContent}
            onChange={(e) => {
              setRawContent(e.target.value);
              setDirty(true);
            }}
          />
        ) : (
          <div className={styles.editorWrap}>
            {!readOnly && !focusMode && <Toolbar editor={editor} onImageUpload={handleImageUpload} onToggleAI={handleToggleAI} aiOpen={aiOpen} />}
            <div className={`${styles.editorScroll} ${editorFocused ? styles.editorScrollFocused : ''} ${focusMode ? styles.focusModeScroll : ''}`}>
              {focusMode && (
                <button
                  className={styles.focusModeExit}
                  onClick={() => setFocusMode(false)}
                  title="Exit focus mode (Esc)"
                  type="button"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                  Exit Focus
                </button>
              )}
              <EditorContent editor={editor} />
              <CitationAutocomplete
                editor={editor}
                visible={citationVisible}
                onClose={handleCitationClose}
                cursorCoords={citationCoords}
              />
              {uploading && (
                <div className={styles.uploadingOverlay}>
                  <span className={styles.uploadingText}>Uploading...</span>
                </div>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileInputChange}
              style={{display: 'none'}}
              aria-label="Upload image"
            />
          </div>
        )}

        {historyOpen && (
          <div className={styles.historyPanel} style={compareView ? {width: '70vw', maxWidth: 900} : undefined}>
            <div className={styles.historyHeader}>
              <span>{compareView ? 'Compare with current' : 'History'}</span>
              <button
                className={styles.treeActionBtn}
                onClick={() => setHistoryOpen(false)}
                aria-label="Close history panel"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            {compareView ? (
              <>
                <button
                  className={styles.historyItem}
                  onClick={() => setCompareView(null)}
                  style={{flexShrink: 0}}
                >
                  <span className={styles.historyMessage}>&larr; Back to commits</span>
                </button>
                <div className={styles.compareContainer}>
                  <div className={styles.comparePane}>
                    <div className={styles.comparePaneHeader}>
                      {compareView.version1.hash} &middot; {compareView.version1.date?.split(' ')[0] || compareView.version1.date?.split('T')[0]}
                    </div>
                    <div className={styles.comparePaneContent}>
                      {(() => {
                        const oldLines = compareView.version1.content.split('\n');
                        const newLines = compareView.version2.content.split('\n');
                        const newSet = new Set(newLines);
                        return oldLines.map((line, i) => (
                          <div key={i} className={!newSet.has(line) ? styles.diffRemove : ''}>
                            {line || ' '}
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                  <div className={styles.comparePane}>
                    <div className={styles.comparePaneHeader}>
                      {compareView.version2.hash === 'current' ? 'Current' : compareView.version2.hash} &middot; {compareView.version2.date?.split(' ')[0] || compareView.version2.date?.split('T')[0]}
                    </div>
                    <div className={styles.comparePaneContent}>
                      {(() => {
                        const oldLines = compareView.version1.content.split('\n');
                        const newLines = compareView.version2.content.split('\n');
                        const oldSet = new Set(oldLines);
                        return newLines.map((line, i) => (
                          <div key={i} className={!oldSet.has(line) ? styles.diffAdd : ''}>
                            {line || ' '}
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                </div>
              </>
            ) : selectedDiff ? (
              <>
                <button
                  className={styles.historyItem}
                  onClick={() => setSelectedDiff(null)}
                  style={{flexShrink: 0}}
                >
                  <span className={styles.historyMessage}>&larr; Back to commits</span>
                </button>
                <div className={styles.historyDiff}>
                  {selectedDiff.split('\n').map((line, i) => {
                    let cls = '';
                    if (line.startsWith('+') && !line.startsWith('+++')) cls = styles.diffAdd;
                    else if (line.startsWith('-') && !line.startsWith('---')) cls = styles.diffRemove;
                    else if (line.startsWith('@@')) cls = styles.diffHeader;
                    return <div key={i} className={cls}>{line}</div>;
                  })}
                </div>
              </>
            ) : (
              <div className={styles.historyList}>
                {history.length === 0 && (
                  <div style={{padding: 16, textAlign: 'center', color: 'var(--ifm-color-emphasis-400)', fontSize: '0.85rem'}}>
                    No history available
                  </div>
                )}
                {history.map(commit => (
                  <div key={commit.hash} className={styles.historyItem} style={{cursor: 'default'}}>
                    <button
                      style={{all: 'unset', cursor: 'pointer', width: '100%'}}
                      onClick={() => handleViewDiff(commit.hash)}
                    >
                      <span className={styles.historyMessage}>{commit.message}</span>
                      <span className={styles.historyMeta}>
                        {commit.hash} &middot; {commit.author} &middot; {commit.date?.split(' ')[0]}
                      </span>
                    </button>
                    <button
                      className={styles.compareBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCompareWithCurrent(commit.hash);
                      }}
                      title="Compare with current version"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="3" width="8" height="18" rx="1" />
                        <rect x="14" y="3" width="8" height="18" rx="1" />
                      </svg>
                      <span>Compare</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tocOpen && !rawMode && !splitMode && (
          <TableOfContents
            editor={editor}
            onClose={() => setTocOpen(false)}
          />
        )}

        {aiOpen && !rawMode && !splitMode && (
          <AIAssistant
            editor={editor}
            onClose={() => setAiOpen(false)}
          />
        )}

        {mathPreviewOpen && (
          <MathPreviewPanel
            editor={editor}
            rawMode={rawMode || splitMode}
            rawContent={rawContent}
            onClose={() => setMathPreviewOpen(false)}
          />
        )}
      </div>

      {!focusMode && <DocumentStats editor={editor} rawMode={rawMode || splitMode} rawContent={rawContent} />}

      <KeyboardShortcuts
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
    </div>
  );
}
