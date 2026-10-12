import React from 'react';
import Link from '@docusaurus/Link';
import NavbarSearch from '@theme/Navbar/Search';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';

import styles from './styles.module.css';

/**
 * Search is workspace data, so the navbar opens the database-backed search
 * page instead of loading a build-time index that cannot contain those rows.
 * NavbarSearch keeps the native Docusaurus placement and responsive behavior.
 */
export default function LazySearchNavbarItem({mobile, className}) {
  const {slug} = useWorkspaceSite();
  if (mobile) return null;
  const href = slug
    ? `/w/${encodeURIComponent(slug)}/content-search`
    : '/content-search';
  return (
    <NavbarSearch className={className}>
      <Link className={styles.searchLink} to={href} aria-label="Search this workspace">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m16.25 16.25 4 4" />
        </svg>
        <span>Search</span>
      </Link>
    </NavbarSearch>
  );
}
