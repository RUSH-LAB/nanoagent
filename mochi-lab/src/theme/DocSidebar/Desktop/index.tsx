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
import useWorkspaceSubscriptions, {
  isBookSubscribed, orderByPreference,
} from '@site/src/hooks/useWorkspaceSubscriptions';
import API_BASE, {apiFetch, invalidateApiJson} from '@site/src/utils/api';
import {workspaceDocumentHref} from '@site/src/utils/documentUrls';
import {navigateClient} from '@site/src/utils/workspaces';
import {newDocumentDraft, slugifyDocumentTitle} from '@site/src/utils/documentAuthoring';
import {clientPlatform} from '@site/src/platform/client';
import {replaceCollectionType, saveWorkspaceCollections} from '@site/src/utils/workspaceSiteEditor';
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  const {slug, workspace, site} = useWorkspaceSite();
  const {subscriptions} = useWorkspaceSubscriptions(workspace);
  const books = (site?.collections ?? []).filter(collection => collection.type === 'docs');
  const pathname = typeof window === 'undefined' ? '' : window.location.pathname;
  const marker = '/documents/';
  const documentPath = pathname.includes(marker)
    ? decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length))
    : '';
  const current = books
    .filter(book => documentPath === book.pathPrefix || documentPath.startsWith(`${book.pathPrefix}/`))
    .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0];
  const selectableBooks = orderByPreference(
    books,
    subscriptions?.bookOrder,
    book => book.key,
  ).filter(book => isBookSubscribed(subscriptions, book.key));

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

  if (!slug || (books.length === 0 && workspace?.role !== 'owner')) return null;

  const saveBooks = async (nextBooks) => {
    if (!workspace || !site || saving) return false;
    setSaving(true);
    setError(null);
    try {
      await saveWorkspaceCollections(
        workspace,
        site,
        replaceCollectionType(site.collections, 'docs', nextBooks),
      );
      return true;
    } catch (saveError) {
      setError(saveError.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addBook = async () => {
    const title = clientPlatform.dialogs.prompt('New book name')?.trim();
    if (!title) return;
    const base = slugifyDocumentTitle(title) || 'book';
    const keys = new Set((site?.collections ?? []).map(collection => collection.key));
    const paths = new Set((site?.collections ?? []).map(collection => collection.pathPrefix));
    let key = base;
    let suffix = 2;
    while (keys.has(key) || paths.has(`books/${key}`)) {
      key = `${base}-${suffix}`;
      suffix += 1;
    }
    const collection = {
      key,
      type: 'docs',
      pathPrefix: `books/${key}`,
      title,
      description: null,
      sidebarTitle: null,
      showReadingTime: false,
    };
    const draft = newDocumentDraft({collection, title: 'Introduction'});
    const nextCollection = {...collection, landingPath: draft.path};
    if (!await saveBooks([...books, nextCollection])) return;
    try {
      const documentsUrl = `${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/documents`;
      const response = await apiFetch(documentsUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: draft.path, markdown: draft.markdown}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not create the first page');
      invalidateApiJson(documentsUrl);
      setIsOpen(false);
      navigateClient(workspaceDocumentHref(draft.path, slug, ''));
    } catch (createError) {
      setError(createError.message);
    }
  };

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
          {selectableBooks.length === 0 && (
            <span className={styles.emptySelection}>No subscribed books</span>
          )}
          {selectableBooks.map(book => {
            const selected = book.key === current?.key;
            return (
              <div
                key={book.key}
                className={styles.bookOptionRow}
              >
                <button
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
              </div>
            );
          })}
          {workspace?.role === 'owner' && (
            <button className={styles.addBook} type="button" disabled={saving} onClick={() => void addBook()}>
              + New book
            </button>
          )}
          {error && <span className={styles.bookError} role="alert">{error}</span>}
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
        {/* Plugins and Workspace reuse this sidebar; only a book has books to switch. */}
        {!isHidden && path.includes('/documents/') && <BookSwitcher />}
        <SidebarCollapseButton onClick={handleCollapse} />
      </div>
      <Content path={path} sidebar={sidebar} />
    </div>
  );
}
