import React, {useEffect, useMemo, useRef, useState} from 'react';
import clsx from 'clsx';
import CodeMirror from '@uiw/react-codemirror';
import {historyField} from '@codemirror/commands';
import {Transaction} from '@codemirror/state';
import {keymap} from '@codemirror/view';
import {yCollab, yUndoManagerKeymap} from 'y-codemirror.next';
import {useColorMode} from '@docusaurus/theme-common';
import {changedRange} from '@site/src/server/fs/textDiff';
import {languageFor} from './languages';
import {basename} from './tree';
import {liveSelection, relativeSelection, textStateJSON} from './viewState';
import styles from './styles.module.css';

/**
 * The workbench's editor group: a tab per open file, the active one below.
 * Markdown opens live (liveDocument.js): the editor is bound to the file's
 * shared document, edits merge with everyone else's as they are typed, and
 * there is nothing to save. Other text opens in CodeMirror and is saved on ⌘S;
 * images and PDFs open as previews; anything else can only be downloaded. The
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

const reportCursor = (update, onCursor) => {
  const head = update.state.selection.main.head;
  const line = update.state.doc.lineAt(head);
  onCursor({line: line.number, column: head - line.from + 1});
};

/**
 * A Markdown file bound to its shared document. Its undo history is the
 * document's, so it outlives the editor.
 */
function LiveEditor({tab, saved, readOnly, language, colorMode, onCursor, onView}) {
  // The editor starts from the document's text; from then on the binding keeps
  // the two in step. The wrapper copies `value` into the editor only when the
  // prop changes, so it is the same string for the editor's whole life.
  const [initial] = useState(() => tab.live.text.toString());
  const [selection] = useState(() => liveSelection(tab.live.text, saved));
  const extensions = useMemo(() => [
    ...language.extensions,
    yCollab(tab.live.text, null, {undoManager: tab.live.undoManager}),
    keymap.of(yUndoManagerKeymap),
  ], [language, tab.live]);
  return (
    <CodeMirror
      className={styles.codemirror}
      value={initial}
      selection={selection}
      height="100%"
      theme={colorMode === 'dark' ? 'dark' : 'light'}
      extensions={extensions}
      editable={!readOnly}
      onCreateEditor={editor => followScroll(editor, saved, onView)}
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
 * A text file. Text the workbench reads in from elsewhere, including while its
 * tab was hidden, is applied as the one span that differs, outside the undo
 * history, so the cursor and scroll stay where they were. As in LiveEditor,
 * `value` is only the starting text.
 */
function TextEditor({tab, saved, readOnly, language, colorMode, onChange, onCursor, onView}) {
  const [initial] = useState(() => textStateJSON(saved, tab.text));
  const view = useRef(null);
  useEffect(() => {
    const range = view.current && changedRange(view.current.state.doc.toString(), tab.text);
    if (!range) return;
    view.current.dispatch({changes: range, annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)]});
  }, [tab.text]);
  return (
    <CodeMirror
      className={styles.codemirror}
      value={initial.doc}
      initialState={{json: initial, fields: {history: historyField}}}
      height="100%"
      theme={colorMode === 'dark' ? 'dark' : 'light'}
      extensions={language.extensions}
      editable={!readOnly}
      onCreateEditor={editor => {
        view.current = editor;
        followScroll(editor, saved, onView);
      }}
      onChange={onChange}
      onUpdate={update => {
        if (!update.selectionSet && !update.docChanged) return;
        reportCursor(update, onCursor);
        onView({state: update.state});
      }}
      basicSetup={{highlightActiveLine: true, foldGutter: true}}
    />
  );
}

function TabContent({tab, saved, readOnly, fileUrl, onChange, onCursor, onView}) {
  const {colorMode} = useColorMode();
  const language = useMemo(() => languageFor(tab.path), [tab.path]);

  if (tab.loading) return <p className={styles.placeholder}>Opening…</p>;
  if (tab.error) return <p className={styles.placeholder}>{tab.error}</p>;
  if (tab.kind === 'live') {
    return <LiveEditor tab={tab} saved={saved} readOnly={readOnly} language={language} colorMode={colorMode} onCursor={onCursor} onView={onView} />;
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
  return <TextEditor tab={tab} saved={saved} readOnly={readOnly} language={language} colorMode={colorMode} onChange={onChange} onCursor={onCursor} onView={onView} />;
}

function liveLabel(status) {
  if (!status) return '';
  if (status.state === 'offline') return status.waiting ? 'Offline: edits saved on this computer' : 'Offline';
  if (status.state === 'saving') return 'Saving…';
  if (status.state.startsWith('error: ')) return status.state.slice('error: '.length);
  return 'All changes saved';
}

export default function Editor({
  tabs, activePath, readOnly, fileUrl, appLink = () => null, viewOf, onActivate, onClose, onChange, onView, onSaveAsNew, onDiscard,
}) {
  const [cursor, setCursor] = useState(null);
  const tab = tabs.find(item => item.path === activePath);
  useEffect(() => setCursor(null), [activePath]);

  if (!tabs.length) {
    return (
      <div className={styles.welcome}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6l2 2h8v14H4z" /></svg>
        <h2>Your workspace</h2>
        <p>Open a file from the explorer to view or edit it.</p>
        <dl>
          <dt>Save</dt><dd><kbd>⌘</kbd> <kbd>S</kbd></dd>
          <dt>Rename</dt><dd><kbd>F2</kbd></dd>
          <dt>Delete</dt><dd><kbd>Delete</kbd></dd>
          <dt>More actions</dt><dd>Right-click in the explorer</dd>
        </dl>
      </div>
    );
  }

  const dirty = item => item.kind === 'text' && item.text !== item.saved;
  return (
    <div className={styles.editor}>
      <div className={styles.tabs} role="tablist">
        {tabs.map(item => (
          <div
            key={item.path}
            role="tab"
            aria-selected={item.path === activePath}
            className={clsx(styles.tab, item.path === activePath && styles.tabActive)}
            title={item.path}
            onClick={() => onActivate(item.path)}
            onAuxClick={event => { if (event.button === 1) onClose(item.path); }}
          >
            <span className={styles.tabName}>{basename(item.path)}</span>
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
        {tab.path.split('/').join(' › ')}
        {appLink(tab.path) && (
          <a className={styles.appLink} href={appLink(tab.path).href}>Open in {appLink(tab.path).title}</a>
        )}
      </div>
      {tab.deleted && (
        <div className={styles.elsewhereBar} role="alert">
          <span>Deleted elsewhere. Your unsaved edits are only in this tab.</span>
          <button type="button" className="button button--primary button--sm" onClick={() => onSaveAsNew(tab.path)}>Save as new</button>
          <button type="button" className="button button--secondary button--sm" onClick={() => onDiscard(tab.path)}>Discard</button>
        </div>
      )}
      <div className={styles.editorBody}>
        <TabContent
          key={tab.path}
          tab={tab}
          saved={viewOf(tab.path)}
          readOnly={readOnly}
          fileUrl={fileUrl}
          onChange={text => onChange(tab.path, text)}
          onCursor={setCursor}
          onView={patch => onView(tab.path, patch)}
        />
      </div>
      <div className={styles.statusBar}>
        <span>{tab.kind === 'live' ? liveLabel(tab.liveStatus) : tab.saving ? 'Saving…' : dirty(tab) ? 'Unsaved changes' : tab.kind === 'text' ? 'Saved' : ''}</span>
        <span className={styles.statusRight}>
          {(tab.kind === 'text' || tab.kind === 'live') && cursor && <span>Ln {cursor.line}, Col {cursor.column}</span>}
          {(tab.kind === 'text' || tab.kind === 'live') && <span>{languageFor(tab.path).name}</span>}
          {readOnly && <span>Read only</span>}
        </span>
      </div>
    </div>
  );
}
