import React, {useEffect, type ReactNode} from 'react';
import clsx from 'clsx';
import {useLocation} from '@docusaurus/router';
import {
  useThemeConfig,
  ErrorCauseBoundary,
  ThemeClassNames,
} from '@docusaurus/theme-common';
import {
  splitNavbarItems,
  useNavbarMobileSidebar,
} from '@docusaurus/theme-common/internal';
import NavbarItem, {type Props as NavbarItemConfig} from '@theme/NavbarItem';
import NavbarColorModeToggle from '@theme/Navbar/ColorModeToggle';
import NavbarMobileSidebarToggle from '@theme/Navbar/MobileSidebar/Toggle';
import WorkspaceSwitcher from '@site/src/components/WorkspaceSwitcher';
import LazySearchNavbarItem from '@site/src/components/LazySearchNavbarItem';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import useWorkspaceSubscriptions, {
  isBookSubscribed, orderByPreference,
} from '@site/src/hooks/useWorkspaceSubscriptions';
import {workspaceDocumentHref} from '@site/src/utils/documentUrls';
import {prefetchWorkspaceContentHref} from '@site/src/utils/workspaceContent';

import styles from './styles.module.css';

function useNavbarItems() {
  return useThemeConfig().navbar.items as NavbarItemConfig[];
}

function NavbarItems({items}: {items: NavbarItemConfig[]}): ReactNode {
  return (
    <>
      {items.map((item, i) => {
        return (
          <ErrorCauseBoundary
            key={i}
            onError={(error) =>
              new Error(
                `A theme navbar item failed to render.
Please double-check the following navbar item (themeConfig.navbar.items) of your Docusaurus config:
${JSON.stringify(item, null, 2)}`,
                {cause: error},
              )
            }>
            <NavbarItem {...item} />
          </ErrorCauseBoundary>
        );
      })}
    </>
  );
}

function NavbarContentLayout({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className={clsx('navbar__inner', styles.navbarInner)}>
      <div
        className={clsx(
          ThemeClassNames.layout.navbar.containerLeft,
          'navbar__items',
        )}>
        {left}
      </div>
      <div
        className={clsx(
          ThemeClassNames.layout.navbar.containerRight,
          'navbar__items navbar__items--right',
        )}>
        {right}
      </div>
    </div>
  );
}

/** Plugins: the apps page, where the sidebar's switcher chooses a group. */
function appsItem(workspaceSlug: string): NavbarItemConfig {
  const appsPath = `/w/${encodeURIComponent(workspaceSlug)}/apps`;
  return {label: 'Plugins', to: appsPath, activeBasePath: appsPath, position: 'left' as const};
}

/** Workspace: the files the apps saved for this member. */
function workspaceItem(workspaceSlug: string): NavbarItemConfig {
  const path = `/w/${encodeURIComponent(workspaceSlug)}/workspace`;
  return {label: 'Workspace', to: path, activeBasePath: path, position: 'left' as const};
}

export default function NavbarContent(): ReactNode {
  const mobileSidebar = useNavbarMobileSidebar();
  const location = useLocation();
  const items = useNavbarItems();
  const {slug: workspaceSlug, workspace, site: workspaceSite} = useWorkspaceSite();
  const {subscriptions} = useWorkspaceSubscriptions(workspace);
  const hasConcreteWorkspace = Boolean(workspaceSlug);

  const fixedItems = items.filter(item => item.type === 'search' || item.type === 'custom-userButton');
  const collections = workspaceSite?.collections ?? [];
  const marker = '/documents/';
  const documentPath = location.pathname.includes(marker)
    ? decodeURIComponent(location.pathname.slice(location.pathname.indexOf(marker) + marker.length))
    : '';
  const currentCollection = collections
    .filter(collection => documentPath === collection.pathPrefix || documentPath.startsWith(`${collection.pathPrefix}/`))
    .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0];
  const orderedBooks = orderByPreference(
    collections.filter(collection => collection.type === 'docs'),
    subscriptions?.bookOrder,
    collection => collection.key,
  );
  const bookCollection = currentCollection?.type === 'docs'
    ? currentCollection
    : orderedBooks.find(collection => isBookSubscribed(subscriptions, collection.key))
      || orderedBooks[0];
  const blogCollection = currentCollection?.type === 'blog'
    ? currentCollection
    : collections.find(collection => collection.type === 'blog');
  const configuredItems: NavbarItemConfig[] = hasConcreteWorkspace
    ? [
        bookCollection && {
          label: 'Book',
          to: workspaceDocumentHref(bookCollection.landingPath || bookCollection.pathPrefix, workspaceSlug, ''),
          activeBasePath: workspaceDocumentHref(bookCollection.pathPrefix, workspaceSlug, ''),
          position: 'left' as const,
        },
        blogCollection && {
          label: 'Blog',
          to: workspaceDocumentHref(blogCollection.landingPath || blogCollection.pathPrefix, workspaceSlug, ''),
          activeBasePath: workspaceDocumentHref(blogCollection.pathPrefix, workspaceSlug, ''),
          position: 'left' as const,
        },
        appsItem(workspaceSlug),
        workspaceItem(workspaceSlug),
      ].filter((item): item is NavbarItemConfig => Boolean(item))
    : items;
  // Content links in the config are deliberately workspace-neutral so the
  // static build can render them. Once a workspace is present in the URL,
  // keep it in every navbar destination instead of falling back to the user's
  // default workspace through the legacy /documents redirect.
  const scopedItems = hasConcreteWorkspace
    ? [...configuredItems, ...fixedItems].map(item => typeof item.to === 'string' && item.to.startsWith('/documents')
      ? {...item, to: `/w/${encodeURIComponent(workspaceSlug)}${item.to}`}
      : item)
    : configuredItems;
  const [leftItems, rightItems] = splitNavbarItems(scopedItems);

  const searchBarItem = items.find((item) => item.type === 'search');

  useEffect(() => {
    if (!workspaceSlug || !workspaceSite) return undefined;
    const hrefs = [bookCollection, blogCollection]
      .filter(Boolean)
      .map(collection => workspaceDocumentHref(collection.landingPath || collection.pathPrefix, workspaceSlug, ''));
    if (hrefs.length === 0) return undefined;
    let cancelled = false;
    let idleHandle: number | undefined;

    // The first navigation item is normally the primary collection (Research
    // in Mochi). Start it immediately when the workspace navbar resolves, then
    // warm the remaining collections when the browser is idle.
    prefetchWorkspaceContentHref(hrefs[0], workspaceSite).catch(() => {});
    const warmRemaining = () => {
      if (cancelled) return;
      for (const href of hrefs.slice(1)) {
        prefetchWorkspaceContentHref(href, workspaceSite).catch(() => {});
      }
    };
    if ('requestIdleCallback' in window) {
      idleHandle = window.requestIdleCallback(warmRemaining, {timeout: 1_000});
    } else {
      idleHandle = window.setTimeout(warmRemaining, 250);
    }
    return () => {
      cancelled = true;
      if (idleHandle === undefined) return;
      if ('cancelIdleCallback' in window) window.cancelIdleCallback(idleHandle);
      else window.clearTimeout(idleHandle);
    };
  }, [workspaceSlug, workspaceSite, bookCollection, blogCollection]);

  return (
    <NavbarContentLayout
      left={
        <>
          {!mobileSidebar.disabled && <NavbarMobileSidebarToggle />}
          {/* Where NavbarLogo used to be. The switcher renders exactly that
              until it knows which workspace you are in, and falls back to it
              for good when there is no session to ask about. */}
          <WorkspaceSwitcher />
          <NavbarItems items={leftItems} />
        </>
      }
      right={
        <>
          <NavbarItems items={rightItems} />
          <NavbarColorModeToggle className={styles.colorModeToggle} />
          {!searchBarItem && <LazySearchNavbarItem />}
        </>
      }
    />
  );
}
