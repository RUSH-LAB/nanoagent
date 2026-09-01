import React, {type ReactNode, useEffect, useState} from 'react';
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
import {useLocation} from '@docusaurus/router';
import {getCachedWorkspaces, loadWorkspaces, workspaceSlugFromPath} from '@site/src/utils/workspaces';
import API_BASE, {apiJson, getCachedApiJson} from '@site/src/utils/api';
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
  const location = useLocation();

  const items = useNavbarItems();
  const workspaceSlug = workspaceSlugFromPath(location.pathname);
  const hasConcreteWorkspace = workspaceSlug && !workspaceSlug.startsWith(':');
  const [workspaceSiteState, setWorkspaceSiteState] = useState<any>(() => {
    const workspace = getCachedWorkspaces()?.workspaces?.find(item => item.slug === workspaceSlug);
    if (!workspace) return {slug: workspaceSlug, site: null};
    return {
      slug: workspaceSlug,
      site: getCachedApiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/site`)?.data?.site ?? null,
    };
  });
  const workspaceSite = workspaceSiteState.slug === workspaceSlug ? workspaceSiteState.site : null;

  useEffect(() => {
    let cancelled = false;
    if (!hasConcreteWorkspace) {
      setWorkspaceSiteState({slug: workspaceSlug, site: null});
      return undefined;
    }
    const cachedWorkspace = getCachedWorkspaces()?.workspaces?.find(item => item.slug === workspaceSlug);
    const cachedSite = cachedWorkspace
      ? getCachedApiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(cachedWorkspace.id)}/site`)?.data?.site ?? null
      : null;
    setWorkspaceSiteState({slug: workspaceSlug, site: cachedSite});
    loadWorkspaces()
      .then(({workspaces}) => workspaces.find(item => item.slug === workspaceSlug))
      .then(workspace => workspace
        ? apiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/site`, {cacheMs: 5 * 60_000})
        : null)
      .then(result => {
        if (!cancelled) setWorkspaceSiteState({slug: workspaceSlug, site: result?.ok ? result.data.site : null});
      })
      .catch(() => { if (!cancelled) setWorkspaceSiteState({slug: workspaceSlug, site: null}); });
    return () => { cancelled = true; };
  }, [hasConcreteWorkspace, workspaceSlug]);

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
