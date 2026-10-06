import React from 'react';
import Layout from '@theme/Layout';
import DocSidebar from '@theme/DocSidebar';
import {useLocation} from '@docusaurus/router';
import ThreeColumnLayout from '@site/src/components/ThreeColumnLayout';
import useWorkspaceApps from '@site/src/hooks/useWorkspaceApps';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';

/**
 * The frame the Plugins and Workspace pages share with the books: the same
 * collapsible left sidebar beside the content. The sidebar lists every app
 * NanoAgent publishes, then the member's workspace, as ordinary doc sidebar
 * items, so it looks and behaves exactly like a book's chapter list.
 */
function ToolsColumns({children}) {
  const {pathname, search} = useLocation();
  const {slug, workspace} = useWorkspaceSite();
  const apps = useWorkspaceApps(workspace);
  const base = slug ? `/w/${encodeURIComponent(slug)}` : '';
  const appHref = id => `${base}/apps?app=${encodeURIComponent(id)}`;

  const items = [
    {
      type: 'category',
      label: 'Plugins',
      collapsible: false,
      collapsed: false,
      items: apps.map(app => ({type: 'link', label: app.name, href: appHref(app.id)})),
    },
    {type: 'link', label: 'Workspace', href: `${base}/workspace`},
  ];
  // An app is chosen by ?app=, and the apps page opens the first one without it.
  const onApps = pathname.endsWith('/apps');
  const requested = new URLSearchParams(search).get('app');
  const activePath = onApps && (requested || apps[0])
    ? appHref(requested || apps[0].id)
    : pathname;

  return (
    <ThreeColumnLayout
      sidebarKey="tools"
      renderSidebar={({collapsed, onCollapse}) => (
        <DocSidebar sidebar={items} path={activePath} onCollapse={onCollapse} isHidden={collapsed} />
      )}
    >
      {children}
    </ThreeColumnLayout>
  );
}

export default function ToolsLayout({title, description, children}) {
  return (
    <Layout title={title} description={description}>
      <ToolsColumns>{children}</ToolsColumns>
    </Layout>
  );
}
