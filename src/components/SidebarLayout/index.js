import React from 'react';
import DocSidebar from '@theme/DocSidebar';
import ThreeColumnLayout from '@site/src/components/ThreeColumnLayout';

/**
 * The books' frame for any page: a collapsible left sidebar beside the
 * content. `sidebar` is a list of ordinary doc sidebar items (categories,
 * links, html), so the page's navigation looks and behaves exactly like a
 * book's chapter list; `activePath` is the item href to highlight.
 *
 * Render it inside @theme/Layout, whose providers the sidebar uses.
 */
export default function SidebarLayout({sidebarKey, sidebar, activePath, children}) {
  return (
    <ThreeColumnLayout
      sidebarKey={sidebarKey}
      renderSidebar={({collapsed, onCollapse}) => (
        <DocSidebar sidebar={sidebar} path={activePath} onCollapse={onCollapse} isHidden={collapsed} />
      )}
    >
      {children}
    </ThreeColumnLayout>
  );
}
