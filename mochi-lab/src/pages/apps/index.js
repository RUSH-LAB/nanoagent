import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {useLocation} from '@docusaurus/router';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import AppProduct from '@site/src/components/AppProduct';
import Layout from '@theme/Layout';
import PluginFrame from '@site/src/components/PluginFrame';
import PluginSidebar, {pluginNavigation} from '@site/src/components/PluginSidebar';
import ThreeColumnLayout from '@site/src/components/ThreeColumnLayout';
import useWorkspaceApps from '@site/src/hooks/useWorkspaceApps';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import styles from './styles.module.css';

/**
 * The apps NanoAgent publishes: its `nanoagent.plugin/v1` packages.
 *
 * An app opens on its product page (AppProduct), from the product section of
 * its manifest. Open shows its own front end, the page in its ui/ folder, in a
 * sandboxed frame (PluginFrame). Through the frame's
 * bridge the page runs the app's tasks and prompts its NanoAgent agent; what
 * the apps save lands in the caller's own workspace (src/pages/workspace).
 * NanoAgent owns the agent's model, instructions and the checks on every tool
 * call.
 */

/** A plugin still being built: what it is, and that it cannot be used yet. */
function MaintenanceNotice({app}) {
  return (
    <article className={styles.detail}>
      <header className={styles.detailHeader}>
        <h1>{app.name}</h1>
      </header>
      <section className={styles.maintenanceNotice}>
        <strong>Under maintenance</strong>
        <p>{app.name} is still being built, so it can't be used yet. It will open here once it is ready.</p>
      </section>
    </article>
  );
}

/** A ready app opens on its product page; Open shows the app itself, and About returns to it. */
function AppDetail({app, workspace}) {
  const [open, setOpen] = React.useState(false);
  if (app.status !== 'ready') return <MaintenanceNotice app={app} />;
  if (!open) return <AppProduct app={app} onOpen={() => setOpen(true)} />;
  return (
    <article className={styles.detail}>
      <header className={styles.detailHeader}>
        <h1>{app.name}</h1>
        <button type="button" className="button button--secondary button--sm" onClick={() => setOpen(false)}>
          About {app.name}
        </button>
      </header>
      <PluginFrame app={app} workspace={workspace} />
    </article>
  );
}

function AppsColumns() {
  const location = useLocation();
  const {slug, workspace} = useWorkspaceSite();
  const {apps, error} = useWorkspaceApps(workspace);
  const navigation = pluginNavigation(apps ?? [], location.search, `/w/${encodeURIComponent(slug)}/apps`);

  let content = null;
  if (!slug) content = <p className={styles.muted}>Open Plugins from a workspace.</p>;
  else if (error) content = <div className={styles.error}>{error}</div>;
  else if (apps && !apps.length) {
    content = <p className={styles.muted}>NanoAgent publishes no apps. List plugin directories under <code>plugins</code> in its web config.</p>;
  } else if (apps && navigation.unknownGroup) {
    content = <div className={styles.error}>No plugin group named {navigation.unknownGroup}.</div>;
  } else if (apps && navigation.requestedApp && !navigation.app) {
    content = <div className={styles.error}>No app named {navigation.requestedApp}.</div>;
  } else if (apps) {
    content = <AppDetail key={navigation.app.id} app={navigation.app} workspace={workspace} />;
  }

  return (
    <ThreeColumnLayout
      sidebarKey="plugins"
      showSidebarOnMobile
      renderSidebar={({collapsed, onCollapse}) => (
        <PluginSidebar navigation={navigation} collapsed={collapsed} onCollapse={onCollapse} />
      )}
    >
      <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading...</div>}>
        {() => <ErrorBoundary>{content}</ErrorBoundary>}
      </BrowserOnly>
    </ThreeColumnLayout>
  );
}

export default function AppsPage() {
  return (
    <Layout title="Plugins" description="Apps built on NanoAgent">
      <AppsColumns />
    </Layout>
  );
}
