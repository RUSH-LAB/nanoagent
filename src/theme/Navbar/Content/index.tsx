import React, {type ReactNode} from 'react';
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
    ? (workspaceSite?.navigation ?? []).map(item => ({
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
