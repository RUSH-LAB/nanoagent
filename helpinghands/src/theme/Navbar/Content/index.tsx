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
import SearchTrigger from '@site/src/components/SearchTrigger';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import {prepareWorkspaceApps} from '@site/src/hooks/useWorkspaceApps';

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
  const items = useNavbarItems();
  const {slug: workspaceSlug, workspace, site: workspaceSite} = useWorkspaceSite();
  const hasConcreteWorkspace = Boolean(workspaceSlug);

  const fixedItems = items.filter(item => item.type === 'search' || item.type === 'custom-userButton');
  // A workspace's items all come from its site, and appear together once it
  // is known (from this tab's cache, the browser's memory, or one read); none
  // is drawn from the URL alone ahead of the rest.
  const configuredItems: NavbarItemConfig[] = !hasConcreteWorkspace
    ? items
    : !workspaceSite
      ? []
      // Book and Blog are hidden for now (FUTURE.md).
      : [appsItem(workspaceSlug), workspaceItem(workspaceSlug)];
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

  // Entering a workspace starts installing its plugins, before any is opened.
  useEffect(() => prepareWorkspaceApps(workspace?.id), [workspace?.id]);

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
          {!searchBarItem && <SearchTrigger />}
        </>
      }
    />
  );
}
