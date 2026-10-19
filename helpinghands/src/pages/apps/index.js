import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import {useHistory, useLocation} from '@docusaurus/router';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import API_BASE, {apiJson} from '@site/src/utils/api';
import Layout from '@theme/Layout';
import PluginFrame from '@site/src/components/PluginFrame';
import PluginSidebar, {pluginNavigation} from '@site/src/components/PluginSidebar';
import TwoColumnLayout from '@site/src/components/TwoColumnLayout';
import useWorkspaceApps, {forgetWorkspaceApps, prepareWorkspaceApps} from '@site/src/hooks/useWorkspaceApps';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import styles from './styles.module.css';

/**
 * The plugins the member installed from the marketplace: `nanoagent.plugin/v0001`
 * packages, which NanoAgent runs in its sandbox.
 *
 * Choosing an app shows its own front end, the page in its ui/ folder, in a
 * sandboxed frame (PluginFrame), and nothing of ours around it: what the app
 * says about itself and how it starts are its developer's. Through the frame's
 * bridge the page prompts the app's NanoAgent agent; what the apps save lands
 * in the caller's own workspace (src/pages/workspace). NanoAgent owns the
 * agent's model, instructions and the checks on every tool call.
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

/** A plugin the member installed that the marketplace no longer has. */
function UnavailableNotice({app}) {
  return (
    <article className={styles.detail}>
      <header className={styles.detailHeader}>
        <h1>{app.name}</h1>
      </header>
      <section className={styles.maintenanceNotice}>
        <strong>No longer in the marketplace</strong>
        <p>{app.name} was removed from the marketplace, so it can't be used. An owner can remove it from this workspace in Settings.</p>
      </section>
    </article>
  );
}

// The states of an install (server/workspace-apps.js) that open as the plugin's page, and of
// those the ones whose version no longer runs here.
const OPENS = new Set(['ready', 'update', 'needs-update', 'outdated']);
const STOPPED = new Set(['needs-update', 'outdated']);

/**
 * Above the page of a plugin whose version no longer runs here, that the member reads its
 * sessions and starts none, and what makes it run again: updating it, with the button the
 * page has for it (kit/shell.js), or its author publishing a version that does.
 */
function StoppedNotice({app, slug}) {
  return (
    <div className={styles.stoppedNotice}>
      {app.state === 'needs-update' ? (
        <span>
          <strong>Update needed.</strong> v{app.version} no longer runs here: you can read its sessions, but start one
          only once you update it to v{app.latest}.
        </span>
      ) : (
        <span>
          <strong>Outdated.</strong> v{app.version} no longer runs here: you can read its sessions, but not start one.
          It runs again once its author publishes a version that does.
        </span>
      )}
      {app.state === 'outdated' && (
        <Link to={`/w/${encodeURIComponent(slug)}/marketplace?plugin=${encodeURIComponent(app.id)}`}>See it in the Marketplace</Link>
      )}
    </div>
  );
}

/**
 * An app that runs is its own page, opened once NanoAgent has it installed: the
 * first open after NanoAgent starts builds its environment, which takes a while.
 * One whose version no longer runs (`needs-update`, `outdated`) is its page too, never
 * installed, in which the member reads their sessions and starts none, StoppedNotice above
 * it saying so. One still being built is our notice. The page moving the member to another
 * version opens that version. The page opens on `session`, and `onSession` hears the session it shows.
 */
function AppDetail({app, workspace, slug, session, onSession}) {
  const [opened, setOpened] = React.useState({app: null, error: null});
  // Counts the versions the page moved to, so each opens again.
  const [moved, setMoved] = React.useState(0);
  const opens = OPENS.has(app.state);
  React.useEffect(() => {
    if (!opens) return undefined;
    let cancelled = false;
    apiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/apps/${encodeURIComponent(app.id)}`, {fresh: true}).then(
      result => !cancelled && setOpened(result.ok
        ? {app: result.data.app, error: null}
        : {app: null, error: result.data.error || `Could not open ${app.name} (${result.status})`}),
      () => !cancelled && setOpened({app: null, error: 'Could not reach the API server'}),
    );
    return () => { cancelled = true; };
  }, [opens, workspace.id, app.id, app.name, moved]);
  if (app.status === 'unavailable') return <UnavailableNotice app={app} />;
  if (!opens) return <MaintenanceNotice app={app} />;
  if (opened.error) return <div className={styles.error}>{opened.error}</div>;
  if (!opened.app) return <p className={styles.muted}>Preparing {app.name}…</p>;
  const onVersion = changed => {
    forgetWorkspaceApps(workspace.id);
    prepareWorkspaceApps(workspace.id, {again: true});
    if (changed.sha256 !== opened.app.sha256) setMoved(count => count + 1);
  };
  const frame = <PluginFrame app={opened.app} workspace={workspace} onVersion={onVersion} session={session} onSession={onSession} />;
  if (!STOPPED.has(app.state)) return frame;
  return (
    <div className={styles.stopped}>
      <StoppedNotice app={app} slug={slug} />
      {frame}
    </div>
  );
}

function AppsColumns() {
  const location = useLocation();
  const {slug, workspace} = useWorkspaceSite();
  const {apps, error} = useWorkspaceApps(workspace);
  const navigation = pluginNavigation(apps ?? [], location.search, `/w/${encodeURIComponent(slug)}/apps`);
  // The address names the session the plugin's page shows (?session=), so reloading opens it again.
  const history = useHistory();
  const session = new URLSearchParams(location.search).get('session');
  const onSession = id => {
    // Hidden, Plugins keeps running (components/Shell/Sections.js) and the address is another section's.
    if (history.location.pathname !== location.pathname) return;
    const params = new URLSearchParams(history.location.search);
    if (id) params.set('session', id);
    else params.delete('session');
    const search = params.size ? `?${params}` : '';
    if (search !== history.location.search) history.replace({...history.location, search});
  };

  let content = null;
  if (!slug) content = <p className={styles.muted}>Open Plugins from a workspace.</p>;
  else if (error) content = <div className={styles.error}>{error}</div>;
  else if (apps && !apps.length) {
    content = (
      <p className={styles.muted}>
        You have no plugins yet. <Link to={`/w/${encodeURIComponent(slug)}/marketplace`}>Browse the marketplace</Link> to install some.
      </p>
    );
  } else if (apps && navigation.unknownTag) {
    content = <div className={styles.error}>No plugin tagged {navigation.unknownTag}.</div>;
  } else if (apps && navigation.requestedApp && !navigation.app) {
    content = <div className={styles.error}>No app named {navigation.requestedApp}.</div>;
  } else if (apps) {
    content = <AppDetail key={navigation.app.id} app={navigation.app} workspace={workspace} slug={slug} session={session} onSession={onSession} />;
  }

  return (
    <TwoColumnLayout
      sidebarKey="plugins"
      showSidebarOnMobile
      evenGutters
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

/** The page's title and description, for its Layout here and in the shell (components/Shell/registry.js). */
export const page = {title: 'Plugins', description: 'Apps built on NanoAgent'};

export const AppsSection = AppsColumns;

export default function AppsPage() {
  return (
    <Layout {...page}>
      <AppsSection />
    </Layout>
  );
}
