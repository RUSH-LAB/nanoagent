import React, {useEffect, type ReactNode} from 'react';
import clsx from 'clsx';
import {ErrorCauseBoundary, ThemeClassNames} from '@docusaurus/theme-common';
import {
  splitNavbarItems,
  useNavbarMobileSidebar,
} from '@docusaurus/theme-common/internal';
import NavbarItem, {type Props as NavbarItemConfig} from '@theme/NavbarItem';
import NavbarColorModeToggle from '@theme/Navbar/ColorModeToggle';
import NavbarMobileSidebarToggle from '@theme/Navbar/MobileSidebar/Toggle';
import WorkspaceSwitcher from '@site/src/components/WorkspaceSwitcher';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import {prepareWorkspaceApps} from '@site/src/hooks/useWorkspaceApps';
import useNavbarItems from '@site/src/hooks/useNavbarItems';

import styles from './styles.module.css';

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
  const {workspace} = useWorkspaceSite();
  const [leftItems, rightItems] = splitNavbarItems(useNavbarItems());

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
        </>
      }
    />
  );
}
