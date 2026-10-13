import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import Link from '@docusaurus/Link';
import {useHistory, useLocation} from '@docusaurus/router';
import {useContentSearch} from '@site/src/hooks/useContentSearch';
import SearchResults, {
  SEARCH_INPUT_PROPS, SearchIcon, flattenResults, searchFailures,
} from '@site/src/components/SearchResults';
import {scopeWorkspacePath} from '@site/src/utils/workspaces';
import styles from './styles.module.css';

/**
 * Search without leaving the page.
 *
 * Searching is a lookup, not a destination: you are reading something, you
 * want the other document, and the page you were on should still be there when
 * you have it. So the navbar opens this over the page instead of navigating to
 * the search page, which stays for a `?q=` link somebody shares or bookmarks.
 *
 * Mounted once, in the theme Layout next to the command palette, and opened by
 * an event so anything can ask for it without a provider: the navbar's button
 * (components/SearchTrigger) and the `/` key both call `openSearchDialog`.
 *
 * `/` rather than Cmd+K, which already belongs to the command palette: that
 * one goes to a page, this one looks inside them.
 */

const OPEN_EVENT = 'mochi:open-search';

/** Open the search dialog, from anywhere, with no provider to wire up. */
export function openSearchDialog() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

/** Whether a keystroke is somebody typing rather than reaching for a shortcut. */
function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export default function SearchDialog() {
  const history = useHistory();
  const {pathname} = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState(null);
  const inputRef = useRef(null);
  const resultsRef = useRef(null);
  const answer = useContentSearch(open ? query : '');
  const rows = useMemo(() => flattenResults(answer.groups), [answer.groups]);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);

  /* `/` opens it, Escape closes it, and typing a slash into a field is typing. */
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape' && open) {
        setOpen(false);
        return;
      }
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (open || isTyping(event.target)) return;
      event.preventDefault();
      setOpen(true);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  /* A fresh search each time it opens, with the caret already in the field. */
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveKey(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  /* Searching is a lookup over the page you are on; leaving the page ends it. */
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  /* The first row is selected as results arrive, and stays selected while it
     survives the next keystroke's results. */
  useEffect(() => {
    setActiveKey(previous => (
      rows.some(row => row.key === previous) ? previous : rows[0]?.key ?? null
    ));
  }, [rows]);

  useEffect(() => {
    if (!activeKey || !resultsRef.current) return;
    resultsRef.current
      .querySelector(`[data-search-row="${CSS.escape(activeKey)}"]`)
      ?.scrollIntoView({block: 'nearest'});
  }, [activeKey]);

  const step = useCallback(delta => {
    if (rows.length === 0) return;
    const index = rows.findIndex(row => row.key === activeKey);
    const next = Math.min(Math.max((index === -1 ? 0 : index) + delta, 0), rows.length - 1);
    setActiveKey(rows[next].key);
  }, [rows, activeKey]);

  const onInputKeyDown = useCallback(event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      step(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows.find(item => item.key === activeKey);
      if (row) {
        setOpen(false);
        history.push(row.href);
      }
    }
  }, [step, rows, activeKey, history]);

  if (!open) return null;

  const searching = query.trim().length > 0;
  const pageHref = `${scopeWorkspacePath('/content-search', pathname)}${
    searching ? `?q=${encodeURIComponent(query.trim())}` : ''}`;

  return (
    <div className={styles.overlay} onClick={close} role="presentation">
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Search this workspace"
        onClick={event => event.stopPropagation()}>
        <div className={styles.inputRow}>
          <SearchIcon className={styles.inputIcon} />
          <input
            ref={inputRef}
            {...SEARCH_INPUT_PROPS}
            className={styles.input}
            role="searchbox"
            placeholder="Search documents, text and references…"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          {answer.loading && <span className={styles.spinner} aria-label="Searching" />}
        </div>

        <div className={styles.body} ref={resultsRef}>
          {!answer.scoped && (
            <p className={styles.note}>Open a workspace to search its content.</p>
          )}
          {answer.errors.length > 0 && (
            <p className={styles.error}>{searchFailures(answer.errors)}</p>
          )}
          {answer.groups.length > 0 && (
            <SearchResults
              groups={answer.groups}
              query={answer.query}
              activeKey={activeKey}
              onHover={setActiveKey}
              onOpen={close}
            />
          )}
          {answer.scoped && searching && !answer.loading && answer.groups.length === 0 && (
            <p className={styles.note}>Nothing matches “{answer.query}”.</p>
          )}
          {answer.scoped && !searching && (
            <p className={styles.note}>Type to search this workspace&rsquo;s documents, their text, and its references.</p>
          )}
        </div>

        <div className={styles.footer}>
          <span className={styles.hints}>
            <kbd className={styles.kbd}>&uarr;</kbd>
            <kbd className={styles.kbd}>&darr;</kbd>
            to move
            <kbd className={styles.kbd}>&crarr;</kbd>
            to open
            <kbd className={styles.kbd}>esc</kbd>
            to close
          </span>
          <Link className={styles.pageLink} to={pageHref} onClick={close}>
            Full search page
          </Link>
        </div>
      </div>
    </div>
  );
}
