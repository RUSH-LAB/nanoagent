import React, {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import {useThemeConfig} from '@docusaurus/theme-common';
import Logo from '@theme/Logo';
import Content from '@theme/DocSidebar/Desktop/Content';
import type {Props} from '@theme/DocSidebar/Desktop';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import {workspaceDocumentHref} from '@site/src/utils/documentUrls';
import {navigateClient} from '@site/src/utils/workspaces';
import styles from './styles.module.css';

function SidebarCollapseButton({onClick}: {onClick: () => void}): ReactNode {
  return (
    <button
      className={styles.collapseButton}
      type="button"
      title="Collapse chapter navigation"
      aria-label="Collapse chapter navigation"
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="m7 4-4 4 4 4M12 4 8 8l4 4" />
      </svg>
    </button>
  );
}

function BookSwitcher(): ReactNode {
  const [isOpen, setIsOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const {slug, site} = useWorkspaceSite();
  const books = (site?.collections ?? []).filter(collection => collection.type === 'docs');
  const pathname = typeof window === 'undefined' ? '' : window.location.pathname;
  const marker = '/documents/';
  const documentPath = pathname.includes(marker)
    ? decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length))
    : '';
  const current = books
    .filter(book => documentPath === book.pathPrefix || documentPath.startsWith(`${book.pathPrefix}/`))
    .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0];

  useEffect(() => {
    if (!isOpen) return undefined;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!switcherRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  if (!slug || books.length === 0) return null;

  return (
    <div className={styles.bookSwitcher} ref={switcherRef}>
      <button
        className={styles.bookTrigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(open => !open)}
      >
        <svg
          className={styles.bookIcon}
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <path d="M4.25 3.5h7A2.75 2.75 0 0 1 14 6.25v10.25H6.75a2.75 2.75 0 0 1-2.75-2.75v-10a.25.25 0 0 1 .25-.25Z" />
          <path d="M6.75 13.5H14M6.75 16.5a1.5 1.5 0 0 1 0-3" />
        </svg>
        <span className={styles.bookCopy}>
          <span className={styles.bookTitle}>{current?.title ?? 'Choose a book'}</span>
        </span>
        <svg
          className={styles.chevron}
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {isOpen && (
        <div className={styles.bookMenu} role="listbox" aria-label="Choose documentation book">
          {books.map(book => {
            const selected = book.key === current?.key;
            return (
              <button
                key={book.key}
                className={clsx(styles.bookOption, selected && styles.bookOptionSelected)}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setIsOpen(false);
                  navigateClient(workspaceDocumentHref(book.landingPath || book.pathPrefix, slug, ''));
                }}
              >
                <span>{book.title}</span>
                {selected && <span className={styles.checkmark} aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function DocSidebarDesktop({path, sidebar, onCollapse, isHidden}: Props): ReactNode {
  const {
    navbar: {hideOnScroll},
  } = useThemeConfig();

  const handleCollapse = useCallback(() => onCollapse(), [onCollapse]);

  return (
    <div
      className={clsx(
        styles.sidebar,
        hideOnScroll && styles.sidebarWithHideableNavbar,
        isHidden && styles.sidebarHidden,
      )}
    >
      {hideOnScroll && <Logo tabIndex={-1} className={styles.sidebarLogo} />}
      <div className={styles.sidebarControls}>
        {!isHidden && <BookSwitcher />}
        <SidebarCollapseButton onClick={handleCollapse} />
      </div>
      <Content path={path} sidebar={sidebar} />
    </div>
  );
}
