import React from 'react';
import {openSearchDialog} from '@site/src/components/SearchDialog';
import {SearchIcon} from '@site/src/components/SearchResults';

import styles from './styles.module.css';

/**
 * The navbar's way into search.
 *
 * It opens the dialog (components/SearchDialog) rather than navigating, so
 * searching never costs you the page you were reading.
 *
 * Deliberately not wrapped in Docusaurus's `@theme/Navbar/Search`: that
 * container absolutely positions itself against the navbar's right edge below
 * 996px, which parked this control on top of the account button on a narrow
 * window. As an ordinary navbar item it simply sits in the row, and gives up
 * its label — the pill becomes a square icon button — while the window is too
 * narrow for the navigation beside it.
 *
 * In the mobile sidebar it is a menu row like the others, and closes the
 * sidebar on its way out (`onClick`, supplied by the theme's primary menu).
 */
export default function SearchTrigger({mobile, className, onClick}) {
  const open = () => {
    onClick?.();
    openSearchDialog();
  };

  if (mobile) {
    return (
      <li className="menu__list-item">
        <button type="button" className={`menu__link ${styles.menuRow}`} onClick={open}>
          <SearchIcon className={styles.icon} />
          Search
        </button>
      </li>
    );
  }

  return (
    <button
      type="button"
      className={`${className ?? ''} ${styles.trigger}`}
      onClick={open}
      aria-label="Search this workspace">
      <SearchIcon className={styles.icon} />
      <span className={styles.label}>Search</span>
      <kbd className={styles.shortcut}>/</kbd>
    </button>
  );
}
