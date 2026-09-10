import React, {type ReactNode} from 'react';
import {ThemeClassNames} from '@docusaurus/theme-common';
import {useDocsSidebar} from '@docusaurus/plugin-content-docs/client';
import {useLocation} from '@docusaurus/router';
import DocSidebar from '@theme/DocSidebar';
import ThreeColumnLayout from '@site/src/components/ThreeColumnLayout';
import type {Props} from '@theme/DocRoot/Layout';

export default function DocRootLayout({children}: Props): ReactNode {
  const sidebar = useDocsSidebar();
  const {pathname} = useLocation();

  return (
    <ThreeColumnLayout
      sidebarKey={sidebar?.name}
      sidebarClassName={ThemeClassNames.docs.docSidebarContainer}
      renderSidebar={sidebar ? ({collapsed, onCollapse}) => (
        <DocSidebar
          sidebar={sidebar.items}
          path={pathname}
          onCollapse={onCollapse}
          isHidden={collapsed}
        />
      ) : undefined}
    >
      {children}
    </ThreeColumnLayout>
  );
}
