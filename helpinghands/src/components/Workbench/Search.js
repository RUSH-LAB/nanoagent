import React, {useEffect, useRef, useState} from 'react';
import clsx from 'clsx';
import {apiRequest} from '@site/src/utils/api';
import {clientPlatform} from '@site/src/platform/client';
import {replaceAll} from '@site/src/server/fs/textSearch';
import {toast} from '@site/src/components/Toast/toast';
import * as api from './api';
import {FileIcon} from './Explorer';
import {basename, dirname} from './tree';
import styles from './styles.module.css';

/**
 * Search across the workspace's files, as VS Code's Search view (⌘⇧F): what
 * is typed is found, as it is typed, in every text file the member may read
 * (GET /api/fs/search, fs/textSearch.js), case and whole words as asked, the
 * results by file. A result opens its file with the match selected. Replace
 * writes each file again with every match replaced, after asking, skipping a
 * file whose open tab has unsaved edits; `onReplaced` hears what each file
 * held before, so ⌘Z can put it back.
 */

const DELAY_MS = 250;

function Toggle({label, title, on, onChange}) {
  return (
    <button type="button" className={clsx(styles.searchToggle, on && styles.searchToggleOn)} title={title} aria-pressed={on} onClick={() => onChange(!on)}>
      {label}
    </button>
  );
}

// How much of a result's line shows before its match; more is cut to an ellipsis, so the match is in view.
const LEAD = 24;

/** A result's line, the match marked. */
function Preview({match}) {
  const start = match.column - 1 - match.cut;
  const text = match.preview;
  const lead = text.slice(0, start).trimStart();
  return (
    <span className={styles.searchPreview}>
      {lead.length > LEAD ? `…${lead.slice(-LEAD)}` : lead}
      <mark>{text.slice(start, start + match.length)}</mark>
      {text.slice(start + match.length)}
    </span>
  );
}

export default function Search({focusKey, readOnly, dirtyPaths, onOpen, onReplaced}) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [found, setFound] = useState(null);
  const [error, setError] = useState(null);
  const [closed, setClosed] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  // The answer to the newest search only.
  const asked = useRef(0);

  // ⌘⇧F (a new `focusKey`) puts the cursor in the query, all of it selected.
  useEffect(() => {
    if (!focusKey) return;
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);

  const search = async () => {
    const ask = ++asked.current;
    if (!query) {
      setFound(null);
      setError(null);
      return;
    }
    const params = new URLSearchParams({q: query, ...(matchCase ? {case: '1'} : {}), ...(wholeWord ? {word: '1'} : {})});
    try {
      const result = await apiRequest(`/api/fs/search?${params}`, undefined, {failureLabel: 'Could not search the workspace'});
      if (ask !== asked.current) return;
      setFound(result);
      setError(null);
    } catch (searchError) {
      if (ask === asked.current) setError(searchError.message);
    }
  };

  useEffect(() => {
    const timer = setTimeout(search, DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, matchCase, wholeWord]);

  const options = {matchCase, wholeWord};
  const count = found?.files.reduce((sum, file) => sum + file.matches.length, 0) ?? 0;

  // Every match of `files` replaced, each file written over the revision it was read at.
  const replaceIn = async files => {
    const skipped = files.filter(file => dirtyPaths.has(file.path)).map(file => file.path);
    const targets = files.filter(file => !dirtyPaths.has(file.path));
    const total = targets.reduce((sum, file) => sum + file.matches.length, 0);
    if (!targets.length) {
      toast.info(`Save or discard your edits to ${skipped.map(basename).join(', ')} first.`);
      return;
    }
    const where = targets.length === 1 ? targets[0].path : `${targets.length} files`;
    if (!(await clientPlatform.dialogs.confirm(`Replace ${total} ${total === 1 ? 'match' : 'matches'} of “${query}” in ${where} with “${replacement}”?`))) return;
    setBusy(true);
    const changed = [];
    let replaced = 0;
    try {
      for (const file of targets) {
        const read = await api.readFile(file.path);
        if (read.binary) continue;
        const result = replaceAll(read.text, query, replacement, options);
        if (!result.count) continue;
        const written = await api.saveFile(file.path, result.text, {baseRev: read.rev});
        changed.push({path: file.path, before: read.text, rev: written.rev});
        replaced += result.count;
      }
    } catch (replaceError) {
      toast.error(replaceError.message);
    }
    setBusy(false);
    if (changed.length) {
      onReplaced(changed, `replacing “${query}”`);
      toast.success(`Replaced ${replaced} ${replaced === 1 ? 'match' : 'matches'} in ${changed.length} ${changed.length === 1 ? 'file' : 'files'}`
        + (skipped.length ? `; skipped ${skipped.map(basename).join(', ')}, which have unsaved edits` : ''));
    }
    search();
  };

  return (
    <div className={styles.search}>
      <div className={styles.searchFields}>
        <button
          type="button"
          className={styles.searchExpand}
          title={replacing ? 'Hide Replace' : 'Show Replace'}
          aria-expanded={replacing}
          disabled={readOnly}
          onClick={() => setReplacing(value => !value)}
        >
          <svg className={clsx(styles.icon, styles.chevron, replacing && styles.chevronOpen)} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
        </button>
        <div className={styles.searchInputs}>
          <div className={styles.searchField}>
            <input
              ref={input}
              value={query}
              placeholder="Search"
              aria-label="Search"
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') search(); }}
            />
            <Toggle label="Aa" title="Match Case" on={matchCase} onChange={setMatchCase} />
            <Toggle label={<u>ab</u>} title="Match Whole Word" on={wholeWord} onChange={setWholeWord} />
          </div>
          {replacing && (
            <div className={styles.searchField}>
              <input
                value={replacement}
                placeholder="Replace"
                aria-label="Replace"
                onChange={event => setReplacement(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter' && found?.files.length) replaceIn(found.files); }}
              />
              <button
                type="button"
                className={styles.searchToggle}
                title="Replace All"
                disabled={busy || !found?.files.length}
                onClick={() => replaceIn(found.files)}
              >
                All
              </button>
            </div>
          )}
        </div>
      </div>
      {error && <p className={styles.loadError}>{error}</p>}
      {found && (
        <p className={styles.searchSummary}>
          {count
            ? `${count}${found.truncated ? '+' : ''} ${count === 1 ? 'result' : 'results'} in ${found.files.length} ${found.files.length === 1 ? 'file' : 'files'}`
            : 'No results found.'}
          {found.truncated && ' Only the first results are shown; search for something narrower.'}
        </p>
      )}
      <div className={styles.searchResults} role="tree" aria-label="Search results">
        {found?.files.map(file => {
          const open = !closed.has(file.path);
          return (
            <div key={file.path} role="treeitem" aria-expanded={open}>
              <div
                className={clsx(styles.row, styles.searchFile)}
                title={file.path}
                onClick={() => setClosed(current => {
                  const next = new Set(current);
                  if (open) next.add(file.path);
                  else next.delete(file.path);
                  return next;
                })}
              >
                <svg className={clsx(styles.icon, styles.chevron, open && styles.chevronOpen)} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
                <FileIcon name={file.path} />
                <span className={styles.rowName}>{basename(file.path)}</span>
                <span className={styles.searchFolder}>{dirname(file.path)}</span>
                <span className={styles.rowMeta}>
                  {replacing && !readOnly && (
                    <button
                      type="button"
                      className={styles.textButton}
                      title={`Replace in ${basename(file.path)}`}
                      disabled={busy}
                      onClick={event => { event.stopPropagation(); replaceIn([file]); }}
                    >
                      Replace
                    </button>
                  )}
                  <span className={styles.explorerCount}>{file.matches.length}</span>
                </span>
              </div>
              {open && file.matches.map(match => (
                <div
                  key={`${match.line}:${match.column}`}
                  className={clsx(styles.row, styles.searchMatch)}
                  title={`Line ${match.line}`}
                  onClick={() => onOpen(file.path, {line: match.line, column: match.column, length: match.length})}
                >
                  <Preview match={match} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
