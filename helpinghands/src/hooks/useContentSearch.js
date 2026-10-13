import {useEffect, useState} from 'react';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import {useDebounce} from '@site/src/hooks/useDebounce';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import {workspaceDocumentHref} from '@site/src/utils/documentUrls';
import {displayPagePath} from '@site/src/utils/paths';

/**
 * One search, read by both of its surfaces.
 *
 * The navbar's dialog (components/SearchDialog) and the search page
 * (pages/content-search) ask the same three questions and render the same
 * answer, so neither of them owns the asking:
 *
 *   /api/content/search   documents whose path or title matches — the fast one
 *   /api/search           BM25 full text over the workspace's markdown
 *   /api/references       the bibliography plugin's papers, when it is on
 *
 * Every result carries the href it opens, because a path is not an address:
 * documents live at /w/<slug>/documents/<path> and a paper at
 * /w/<slug>/bibliography/<key>, and only this file knows the workspace.
 */

/** How long typing has to pause before we ask the server. */
const QUIET_MS = 250;

/** Nothing searched yet, and nothing searched for an empty query. */
const IDLE = {groups: [], errors: [], loading: false, query: '', scoped: true};

/**
 * Content belongs to a workspace, and so does every address a result opens.
 * Outside one there is nothing to search rather than a global index to fall
 * back to, so the surfaces say that instead of asking the API.
 */
const UNSCOPED = {...IDLE, scoped: false};

async function readJson(url, signal) {
  const response = await apiFetch(url, {signal});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** A paper's authors, in the form a byline uses: three, then "et al." */
function byline({authors}) {
  return authors.length <= 3
    ? authors.join(', ')
    : `${authors.slice(0, 3).join(', ')}, et al.`;
}

/** Where a document lives, as a breadcrumb: `research › notes › attention`. */
function crumbs(path) {
  return displayPagePath(path).split('/').join(' › ');
}

function documentItems({documents}, slug) {
  return documents.map(document => ({
    key: `document:${document.path}`,
    title: document.title,
    meta: crumbs(document.path),
    href: workspaceDocumentHref(document.path, slug, ''),
  }));
}

function textItems({results}, slug) {
  return results.map(result => ({
    key: `text:${result.path}`,
    title: result.title,
    meta: crumbs(result.path),
    snippet: result.snippet,
    href: workspaceDocumentHref(result.path, slug, ''),
  }));
}

function referenceItems({references}, slug) {
  return Object.entries(references).map(([key, entry]) => ({
    key: `reference:${key}`,
    title: entry.title || key,
    meta: [byline(entry), entry.venue, entry.year].filter(Boolean).join(' · '),
    badge: `@${key}`,
    href: `/w/${encodeURIComponent(slug)}/bibliography/${encodeURIComponent(key)}`,
  }));
}

/**
 * Search `query` across the workspace in the URL.
 *
 * `delay` is how long typing has to pause before the search runs. The dialog
 * searches as you type and keeps the default; the search page runs only what
 * you submit, so it passes 0 and asks at once.
 *
 * Returns `{query, groups, errors, loading, scoped}`, where `query` is the text
 * the groups answer (the debounced one, not the keystroke in flight) so a
 * caller can highlight the terms it actually matched. `groups` is an ordered
 * list of `{key, label, items}`, each item `{key, title, meta, snippet, badge,
 * href}`, and a group with no results is left out entirely. `scoped` is false
 * when the page is not in a workspace, which is the one case where nothing is
 * searched at all.
 *
 * A source that fails is named in `errors` rather than silently contributing
 * nothing: a search that found three of its four answers has to say so.
 */
export function useContentSearch(query, {delay = QUIET_MS} = {}) {
  const debounced = useDebounce(query, delay).trim();
  const {slug, site} = useWorkspaceSite();
  // The bibliography is a plugin: a workspace that turned it off has no papers
  // to search, and asking would answer 404 on every keystroke.
  const papers = site?.plugins?.bibliography?.enabled !== false;
  const [answer, setAnswer] = useState(IDLE);

  useEffect(() => {
    if (!slug) {
      setAnswer(UNSCOPED);
      return undefined;
    }
    if (!debounced) {
      setAnswer(IDLE);
      return undefined;
    }

    const controller = new AbortController();
    const {signal} = controller;
    const encoded = encodeURIComponent(debounced);

    setAnswer(previous => ({...previous, loading: true}));

    const sources = [
      {
        key: 'documents',
        label: 'Documents',
        request: readJson(`${API_BASE}/api/content/search?q=${encoded}`, signal)
          .then(data => documentItems(data, slug)),
      },
      {
        key: 'text',
        label: 'In the text',
        request: readJson(`${API_BASE}/api/search?q=${encoded}`, signal)
          .then(data => textItems(data, slug)),
      },
      ...(papers ? [{
        key: 'references',
        label: 'References',
        request: readJson(`${API_BASE}/api/references?limit=20&q=${encoded}`, signal)
          .then(data => referenceItems(data, slug)),
      }] : []),
    ];

    Promise.all(sources.map(source => source.request.then(
      items => ({...source, items}),
      error => ({...source, error}),
    ))).then(settled => {
      if (signal.aborted) return;
      setAnswer({
        query: debounced,
        loading: false,
        scoped: true,
        groups: settled
          .filter(source => !source.error && source.items.length > 0)
          .map(({key, label, items}) => ({key, label, items})),
        errors: settled
          .filter(source => source.error)
          .map(source => ({key: source.key, label: source.label, message: source.error.message})),
      });
    });

    return () => controller.abort();
  }, [debounced, slug, papers]);

  return answer;
}
