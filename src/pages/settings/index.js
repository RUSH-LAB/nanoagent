import React, { useCallback, useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import pageStyles from '@site/src/css/page.module.css';
import {
  loadWorkspaces, switchWorkspace, createWorkspace, workspaceSlugFromPath,
} from '@site/src/utils/workspaces';
import styles from './styles.module.css';

function SettingsApp() {
  const { authClient } = require('@site/src/utils/authClient');
  const location = useLocation();
  const workspaceSlug = workspaceSlugFromPath(location.pathname);

  // undefined is loading, null is a confirmed signed-out development session.
  const [session, setSession] = useState(undefined);
  // undefined until the request answers, then the list, or null if it failed.
  // Three states rather than two, so a slow load does not read as a failed one.
  const [workspaces, setWorkspaces] = useState(undefined);
  const [activeId, setActiveId] = useState(null);
  const [newWorkspace, setNewWorkspace] = useState('');
  const [switching, setSwitching] = useState(false);
  const [workspaceError, setWorkspaceError] = useState(null);
  const activeWorkspace = Array.isArray(workspaces)
    ? workspaces.find(workspace => workspace.id === activeId)
    : null;

  useEffect(() => {
    let cancelled = false;
    // getSession rather than the useSession hook: the hook silently never
    // issued its request, which is what left the auth gate showing the sign-in
    // form to people who were signed in.
    authClient.getSession()
      .then((r) => { if (!cancelled) setSession(r?.data ?? null); })
      .catch(() => { if (!cancelled) setSession(null); });

    loadWorkspaces()
      .then((d) => {
        if (cancelled) return;
        const memberships = d.workspaces || d.memberships || [];
        setWorkspaces(memberships);
        setActiveId(memberships.find(workspace => workspace.slug === workspaceSlug)?.id
          ?? d.defaultWorkspaceId ?? d.activeId ?? null);
      })
      .catch(() => { if (!cancelled) setWorkspaces(null); });

    return () => { cancelled = true; };
  }, [authClient, workspaceSlug]);

  /**
   * Run one of the workspace writes. Both reload the page on success, from
   * within src/utils/workspaces, so there is nothing to do here but report a
   * refusal and hand the buttons back.
   */
  const workspaceAction = useCallback(async (write) => {
    setSwitching(true);
    setWorkspaceError(null);
    try {
      await write();
    } catch (err) {
      setWorkspaceError(err.message);
      setSwitching(false);
    }
  }, []);

  const user = session?.user;
  return (
    <div className={`${pageStyles.pageContainer} ${pageStyles.wide}`}>
      <header className={styles.pageHeader}>
        <span className={styles.eyebrow}>Settings</span>
        <div className={styles.headerRow}>
          <div>
            <h1 className={styles.heading}>Settings</h1>
            <p>Manage your account and workspace access.</p>
          </div>
          {activeWorkspace && (
            <div className={styles.workspaceContext}>
              <span className={styles.workspaceMark} aria-hidden="true">
                {activeWorkspace.name.trim().charAt(0).toUpperCase() || 'W'}
              </span>
              <span>
                <strong>{activeWorkspace.name}</strong>
                <small>{activeWorkspace.role}</small>
              </span>
            </div>
          )}
        </div>
      </header>

      <div className={styles.settingsLayout}>
        <nav className={styles.settingsNav} aria-label="Settings sections">
          <a href="#account"><strong>Account</strong><span>Identity and session</span></a>
          <a href="#workspaces"><strong>Workspaces</strong><span>Access and switching</span></a>
        </nav>

        <div className={styles.settingsContent}>
          <section id="account" className={styles.section}>
            <div className={styles.sectionHeading}>
              <div><h2>Account</h2><p>Your personal identity and session.</p></div>
            </div>
            {session === undefined ? (
              <p className={styles.muted}>Loading account…</p>
            ) : user ? (
              <dl className={styles.account}>
                <dt>Email</dt><dd>{user.email}</dd>
                <dt>Name</dt><dd>{user.name || <em>Not set</em>}</dd>
              </dl>
            ) : (
              <p className={styles.muted}>Authentication is disabled; requests use the local development account.</p>
            )}
          </section>

          <section id="workspaces" className={styles.section}>
            <div className={styles.sectionTitleRow}>
              <div className={styles.sectionHeading}>
                <div><h2>Workspaces</h2><p>Switch organizations or create a new one.</p></div>
              </div>
              {activeWorkspace && <Link className={styles.textButton} to={`/w/${encodeURIComponent(activeWorkspace.slug)}/people`}>Manage people</Link>}
            </div>

            {workspaces === undefined ? <p className={styles.muted}>Loading workspaces…</p>
              : workspaces === null ? <p className={styles.error}>Could not load your workspaces.</p>
                : workspaces.length === 0 ? <p className={styles.muted}>You are not in a workspace yet. Create one or follow an invitation link.</p>
                  : (
                    <ul className={styles.workspaces}>
                      {workspaces.map((workspace) => (
                        <li key={workspace.id} className={`${styles.workspace} ${workspace.id === activeId ? styles.workspaceActive : ''}`}>
                          <span className={styles.workspaceMark} aria-hidden="true">{workspace.name.trim().charAt(0).toUpperCase() || 'W'}</span>
                          <span className={styles.workspaceIdentity}>
                            <strong>{workspace.name}</strong>
                            <em>{workspace.role} · {workspace.memberCount} {workspace.memberCount === 1 ? 'member' : 'members'}</em>
                          </span>
                          {workspace.id === activeId ? <span className={styles.currentBadge}>Current</span> : (
                            <button type="button" className={styles.secondaryButton} disabled={switching} onClick={() => workspaceAction(() => switchWorkspace(workspace))}>
                              Switch
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

            <form className={styles.createWorkspace} onSubmit={(e) => {
              e.preventDefault();
              workspaceAction(() => createWorkspace({name: newWorkspace}));
            }}>
              <label htmlFor="new-workspace">Create workspace</label>
              <div className={styles.inlineForm}>
                <input id="new-workspace" type="text" value={newWorkspace} onChange={(e) => setNewWorkspace(e.target.value)} placeholder="Workspace name" minLength={2} maxLength={60} required />
                <button type="submit" className={styles.primaryButton} disabled={switching || newWorkspace.trim().length < 2}>Create</button>
              </div>
            </form>
            {workspaceError && <p className={styles.error} role="alert">{workspaceError}</p>}
          </section>

        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Layout title="Settings" description="Your account and workspace access">
      <ErrorBoundary>
        <main>
          <BrowserOnly fallback={<div className={styles.placeholder}>Loading...</div>}>
            {() => <SettingsApp />}
          </BrowserOnly>
        </main>
      </ErrorBoundary>
    </Layout>
  );
}
