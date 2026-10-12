import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import Layout from '@theme/Layout';
import PluginFrame from '@site/src/components/PluginFrame';
import PluginSidebar, {pluginNavigation} from '@site/src/components/PluginSidebar';
import TwoColumnLayout from '@site/src/components/TwoColumnLayout';
import useWorkspaceApps from '@site/src/hooks/useWorkspaceApps';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import styles from './styles.module.css';

/**
 * The apps NanoAgent publishes: its `nanoagent.plugin/v1` packages.
 *
 * Choosing an app shows its own front end, the page in its ui/ folder, in a
 * sandboxed frame (PluginFrame), and nothing of ours around it: what the app
 * says about itself and how it starts are its developer's. Through the frame's
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

/** A ready app is its own page; one still being built is our notice. */
function AppDetail({app, workspace}) {
  if (app.status !== 'ready') return <MaintenanceNotice app={app} />;
  return <PluginFrame app={app} workspace={workspace} />;
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
    content = (
      <p className={styles.muted}>
        NanoAgent publishes no apps. List plugin directories under <code>plugins</code> in its web config,
        or <Link to="/marketplace">browse the marketplace</Link>.
      </p>
    );
  } else if (apps && navigation.unknownGroup) {
    content = <div className={styles.error}>No plugin group named {navigation.unknownGroup}.</div>;
  } else if (apps && navigation.requestedApp && !navigation.app) {
    content = <div className={styles.error}>No app named {navigation.requestedApp}.</div>;
  } else if (apps) {
    content = <AppDetail key={navigation.app.id} app={navigation.app} workspace={workspace} />;
  }

  return (
    <TwoColumnLayout
      sidebarKey="plugins"
      showSidebarOnMobile
      renderSidebar={({collapsed, onCollapse}) => (
        <PluginSidebar
          navigation={navigation}
          marketplaceHref={slug ? `/w/${encodeURIComponent(slug)}/marketplace` : '/marketplace'}
          collapsed={collapsed}
          onCollapse={onCollapse}
        />
      )}
    >
      <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading...</div>}>
        {() => <ErrorBoundary>{content}</ErrorBoundary>}
      </BrowserOnly>
    </TwoColumnLayout>
  );
}

export default function AppsPage() {
  return (
    <Layout title="Plugins" description="Apps built on NanoAgent">
      <AppsColumns />
    </Layout>
  );
}
