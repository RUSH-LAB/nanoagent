import {useThemeConfig} from '@docusaurus/theme-common';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';

/** Plugins: the apps page, where the sidebar's switcher chooses a group. */
function appsItem(workspaceSlug) {
  const appsPath = `/w/${encodeURIComponent(workspaceSlug)}/apps`;
  return {label: 'Plugins', to: appsPath, activeBasePath: appsPath, position: 'left'};
}

/** Workspace: the files the apps saved for this member. */
function workspaceItem(workspaceSlug) {
  const path = `/w/${encodeURIComponent(workspaceSlug)}/workspace`;
  return {label: 'Workspace', to: path, activeBasePath: path, position: 'left'};
}

/**
 * The navbar's items, the same in the bar and in the narrow window's menu
 * (Navbar/MobileSidebar/PrimaryMenu).
 */
export default function useNavbarItems() {
  const items = useThemeConfig().navbar.items;
  const {slug: workspaceSlug, site: workspaceSite} = useWorkspaceSite();
  const hasConcreteWorkspace = Boolean(workspaceSlug);

  const fixedItems = items.filter(item => item.type === 'custom-userButton');
  // A workspace's items all come from its site, and appear together once it
  // is known (from this tab's cache, the browser's memory, or one read); none
  // is drawn from the URL alone ahead of the rest.
  const configuredItems = !hasConcreteWorkspace
    ? items
    : !workspaceSite
      ? []
      // Book and Blog are hidden for now (FUTURE.md).
      : [appsItem(workspaceSlug), workspaceItem(workspaceSlug)];
  // Content links in the config are deliberately workspace-neutral so the
  // static build can render them. Once a workspace is present in the URL,
  // keep it in every navbar destination instead of falling back to the user's
  // default workspace through the legacy /documents redirect.
  return hasConcreteWorkspace
    ? [...configuredItems, ...fixedItems].map(item => typeof item.to === 'string' && item.to.startsWith('/documents')
      ? {...item, to: `/w/${encodeURIComponent(workspaceSlug)}${item.to}`}
      : item)
    : configuredItems;
}
