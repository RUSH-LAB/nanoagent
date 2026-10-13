import React, { useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {useLocation} from '@docusaurus/router';
import Avatar from '@site/src/components/Avatar';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import {clientPlatform} from '@site/src/platform/client';
import {workspaceSlugFromPath} from '@site/src/utils/workspaces';
import {useAccount} from '@site/src/utils/account';
import {PaneHeading} from './_parts';
import TwoColumnLayout from '@site/src/components/TwoColumnLayout';
import Ai from './_Ai';
import Leave from './_Leave';
import People from './_People';
import Plugins from './_Plugins';
import SettingsSidebar from './_Sidebar';
import styles from './styles.module.css';

/** GitHub's mark (Octicons mark-github). */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function SettingsApp() {
  const { signOutAndForget } = require('@site/src/utils/authClient');
  const location = useLocation();
  const workspaceSlug = workspaceSlugFromPath(location.pathname);

  const {account: user, workspaces, defaultWorkspaceId} = useAccount();
  const activeId = workspaces.find(workspace => workspace.slug === workspaceSlug)?.id ?? defaultWorkspaceId;
  const activeWorkspace = workspaces.find(workspace => workspace.id === activeId) ?? null;
  const [signingOut, setSigningOut] = useState(false);
  const signOut = async () => {
    setSigningOut(true);
    try {
      await signOutAndForget();
    } finally {
      clientPlatform.location.assign('/');
    }
  };
  const groups = [
    {id: 'user', label: 'User', panes: [
      {id: 'account', label: 'Account'},
      {id: 'ai', label: 'AI'},
      ...(activeWorkspace ? [{id: 'membership', label: 'Membership'}] : []),
    ]},
    ...(activeWorkspace ? [{id: 'workspace', label: 'Workspace', panes: [
      {id: 'people', label: 'People'},
      {id: 'plugins', label: 'Plugins'},
    ]}] : []),
  ];
  const paneIds = groups.flatMap(group => group.panes.map(pane => pane.id)).join(' ');
  const [visible, setVisible] = useState('account');
  const activePane = paneIds.split(' ').includes(visible) ? visible : 'account';
  // Highlights the section nearest the top of the viewport as the page scrolls.
  useEffect(() => {
    const sections = paneIds.split(' ').map(id => document.getElementById(id)).filter(Boolean);
    const observer = new IntersectionObserver(entries => {
      const top = entries.filter(entry => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setVisible(top.target.id);
    }, {rootMargin: '-20% 0px -60% 0px'});
    sections.forEach(section => observer.observe(section));
    return () => observer.disconnect();
  }, [paneIds]);

  return (
    <TwoColumnLayout
      sidebarKey="settings"
      showSidebarOnMobile
      evenGutters
      renderSidebar={({collapsed, onCollapse}) => (
        <SettingsSidebar
          groups={groups}
          activePane={activePane}
          collapsed={collapsed}
          onCollapse={onCollapse}
        />
      )}
    >
      <div className={styles.settingsContent}>
        <div className={styles.settingsGroup}>
          <h2 className={styles.settingsGroupHeading}>User</h2>
          <section id="account" className={styles.pane}>
            <PaneHeading title="Account" />
            {user ? (
              <section className={styles.group}>
                <div className={styles.identity}>
                  <Avatar user={user} size={48} />
                  <div className={styles.identityText}>
                    <strong>{user.name}</strong>
                    <span><GitHubMark /> Signed in with GitHub</span>
                  </div>
                  <button type="button" className={styles.secondaryButton} disabled={signingOut} onClick={signOut}>
                    {signingOut ? 'Signing out…' : 'Sign out'}
                  </button>
                </div>
              </section>
            ) : null}
          </section>

          <section id="ai" className={styles.pane}>
            <Ai />
          </section>

          {activeWorkspace && (
            <section id="membership" className={styles.pane}>
              <PaneHeading title="Membership" />
              <Leave key={activeWorkspace.id} workspace={activeWorkspace} />
            </section>
          )}
        </div>

        {activeWorkspace && (
          <div className={styles.settingsGroup}>
            <h2 className={styles.settingsGroupHeading}>Workspace</h2>
            <section id="people" className={styles.pane}>
              <People key={activeWorkspace.id} workspace={activeWorkspace} />
            </section>
            <section id="plugins" className={styles.pane}>
              <Plugins key={activeWorkspace.id} workspace={activeWorkspace} />
            </section>
          </div>
        )}
      </div>
    </TwoColumnLayout>
  );
}

export default function SettingsPage() {
  return (
    <Layout title="Settings" description="Your account and workspace access">
      <ErrorBoundary>
        <BrowserOnly fallback={<div className={styles.placeholder}>Loading...</div>}>
          {() => <SettingsApp />}
        </BrowserOnly>
      </ErrorBoundary>
    </Layout>
  );
}
