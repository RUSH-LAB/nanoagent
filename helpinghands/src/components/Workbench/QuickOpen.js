import React, {useEffect, useMemo, useRef, useState} from 'react';
import clsx from 'clsx';
import Highlight from '@site/src/components/Highlight';
import {basename, dirname, quickOpenRows} from './tree';
import styles from './styles.module.css';

// More rows than this is a directory listing, not a pick; typing narrows it.
const ROW_LIMIT = 50;

/**
 * ⌘P: pick a file by typing part of its path. Each row is the file's name,
 * then its folder dimmed, with the typed characters marked. An empty query
 * offers the files opened most recently first.
 */
export default function QuickOpen({files, recent, onPick, onClose}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef(null);
  const rows = useMemo(() => quickOpenRows(files, recent, query.trim()).slice(0, ROW_LIMIT), [files, recent, query]);

  useEffect(() => { list.current?.children[active]?.scrollIntoView({block: 'nearest'}); }, [active]);

  const onKeyDown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(current => Math.min(Math.max(current + step, 0), rows.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (rows[active]) onPick(rows[active].file);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className={styles.quickOpenOverlay} onMouseDown={onClose}>
      <div className={styles.quickOpen} onMouseDown={event => event.stopPropagation()}>
        <input
          autoFocus
          className={styles.quickOpenInput}
          placeholder="Search files by name"
          value={query}
          onChange={event => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        <ul ref={list} className={styles.quickOpenList} role="listbox">
          {rows.map(({file, indices}, index) => {
            const folder = dirname(file.path);
            const nameStart = folder ? folder.length + 1 : 0;
            return (
              <li
                key={file.path}
                role="option"
                aria-selected={index === active}
                className={clsx(styles.quickOpenRow, index === active && styles.rowActive)}
                onMouseEnter={() => setActive(index)}
                onClick={() => onPick(file)}
              >
                <span className={styles.rowName}>
                  <Highlight text={basename(file.path)} indices={indices.filter(i => i >= nameStart).map(i => i - nameStart)} />
                </span>
                {folder && (
                  <span className={styles.quickOpenFolder}>
                    <Highlight text={folder} indices={indices.filter(i => i < folder.length)} />
                  </span>
                )}
              </li>
            );
          })}
          {rows.length === 0 && <li className={styles.emptyTree}>No matching files.</li>}
        </ul>
      </div>
    </div>
  );
}
