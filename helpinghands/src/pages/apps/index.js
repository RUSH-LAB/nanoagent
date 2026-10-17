import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import API_BASE, {apiJson} from '@site/src/utils/api';
import Layout from '@theme/Layout';
import PluginFrame from '@site/src/components/PluginFrame';
import PluginSidebar, {pluginNavigation} from '@site/src/components/PluginSidebar';
import TwoColumnLayout from '@site/src/components/TwoColumnLayout';
import useWorkspaceApps, {forgetWorkspaceApps, prepareWorkspaceApps} from '@site/src/hooks/useWorkspaceApps';
import useWorkspaceDrafts from '@site/src/hooks/useWorkspaceDrafts';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import styles from './styles.module.css';

/**
 * The plugins the member installed from the marketplace: `nanoagent.plugin/v1`
 * packages, which NanoAgent runs in its sandbox.
 *
 * Choosing an app shows its own front end, the page in its ui/ folder, in a
 * sandboxed frame (PluginFrame), and nothing of ours around it: what the app
 * says about itself and how it starts are its developer's. Through the frame's
 * bridge the page prompts the app's NanoAgent agent; what the apps save lands
 * in the caller's own workspace (src/pages/workspace). NanoAgent owns the
 * agent's model, instructions and the checks on every tool call.
 *
 * Beside them are the drafts on the member's computer: plugins they are making
 * there, which `rushlab preview` had its RUSH Lab install, opened the same way
 * before they are published.
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

/**
 * A ready app is its own page, opened once NanoAgent has it installed: the
 * first open after NanoAgent starts builds its environment, which takes a while.
 * One still being built is our notice. The page moving the member to another
 * version opens that version.
 */
function AppDetail({app, workspace}) {
  const [opened, setOpened] = React.useState({app: null, error: null});
  // Counts the versions the page moved to, so each opens again.
  const [moved, setMoved] = React.useState(0);
  const ready = app.status === 'ready';
  React.useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    apiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/apps/${encodeURIComponent(app.id)}`, {fresh: true}).then(
      result => !cancelled && setOpened(result.ok
        ? {app: result.data.app, error: null}
        : {app: null, error: result.data.error || `Could not open ${app.name} (${result.status})`}),
      () => !cancelled && setOpened({app: null, error: 'Could not reach the API server'}),
    );
    return () => { cancelled = true; };
  }, [ready, workspace.id, app.id, app.name, moved]);
  if (app.status === 'unavailable') return <UnavailableNotice app={app} />;
  if (!ready) return <MaintenanceNotice app={app} />;
  if (opened.error) return <div className={styles.error}>{opened.error}</div>;
  if (!opened.app) return <p className={styles.muted}>Preparing {app.name}…</p>;
  const onVersion = changed => {
    forgetWorkspaceApps(workspace.id);
    prepareWorkspaceApps(workspace.id, {again: true});
    if (changed.sha256 !== opened.app.sha256) setMoved(count => count + 1);
  };
  return <PluginFrame app={opened.app} workspace={workspace} onVersion={onVersion} />;
}

/** A draft, opened as its computer's NanoAgent installed it; each preview of it opens again (its key). */
function DraftDetail({draft, workspace}) {
  const [opened, setOpened] = React.useState({app: null, error: null});
  React.useEffect(() => {
    let cancelled = false;
    apiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/app-drafts/${encodeURIComponent(draft.id)}`, {fresh: true}).then(
      result => !cancelled && setOpened(result.ok
        ? {app: result.data.app, error: null}
        : {app: null, error: result.data.error || `Could not open ${draft.name} (${result.status})`}),
      () => !cancelled && setOpened({app: null, error: 'Could not reach the API server'}),
    );
    return () => { cancelled = true; };
  }, [workspace.id, draft.id, draft.name]);
  if (opened.error) return <div className={styles.error}>{opened.error}</div>;
  if (!opened.app) return <p className={styles.muted}>Opening {draft.name}…</p>;
  return <PluginFrame app={opened.app} workspace={workspace} />;
}

function AppsColumns() {
  const location = useLocation();
  const {slug, workspace} = useWorkspaceSite();
  const {apps, error} = useWorkspaceApps(workspace);
  const {drafts, error: draftsError, offline} = useWorkspaceDrafts(workspace);
  const navigation = pluginNavigation(apps ?? [], drafts ?? [], location.search, `/w/${encodeURIComponent(slug)}/apps`);
  // Whether the computer said which drafts it has, or could not.
  const draftsKnown = drafts !== null || offline || Boolean(draftsError);

  let content = null;
  if (!slug) content = <p className={styles.muted}>Open Plugins from a workspace.</p>;
  else if (error) content = <div className={styles.error}>{error}</div>;
  else if (navigation.draft) {
    content = <DraftDetail key={`${navigation.draft.id}:${navigation.draft.sha256}`} draft={navigation.draft} workspace={workspace} />;
  } else if (navigation.requestedDraft) {
    if (draftsError) content = <div className={styles.error}>{draftsError}</div>;
    else if (offline) content = <div className={styles.error}>RUSH Lab on your computer is not connected, so its drafts can&apos;t open.</div>;
    else if (drafts) content = <div className={styles.error}>No draft named {navigation.requestedDraft} on this computer.</div>;
  } else if (apps && !apps.length && draftsKnown) {
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
    content = <AppDetail key={navigation.app.id} app={navigation.app} workspace={workspace} />;
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
          showDrafts={drafts !== null || Boolean(draftsError)}
          draftsError={draftsError}
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
