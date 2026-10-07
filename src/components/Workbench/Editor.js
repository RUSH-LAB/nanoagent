import React, {useEffect, useMemo, useState} from 'react';
import clsx from 'clsx';
import CodeMirror from '@uiw/react-codemirror';
import {useColorMode} from '@docusaurus/theme-common';
import {languageFor} from './languages';
import {basename} from './tree';
import styles from './styles.module.css';

/**
 * The workbench's editor group: a tab per open file, the active one below.
 * Text opens in CodeMirror (the workbench saves it on ⌘S); images and PDFs open as previews;
 * anything else can only be downloaded. The workbench owns every tab's state.
 */

function TabContent({tab, readOnly, fileUrl, onChange, onCursor}) {
  const {colorMode} = useColorMode();
  const language = useMemo(() => languageFor(tab.path), [tab.path]);

  if (tab.loading) return <p className={styles.placeholder}>Opening…</p>;
  if (tab.error) return <p className={styles.placeholder}>{tab.error}</p>;
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
    <CodeMirror
      className={styles.codemirror}
      value={tab.text}
      height="100%"
      theme={colorMode === 'dark' ? 'dark' : 'light'}
      extensions={language.extensions}
      editable={!readOnly}
      onChange={onChange}
      onUpdate={update => {
        if (!update.selectionSet && !update.docChanged) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        onCursor({line: line.number, column: head - line.from + 1});
      }}
      basicSetup={{highlightActiveLine: true, foldGutter: true}}
    />
  );
}

export default function Editor({tabs, activePath, readOnly, fileUrl, onActivate, onClose, onChange}) {
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
            <button
              type="button"
              className={clsx(styles.tabClose, dirty(item) && styles.tabDirty)}
              aria-label={`Close ${basename(item.path)}`}
              onClick={event => { event.stopPropagation(); onClose(item.path); }}
            />
          </div>
        ))}
      </div>
      <div className={styles.breadcrumbs}>{tab.path.split('/').join(' › ')}</div>
      <div className={styles.editorBody}>
        <TabContent
          key={tab.path}
          tab={tab}
          readOnly={readOnly}
          fileUrl={fileUrl}
          onChange={text => onChange(tab.path, text)}
          onCursor={setCursor}
        />
      </div>
      <div className={styles.statusBar}>
        <span>{tab.saving ? 'Saving…' : dirty(tab) ? 'Unsaved changes' : tab.kind === 'text' ? 'Saved' : ''}</span>
        <span className={styles.statusRight}>
          {tab.kind === 'text' && cursor && <span>Ln {cursor.line}, Col {cursor.column}</span>}
          {tab.kind === 'text' && <span>{languageFor(tab.path).name}</span>}
          {readOnly && <span>Read only</span>}
        </span>
      </div>
    </div>
  );
}
