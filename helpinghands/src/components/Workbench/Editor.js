import React, {useEffect, useMemo, useRef, useState} from 'react';
import clsx from 'clsx';
import CodeMirror from '@uiw/react-codemirror';
import {historyField} from '@codemirror/commands';
import {getOriginalDoc, originalDocChangeEffect, unifiedMergeView} from '@codemirror/merge';
import {ChangeSet, Transaction} from '@codemirror/state';
import {EditorView, keymap} from '@codemirror/view';
import {yCollab, yUndoManagerKeymap} from 'y-codemirror.next';
import {useColorMode} from '@docusaurus/theme-common';
import {changedRange} from '@site/src/server/fs/textDiff';
import {FileIcon} from './Explorer';
import {languageExtensions, languageFor} from './languages';
import {basename, dirname} from './tree';
import {liveSelection, relativeSelection, textStateJSON} from './viewState';
import styles from './styles.module.css';

/**
 * The workbench's editor group: a tab per open file, the active one below.
 * Markdown opens live (liveDocument.js): the editor is bound to the file's
 * shared document, edits merge with everyone else's as they are typed, and
 * there is nothing to save. Other text opens in CodeMirror and is saved on ⌘S;
 * images and PDFs open as previews; anything else can only be downloaded. Text
 * editors mark the lines changed since the file was saved (a live one, since it
 * opened); a save that finds the file changed elsewhere turns its editor into a
 * merge of the user's text with the saved one, and a compare tab shows a file
 * against an earlier revision or a conflicted copy against its file. The
 * workbench owns every tab's state, including where its editor was left
 * (viewState.js): an editor starts from its tab's record and reports every
 * change of selection, text and scroll to it.
 */

/** Scroll a new editor to where it was left, and report where it is scrolled to. */
function followScroll(editor, saved, onView) {
  const top = saved?.scrollTop;
  if (top) editor.requestMeasure({read: () => null, write: () => { editor.scrollDOM.scrollTop = top; }});
  editor.scrollDOM.addEventListener('scroll', () => onView({scrollTop: editor.scrollDOM.scrollTop}));
}

// A tab dragged to another place among the tabs, or into another editor group.
const TAB_TYPE = 'application/x-mochi-editor-tab';

/**
 * Put `editor`'s selection on a search result, `{line, column, length}`, in
 * the middle of the view, as VS Code opens one, then report it reached.
 */
function goTo(editor, {line, column, length}, onGone) {
  const doc = editor.state.doc;
  const at = doc.line(Math.min(Math.max(line, 1), doc.lines));
  const from = Math.min(at.from + column - 1, at.to);
  const to = Math.min(from + length, at.to);
  editor.dispatch({selection: {anchor: from, head: to}, effects: EditorView.scrollIntoView(from, {y: 'center'})});
  editor.focus();
  onGone();
}

const reportCursor = (update, onCursor) => {
  const head = update.state.selection.main.head;
  const line = update.state.doc.lineAt(head);
  onCursor({line: line.number, column: head - line.from + 1});
};

/**
 * A Markdown file bound to its shared document. Its undo history is the
 * document's, so it outlives the editor.
 */
function LiveEditor({tab, saved, readOnly, language, colorMode, goto, onGone, onCursor, onView}) {
  const view = useRef(null);
  useEffect(() => {
    if (view.current && goto?.path === tab.path) goTo(view.current, goto, onGone);
  }, [goto, tab.path, onGone]);
  // The editor starts from the document's text; from then on the binding keeps
  // the two in step. The wrapper copies `value` into the editor only when the
  // prop changes, so it is the same string for the editor's whole life.
  const [initial] = useState(() => tab.live.text.toString());
  const [selection] = useState(() => liveSelection(tab.live.text, saved));
  const extensions = useMemo(() => [
    ...languageExtensions(language),
    yCollab(tab.live.text, null, {undoManager: tab.live.undoManager}),
    keymap.of(yUndoManagerKeymap),
    unifiedMergeView({original: tab.opened, mergeControls: false, gutter: true}),
  ], [language, tab.live, tab.opened]);
  return (
    <CodeMirror
      className={styles.codemirror}
      value={initial}
      selection={selection}
      height="100%"
      theme={colorMode === 'dark' ? 'dark' : 'light'}
      extensions={extensions}
      editable={!readOnly}
      onCreateEditor={editor => {
        view.current = editor;
        followScroll(editor, saved, onView);
      }}
      onUpdate={update => {
        if (!update.selectionSet && !update.docChanged) return;
        reportCursor(update, onCursor);
        onView(relativeSelection(tab.live.text, update.state.selection.main));
      }}
      basicSetup={{highlightActiveLine: true, foldGutter: true, history: false}}
    />
  );
}

/**
 * A text file, compared with its saved text. Text the workbench reads in from
 * elsewhere, including while its tab was hidden, is applied as the one span
 * that differs, outside the undo history, so the cursor and scroll stay where
 * they were; so is a new saved text to the text it is compared with. As in
 * LiveEditor, `value` is only the starting text. In a conflict the saved text
 * is the one saved elsewhere, and each change offers to keep the user's
 * (Accept) or take the saved one (Reject).
 */
function TextEditor({tab, saved, readOnly, language, colorMode, goto, onGone, onChange, onCursor, onView}) {
  const [initial] = useState(() => textStateJSON(saved, tab.text));
  const [original] = useState(tab.saved);
  const extensions = useMemo(
    () => [...languageExtensions(language), unifiedMergeView({original, mergeControls: Boolean(tab.conflict), gutter: true})],
    // The editor is opened again when a conflict starts or ends (TabContent's key).
    [language, original],
  );
  const view = useRef(null);
  useEffect(() => {
    if (view.current && goto?.path === tab.path) goTo(view.current, goto, onGone);
  }, [goto, tab.path, onGone]);
  useEffect(() => {
    const range = view.current && changedRange(view.current.state.doc.toString(), tab.text);
    if (!range) return;
    view.current.dispatch({changes: range, annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)]});
  }, [tab.text]);
  useEffect(() => {
    const current = view.current && getOriginalDoc(view.current.state);
    const range = current && changedRange(current.toString(), tab.saved);
    if (!range) return;
    view.current.dispatch({effects: originalDocChangeEffect(view.current.state, ChangeSet.of(range, current.length))});
  }, [tab.saved]);
  return (
    <CodeMirror
      className={styles.codemirror}
      value={initial.doc}
      initialState={{json: initial, fields: {history: historyField}}}
      height="100%"
      theme={colorMode === 'dark' ? 'dark' : 'light'}
      extensions={extensions}
      editable={!readOnly}
      onCreateEditor={editor => {
        view.current = editor;
        followScroll(editor, saved, onView);
      }}
      // Only the member's own edits: text read in is the tab's already.
      onChange={(value, update) => {
        if (!update.transactions.some(transaction => transaction.annotation(Transaction.remote))) onChange(value);
      }}
      onUpdate={update => {
        if (!update.selectionSet && !update.docChanged) return;
        reportCursor(update, onCursor);
        onView({state: update.state});
      }}
      basicSetup={{highlightActiveLine: true, foldGutter: true}}
    />
  );
}

/** A compare tab: its text, read only, with the text it is compared with above each change; unchanged stretches fold away. */
function CompareEditor({tab, language, colorMode}) {
  const extensions = useMemo(() => [
    ...languageExtensions(language),
    unifiedMergeView({original: tab.original, mergeControls: false, gutter: true, collapseUnchanged: {margin: 3}}),
  ], [language, tab.original]);
  return (
    <CodeMirror
      className={styles.codemirror}
      value={tab.text}
      height="100%"
      theme={colorMode === 'dark' ? 'dark' : 'light'}
      extensions={extensions}
      editable={false}
      basicSetup={{highlightActiveLine: false, foldGutter: false}}
    />
  );
}

function TabContent({tab, saved, readOnly, fileUrl, goto, onGone, onChange, onCursor, onView}) {
  const {colorMode} = useColorMode();
  // A compare tab lies below the file it shows (tree.js comparePath).
  const file = tab.kind === 'diff' ? dirname(tab.path) : tab.path;
  const language = useMemo(() => languageFor(file), [file]);

  if (tab.loading) return <p className={styles.placeholder}>Opening…</p>;
  if (tab.error) return <p className={styles.placeholder}>{tab.error}</p>;
  if (tab.kind === 'diff') return <CompareEditor tab={tab} language={language} colorMode={colorMode} />;
  if (tab.kind === 'live') {
    return <LiveEditor tab={tab} saved={saved} readOnly={readOnly} language={language} colorMode={colorMode} goto={goto} onGone={onGone} onCursor={onCursor} onView={onView} />;
  }
  if (tab.kind === 'image') return <div className={styles.media}><img src={fileUrl(tab.path)} alt={tab.path} /></div>;
  if (tab.kind === 'pdf') return <iframe className={styles.pdf} src={fileUrl(tab.path)} title={tab.path} />;
  if (tab.kind !== 'text') {
    return (
      <div className={styles.placeholder}>
        <p>{tab.kind === 'large' ? 'This file is too large to edit here.' : 'This file is not text, so it cannot be shown here.'}</p>
        <a className="button button--secondary button--sm" href={fileUrl(tab.path, {download: true})}>Download</a>
      </div>
    );
  }
  return (
    <TextEditor
      tab={tab}
      saved={saved}
      readOnly={readOnly}
      language={language}
      colorMode={colorMode}
      goto={goto}
      onGone={onGone}
      onChange={onChange}
      onCursor={onCursor}
      onView={onView}
    />
  );
}

/** What the status line says about the open file, and the tone of its dot. */
function statusOf(tab, dirty) {
  if (tab.kind === 'live') {
    const status = tab.liveStatus;
    if (!status) return null;
    if (status.state === 'offline') return {tone: 'warning', label: status.waiting ? 'Offline: edits saved on this computer' : 'Offline'};
    if (status.state === 'saving') return {tone: 'pending', label: 'Saving…'};
    if (status.state.startsWith('error: ')) return {tone: 'danger', label: status.state.slice('error: '.length)};
    return {tone: 'saved', label: 'All changes saved'};
  }
  if (tab.kind !== 'text') return null;
  if (tab.saving) return {tone: 'pending', label: 'Saving…'};
  if (dirty) return {tone: 'warning', label: 'Unsaved changes'};
  return {tone: 'saved', label: 'Saved'};
}

const TONES = {saved: styles.toneSaved, pending: styles.tonePending, warning: styles.toneWarning, danger: styles.toneDanger};

export default function Editor({
  group = 0, tabs, activePath, readOnly, fileUrl, appLink = () => null, viewOf, goto = null, onGone = () => {},
  onActivate, onPin, onClose, onTabMenu, onMoveTab, onReveal, onChange, onView, onSave, onSaveAsNew, onDiscard, onRestore,
}) {
  const [cursor, setCursor] = useState(null);
  const [dropBefore, setDropBefore] = useState(undefined);
  const tab = tabs.find(item => item.path === activePath);
  useEffect(() => setCursor(null), [activePath]);

  // Tabs take a dragged tab before the one under the pointer, or at the end over the strip after them.
  const dropProps = before => ({
    onDragOver: event => {
      if (!event.dataTransfer.types.includes(TAB_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropBefore(before);
    },
    onDragLeave: () => setDropBefore(undefined),
    onDrop: event => {
      if (!event.dataTransfer.types.includes(TAB_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropBefore(undefined);
      const {from, path} = JSON.parse(event.dataTransfer.getData(TAB_TYPE));
      if (path !== before) onMoveTab(from, path, before);
    },
  });

  if (!tabs.length) {
    return (
      <div className={styles.welcome}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.5h6l2 2h10v11H3z" /></svg>
        <h2>Your filesystem</h2>
        <p>Open a file from the sidebar to view or edit it.</p>
        <dl>
          <dt>Find a file</dt><dd><kbd>⌘</kbd><kbd>P</kbd></dd>
          <dt>Search in files</dt><dd><kbd>⌘</kbd><kbd>⇧</kbd><kbd>F</kbd></dd>
          <dt>Split the editor</dt><dd><kbd>⌘</kbd><kbd>\</kbd></dd>
          <dt>Save</dt><dd><kbd>⌘</kbd><kbd>S</kbd></dd>
          <dt>Rename</dt><dd><kbd>F2</kbd></dd>
          <dt>Delete</dt><dd><kbd>Delete</kbd></dd>
          <dt>Copy, cut, paste</dt><dd><kbd>⌘</kbd><kbd>C</kbd> <kbd>⌘</kbd><kbd>X</kbd> <kbd>⌘</kbd><kbd>V</kbd></dd>
          <dt>Undo a file change</dt><dd><kbd>⌘</kbd><kbd>Z</kbd></dd>
          <dt>Upload</dt><dd>Drop files on a folder</dd>
          <dt>More actions</dt><dd>Right-click a file</dd>
        </dl>
      </div>
    );
  }

  const dirty = item => item.kind === 'text' && item.text !== item.saved;
  const link = appLink(tab.path);
  const status = statusOf(tab, dirty(tab));
  return (
    <div className={styles.editor}>
      <div className={clsx(styles.tabs, dropBefore === null && styles.tabsDrop)} role="tablist" {...dropProps(null)}>
        {tabs.map(item => (
          <div
            key={item.path}
            role="tab"
            aria-selected={item.path === activePath}
            className={clsx(
              styles.tab,
              item.path === activePath && styles.tabActive,
              item.preview && styles.tabPreview,
              dropBefore === item.path && styles.tabDrop,
            )}
            title={item.preview ? `${item.path} (preview: double-click to keep it open)` : item.path}
            draggable
            onDragStart={event => {
              event.dataTransfer.setData(TAB_TYPE, JSON.stringify({from: group, path: item.path}));
              event.dataTransfer.effectAllowed = 'move';
            }}
            {...dropProps(item.path)}
            onClick={() => onActivate(item.path)}
            onDoubleClick={() => onPin(item.path)}
            onContextMenu={event => onTabMenu(event, item.path)}
            onAuxClick={event => { if (event.button === 1) onClose(item.path); }}
          >
            <FileIcon name={item.kind === 'diff' ? dirname(item.path) : item.path} />
            <span className={styles.tabName}>{item.title ?? basename(item.path)}</span>
            {(item.changedElsewhere || item.deleted) && (
              <span className={styles.tabElsewhere}>{item.deleted ? 'Deleted elsewhere' : 'Changed elsewhere'}</span>
            )}
            <button
              type="button"
              className={clsx(styles.tabClose, dirty(item) && styles.tabDirty)}
              aria-label={`Close ${basename(item.path)}`}
              onClick={event => { event.stopPropagation(); onClose(item.path); }}
            />
          </div>
        ))}
      </div>
      <div className={styles.breadcrumbs}>
        <ol>
          {tab.kind === 'diff'
            ? <li className={styles.crumbCurrent}>{tab.title}</li>
            : tab.path.split('/').map((part, index, parts) => (
              <li key={index} className={clsx(index === parts.length - 1 && styles.crumbCurrent)}>
                <button type="button" title="Reveal in the explorer" onClick={() => onReveal(parts.slice(0, index + 1).join('/'))}>{part}</button>
              </li>
            ))}
        </ol>
        {link && <a className={styles.appLink} href={link.href}>Open in {link.title}</a>}
      </div>
      {tab.deleted && (
        <div className={styles.elsewhereBar} role="alert">
          <span>Deleted elsewhere. Your unsaved edits are only in this tab.</span>
          <button type="button" className="button button--primary button--sm" onClick={() => onSaveAsNew(tab.path)}>Save as new</button>
          <button type="button" className="button button--secondary button--sm" onClick={() => onDiscard(tab.path)}>Discard</button>
        </div>
      )}
      {tab.conflict && (
        <div className={styles.elsewhereBar} role="alert">
          <span>Changed elsewhere while you edited it. Above each of your changes, in red, is the saved text: Accept keeps yours, Reject takes the saved one.</span>
          <button type="button" className="button button--primary button--sm" onClick={() => onSave(tab.path)}>Save merged</button>
        </div>
      )}
      {tab.kind === 'diff' && tab.restorable && !readOnly && (
        <div className={clsx(styles.elsewhereBar, styles.compareBar)}>
          <span>Red lines are this revision&apos;s, green lines the file&apos;s now.</span>
          <button type="button" className="button button--secondary button--sm" onClick={() => onRestore(tab.path)}>Restore this version</button>
        </div>
      )}
      <div className={styles.editorBody}>
        <TabContent
          key={`${tab.path}${tab.conflict ? ':conflict' : ''}`}
          tab={tab}
          saved={viewOf(tab.path)}
          readOnly={readOnly}
          fileUrl={fileUrl}
          goto={goto}
          onGone={onGone}
          onChange={text => onChange(tab.path, text)}
          onCursor={setCursor}
          onView={patch => onView(tab.path, patch)}
        />
      </div>
      <div className={styles.statusBar}>
        <span className={styles.statusLeft}>
          {status && <span className={clsx(styles.statusDot, TONES[status.tone])} aria-hidden="true" />}
          {status?.label}
        </span>
        <span className={styles.statusRight}>
          {(tab.kind === 'text' || tab.kind === 'live') && cursor && <span>Ln {cursor.line}, Col {cursor.column}</span>}
          {(tab.kind === 'text' || tab.kind === 'live') && <span>{languageFor(tab.path).name}</span>}
          {readOnly && <span>Read only</span>}
        </span>
      </div>
    </div>
  );
}
