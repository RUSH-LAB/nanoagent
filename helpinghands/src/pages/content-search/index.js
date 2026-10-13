import React, {useEffect, useRef, useState} from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {useHistory, useLocation} from '@docusaurus/router';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import SearchResults, {SEARCH_INPUT_PROPS, SearchIcon, searchFailures} from '@site/src/components/SearchResults';
import {useContentSearch} from '@site/src/hooks/useContentSearch';
import pageStyles from '@site/src/css/page.module.css';
import styles from './styles.module.css';

/**
 * Search, as a page you can link to.
 *
 * Laid out as a search engine is. With no query it is the field alone, in the
 * middle of the screen. Nothing happens while you type: Enter or the Search
 * button submits, and the query goes into the address (`?q=`) as a new history
 * entry, so the results are a page of their own — Back returns to the one
 * before, and the address can be shared or bookmarked. The results page keeps
 * the field at the top to search again, with a tab per kind of result.
 *
 * The navbar's dialog (components/SearchDialog) is the other surface: it
 * searches as you type, over whatever you were reading. Both read one hook and
 * one result list, so they cannot disagree about what the workspace contains.
 */

/** The tab that shows every kind of result together. */
const ALL = 'all';

/** The field, on the front page and at the top of the results alike. */
function SearchForm({draft, setDraft, onSubmit, home}) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (home) inputRef.current?.focus();
  }, [home]);

  return (
    <form className={`${styles.form} ${home ? styles.formHome : ''}`} role="search" onSubmit={onSubmit}>
      <div className={styles.field}>
        <SearchIcon className={styles.fieldIcon} />
        <input
          {...SEARCH_INPUT_PROPS}
          ref={inputRef}
          className={styles.input}
          enterKeyHint="search"
          placeholder="Search documents, text and references"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          aria-label="Search this workspace"
        />
        {draft && (
          <button
            type="button"
            className={styles.clear}
            onClick={() => { setDraft(''); inputRef.current?.focus(); }}
            aria-label="Clear search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        )}
      </div>
      {home && (
        <div className={styles.homeActions}>
          <button type="submit" className={styles.submit}>Search</button>
        </div>
      )}
    </form>
  );
}

/** Grey bars where results are about to be, so the page does not jump. */
function Placeholder() {
  return (
    <div className={styles.placeholder} aria-hidden="true">
      {[0, 1, 2, 3].map(index => (
        <div key={index} className={styles.placeholderRow}>
          <span className={styles.placeholderCrumb} />
          <span className={styles.placeholderTitle} />
          <span className={styles.placeholderText} />
        </div>
      ))}
    </div>
  );
}

function SearchPageContent() {
  const history = useHistory();
  const location = useLocation();
  const submitted = (new URLSearchParams(location.search).get('q') ?? '').trim();
  const [draft, setDraft] = useState(submitted);
  const [tab, setTab] = useState(ALL);
  const answer = useContentSearch(submitted, {delay: 0});

  /* Back and Forward change the query; the field and the tab follow them. */
  useEffect(() => {
    setDraft(submitted);
    setTab(ALL);
  }, [submitted]);

  const onSubmit = event => {
    event.preventDefault();
    const query = draft.trim();
    if (!query || query === submitted) return;
    history.push(`${location.pathname}?q=${encodeURIComponent(query)}`);
  };

  if (!submitted) {
    return (
      <main className={`${pageStyles.pageContainer} ${styles.home}`}>
        <h1 className={styles.title}>Search</h1>
        <SearchForm draft={draft} setDraft={setDraft} onSubmit={onSubmit} home />
      </main>
    );
  }

  const pending = answer.scoped && (answer.loading || answer.query !== submitted);
  const total = answer.groups.reduce((count, group) => count + group.items.length, 0);
  const tabs = [{key: ALL, label: 'All', count: total}, ...answer.groups.map(group => ({
    key: group.key, label: group.label, count: group.items.length,
  }))];
  const shown = tab === ALL ? answer.groups : answer.groups.filter(group => group.key === tab);

  return (
    <main className={`${pageStyles.pageContainer} ${styles.resultsPage}`}>
      <h1 className={styles.title}>Search results for {submitted}</h1>
      <header className={styles.resultsHeader}>
        <SearchForm draft={draft} setDraft={setDraft} onSubmit={onSubmit} />
        <nav className={styles.tabs} aria-label="Kinds of result">
          {!pending && answer.groups.length > 0 && tabs.map(item => (
            <button
              key={item.key}
              type="button"
              className={`${styles.tab} ${tab === item.key ? styles.tabActive : ''}`}
              aria-pressed={tab === item.key}
              onClick={() => setTab(item.key)}>
              {item.label}
              <span className={styles.tabCount}>{item.count}</span>
            </button>
          ))}
        </nav>
      </header>

      <div className={styles.column}>
        <p className={styles.status} role="status">
          {!answer.scoped && <span>Open a workspace to search its content.</span>}
          {pending && <span>Searching…</span>}
          {answer.scoped && !pending && total > 0
            && <span>{total} result{total === 1 ? '' : 's'}</span>}
          {!pending && answer.errors.length > 0 && (
            <span className={styles.error}>{searchFailures(answer.errors)}</span>
          )}
        </p>

        {pending && <Placeholder />}

        {!pending && shown.length > 0 && (
          <SearchResults
            groups={shown}
            query={answer.query}
            variant="page"
            headings={tab === ALL && shown.length > 1}
          />
        )}

        {answer.scoped && !pending && total === 0 && (
          <div className={styles.empty}>
            <p>Your search — <strong>{submitted}</strong> — did not match any documents, text or references.</p>
            <p>Suggestions:</p>
            <ul>
              <li>Make sure all words are spelled correctly.</li>
              <li>Try fewer or more general words.</li>
              <li>Try part of a document&rsquo;s name.</li>
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}

export default function SearchPage() {
  return (
    <Layout title="Search" description="Search this workspace's content">
      <BrowserOnly>
        {() => <ErrorBoundary><SearchPageContent /></ErrorBoundary>}
      </BrowserOnly>
    </Layout>
  );
}
