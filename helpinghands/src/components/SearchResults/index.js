import React from 'react';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

/**
 * The rows a search answers with, drawn the same way wherever they appear.
 *
 * The dialog in the navbar and the search page both render this: one row
 * design, one set of group headings, one highlighting rule. The page is wider
 * and the dialog scrolls, which is the container's business, not the row's.
 *
 * `activeKey` is the row the keyboard is on. The page leaves it unset, which is
 * what makes the keyboard an addition to the dialog rather than a requirement
 * of this component.
 *
 * `variant="page"` lays each row out as a search engine's results page does:
 * where it lives above, a large linked title, then the passage that matched.
 * `headings={false}` drops the group headings, for a list that is already one
 * kind of result.
 */

/** The magnifier every search surface draws: the navbar's, the dialog's, the page's. */
export function SearchIcon({className}) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m16.25 16.25 4 4" />
    </svg>
  );
}

/**
 * What a search field turns off: the browser's history of past entries and
 * the password managers' menus, which both open a panel over the results.
 */
export const SEARCH_INPUT_PROPS = {
  type: 'text',
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': true,
  'data-lpignore': 'true',
};

/** `text` with every occurrence of `query` marked, case-insensitively. */
function Marked({text, query}) {
  const value = String(text ?? '');
  if (!query) return <>{value}</>;
  const parts = value.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return (
    <>
      {parts.map((part, index) => (
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={index} className={styles.mark}>{part}</mark>
          : <React.Fragment key={index}>{part}</React.Fragment>
      ))}
    </>
  );
}

export default function SearchResults({groups, query, activeKey, onHover, onOpen, variant = 'compact', headings = true}) {
  return (
    <div className={`${styles.groups} ${variant === 'page' ? styles.page : ''}`}>
      {groups.map(group => (
        <section key={group.key} className={styles.group}>
          {headings && (
            <h2 className={styles.groupLabel}>
              {group.label}
              <span className={styles.groupCount}>{group.items.length}</span>
            </h2>
          )}
          <ul className={styles.rows}>
            {group.items.map(item => (
              <li key={item.key}>
                <Link
                  to={item.href}
                  className={`${styles.row} ${item.key === activeKey ? styles.rowActive : ''}`}
                  data-search-row={item.key}
                  onMouseEnter={onHover ? () => onHover(item.key) : undefined}
                  onClick={onOpen ? () => onOpen(item) : undefined}>
                  <span className={styles.rowHead}>
                    <span className={styles.rowTitle}><Marked text={item.title} query={query} /></span>
                    {item.badge && <code className={styles.rowBadge}>{item.badge}</code>}
                  </span>
                  {item.meta && (
                    <span className={styles.rowMeta}><Marked text={item.meta} query={query} /></span>
                  )}
                  {item.snippet && (
                    <span className={styles.rowSnippet}><Marked text={item.snippet} query={query} /></span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Every row across the groups, in the order the keyboard walks them. */
export function flattenResults(groups) {
  return groups.flatMap(group => group.items);
}

/**
 * The sources that could not answer, as one quiet sentence: a partial answer
 * has to say it is partial, without a box louder than the results it sits by.
 */
export function searchFailures(errors) {
  const names = errors.map(error => error.label.toLowerCase());
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  const detail = errors.map(error => error.message).join(', ');
  return `Couldn’t search ${list} (${detail}).`;
}
