import React, {useEffect, type ReactNode} from 'react';
import clsx from 'clsx';
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

export default function NavbarContent(): ReactNode {
  const mobileSidebar = useNavbarMobileSidebar();
  const items = useNavbarItems();
  const {slug: workspaceSlug, site: workspaceSite} = useWorkspaceSite();
  const hasConcreteWorkspace = Boolean(workspaceSlug);

  const fixedItems = items.filter(item => item.type === 'search' || item.type === 'custom-userButton');
  const configuredItems = hasConcreteWorkspace
    ? (workspaceSite?.navigation ?? []).filter(item => item.hidden !== true).map(item => ({
        label: item.label,
        to: workspaceDocumentHref(item.path, workspaceSlug, ''),
        position: 'left' as const,
      }))
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
    if (!workspaceSlug || !workspaceSite?.navigation?.length) return undefined;
    const hrefs = [...new Set(workspaceSite.navigation.filter(item => item.hidden !== true).map(item =>
      workspaceDocumentHref(item.path, workspaceSlug, ''),
    ))];
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
  }, [workspaceSlug, workspaceSite]);

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
