import React, {lazy, Suspense} from 'react';
import NavbarSearch from '@theme/Navbar/Search';

const SearchBar = lazy(() => import('@theme/SearchBar'));

const placeholderStyle = {
  width: '12rem',
  height: '2.25rem',
  borderRadius: '0.5rem',
  background: 'var(--ifm-color-emphasis-200)',
};

/**
 * Keep the local-search implementation out of the application shell bundle.
 * The navbar shape is reserved during the short async load to avoid layout
 * shift, while Docusaurus' original SearchBar keeps all search behavior.
 */
export default function LazySearchNavbarItem({mobile, className}) {
  if (mobile) return null;
  return (
    <NavbarSearch className={className}>
      <Suspense fallback={<div style={placeholderStyle} aria-hidden="true" />}>
        <SearchBar />
      </Suspense>
    </NavbarSearch>
  );
}
