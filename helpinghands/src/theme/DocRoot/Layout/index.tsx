import React, {type ReactNode} from 'react';
import {ThemeClassNames} from '@docusaurus/theme-common';
import {useDocsSidebar} from '@docusaurus/plugin-content-docs/client';
import {useLocation} from '@docusaurus/router';
import DocSidebar from '@theme/DocSidebar';
import TwoColumnLayout from '@site/src/components/TwoColumnLayout';
import type {Props} from '@theme/DocRoot/Layout';

export default function DocRootLayout({children}: Props): ReactNode {
  const sidebar = useDocsSidebar();
  const {pathname} = useLocation();

  return (
    <TwoColumnLayout
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
    </TwoColumnLayout>
  );
}
