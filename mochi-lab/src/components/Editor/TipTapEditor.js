import React, {useEffect, useState, useCallback} from 'react';
import {useEditor, EditorContent} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import {Markdown} from 'tiptap-markdown';
import styles from './styles.module.css';

const API_BASE = 'http://localhost:3001';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_RE);
  if (match) {
    return {frontmatter: match[0], body: content.slice(match[0].length)};
  }
  return {frontmatter: '', body: content};
}

function ToolbarButton({active, onClick, title, children}) {
  return (
    <button
      className={`${styles.toolbarBtn} ${active ? styles.toolbarBtnActive : ''}`}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

function Toolbar({editor}) {
  if (!editor) return null;

  return (
    <div className={styles.toolbar}>
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
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title="Horizontal rule"
        >---</ToolbarButton>
      </div>
    </div>
  );
}

export default function TipTapEditor({filePath, onSaveStatus}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [rawContent, setRawContent] = useState('');
  const [frontmatter, setFrontmatter] = useState('');

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {levels: [1, 2, 3, 4]},
      }),
      Placeholder.configure({
        placeholder: 'Start writing...',
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
    onUpdate: () => {
      setDirty(true);
    },
    editorProps: {
      attributes: {
        class: styles.proseMirror,
      },
    },
  });

  useEffect(() => {
    if (!filePath || !editor) return;
    setLoading(true);
    setError(null);
    setDirty(false);

    fetch(`${API_BASE}/api/file?path=${encodeURIComponent(filePath)}`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load');
        return res.json();
      })
      .then(data => {
        const {frontmatter: fm, body} = parseFrontmatter(data.content);
        setFrontmatter(fm);
        setRawContent(data.content);
        editor.commands.setContent(body);
        setLoading(false);
        setDirty(false);
      })
      .catch(() => {
        setError('Failed to load file. Is the editor server running? (npm start)');
        setLoading(false);
      });
  }, [filePath, editor]);

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
    try {
      const content = rawMode ? rawContent : getFullContent();
      const res = await fetch(`${API_BASE}/api/file`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: filePath, content}),
      });
      if (!res.ok) throw new Error('Save failed');
      setDirty(false);
      onSaveStatus?.('saved');
      setTimeout(() => onSaveStatus?.(null), 2000);
    } catch {
      setError('Failed to save');
      onSaveStatus?.('error');
    } finally {
      setSaving(false);
    }
  }, [filePath, saving, rawMode, rawContent, getFullContent, onSaveStatus]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (dirty) handleSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleSave, dirty]);

  const toggleRawMode = useCallback(() => {
    if (rawMode) {
      const {frontmatter: fm, body} = parseFrontmatter(rawContent);
      setFrontmatter(fm);
      editor?.commands.setContent(body);
    } else {
      setRawContent(getFullContent());
    }
    setRawMode(!rawMode);
  }, [rawMode, rawContent, editor, getFullContent]);

  if (!filePath) {
    return (
      <div className={styles.emptyState}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.3">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
        <p>Select a file to start editing</p>
      </div>
    );
  }

  return (
    <div className={styles.editorContainer}>
      <div className={styles.editorHeader}>
        <span className={styles.filePath}>{filePath}</span>
        <div className={styles.editorActions}>
          {dirty && <span className={styles.unsaved}>Unsaved</span>}
          <button
            className={`${styles.modeToggle} ${rawMode ? styles.modeToggleActive : ''}`}
            onClick={toggleRawMode}
            title="Toggle raw markdown"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
            </svg>
            {rawMode ? 'Rich' : 'Source'}
          </button>
          <button
            className={styles.saveBtn}
            onClick={handleSave}
            disabled={saving || !dirty}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {loading ? (
        <div className={styles.loading}>Loading...</div>
      ) : rawMode ? (
        <textarea
          className={styles.rawTextarea}
          value={rawContent}
          onChange={(e) => {
            setRawContent(e.target.value);
            setDirty(true);
          }}
          spellCheck={false}
        />
      ) : (
        <div className={styles.editorWrap}>
          <Toolbar editor={editor} />
          <div className={styles.editorScroll}>
            <EditorContent editor={editor} />
          </div>
        </div>
      )}
    </div>
  );
}
