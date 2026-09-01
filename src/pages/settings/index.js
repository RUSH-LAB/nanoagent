import React, { useCallback, useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import pageStyles from '@site/src/css/page.module.css';
import { useColorMode } from '@docusaurus/theme-common';
import API_BASE, { apiFetch, apiJson, invalidateApiJson } from '@site/src/utils/api';
import {
  loadWorkspaces, switchWorkspace, createWorkspace, workspaceSlugFromPath,
} from '@site/src/utils/workspaces';
import {publishWorkspaceSite} from '@site/src/hooks/useWorkspaceSite';
import styles from './styles.module.css';

/**
 * Account and preferences.
 *
 * The preferences API has existed for a long time with nothing on the other end
 * of it; this is that end. Everything here is scoped to the signed-in caller by
 * the server, so there is no user id to pass and no way to read anyone else's
 * settings by asking.
 */

/**
 * Docusaurus models "follow the system" as a null colour mode, so the stored
 * preference and the theme's own value are not quite the same vocabulary.
 */
const THEMES = [
  { value: 'system', label: 'Follow system', colorMode: null },
  { value: 'light', label: 'Light', colorMode: 'light' },
  { value: 'dark', label: 'Dark', colorMode: 'dark' },
];

function SettingsApp() {
  const { authClient, signOutAndForget } = require('@site/src/utils/authClient');
  const { setColorMode } = useColorMode();
  const location = useLocation();
  const workspaceSlug = workspaceSlugFromPath(location.pathname);

  // undefined is loading, null is a confirmed signed-out development session.
  const [session, setSession] = useState(undefined);
  const [prefs, setPrefs] = useState(null);
  // undefined until the request answers, then the list, or null if it failed.
  // Three states rather than two, so a slow load does not read as a failed one.
  const [workspaces, setWorkspaces] = useState(undefined);
  const [activeId, setActiveId] = useState(null);
  const [newWorkspace, setNewWorkspace] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  // Its own, because the preferences error renders in the section below and a
  // failed switch reported down there would look like a failed theme change.
  const [workspaceError, setWorkspaceError] = useState(null);
  const [siteConfig, setSiteConfig] = useState(null);
  const [siteSaving, setSiteSaving] = useState(false);
  const [siteMessage, setSiteMessage] = useState(null);
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

    apiFetch(`${API_BASE}/api/preferences`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setPrefs(d.preferences || {}); })
      .catch(() => { if (!cancelled) setError('Could not load your settings. Is the API server running?'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authClient, workspaceSlug]);

  useEffect(() => {
    if (!activeId) {
      setSiteConfig(null);
      return undefined;
    }
    let cancelled = false;
    apiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(activeId)}/site`, {cacheMs: 5 * 60_000})
      .then(result => {
        const data = result.data;
        if (!result.ok) throw new Error(data.error || 'Could not load workspace site settings');
        if (cancelled) return;
        setSiteConfig(data.site);
      })
      .catch(error => { if (!cancelled) setSiteMessage({kind: 'error', text: error.message}); });
    return () => { cancelled = true; };
  }, [activeId]);

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

  const save = useCallback(async (patch) => {
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: patch }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setPrefs(data.preferences);
      setStatus('Saved.');
      setTimeout(() => setStatus(null), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, []);

  const saveSite = useCallback(async () => {
    if (!activeId || !siteConfig) return;
    setSiteSaving(true);
    setSiteMessage(null);
    try {
      const response = await apiFetch(`${API_BASE}/api/workspaces/${encodeURIComponent(activeId)}/site/navigation`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({navigation: siteConfig.navigation}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not save workspace site settings');
      invalidateApiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(activeId)}/site`);
      setSiteConfig(data.site);
      publishWorkspaceSite(activeWorkspace?.slug, data.site);
      setSiteMessage({kind: 'success', text: 'Workspace site settings saved.'});
    } catch (error) {
      setSiteMessage({kind: 'error', text: error.message});
    } finally {
      setSiteSaving(false);
    }
  }, [activeId, activeWorkspace?.slug, siteConfig]);

  const setNavigationVisibility = useCallback((index, visible) => {
    setSiteConfig(current => ({
      ...current,
      navigation: current.navigation.map((item, itemIndex) => (
        itemIndex === index ? {...item, hidden: !visible} : item
      )),
    }));
  }, []);

  const moveNavigation = useCallback((index, direction) => {
    setSiteConfig(current => {
      const destination = index + direction;
      if (destination < 0 || destination >= current.navigation.length) return current;
      const navigation = [...current.navigation];
      [navigation[index], navigation[destination]] = [navigation[destination], navigation[index]];
      return {...current, navigation};
    });
  }, []);

  const user = session?.user;
  const canManageSite = activeWorkspace?.role === 'owner';
  return (
    <div className={`${pageStyles.pageContainer} ${pageStyles.wide}`}>
      <header className={styles.pageHeader}>
        <span className={styles.eyebrow}>Settings</span>
        <div className={styles.headerRow}>
          <div>
            <h1 className={styles.heading}>Settings</h1>
            <p>Manage your account, appearance, and workspace access.</p>
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
          <a href="#appearance"><strong>Appearance</strong><span>Your personal theme</span></a>
          <a href="#workspaces"><strong>Workspaces</strong><span>Access and switching</span></a>
          {canManageSite && <a href="#workspace-navigation"><strong>Navigation</strong><span>Order and visibility</span></a>}
        </nav>

        <div className={styles.settingsContent}>
          <div className={styles.overviewGrid}>
            <section id="account" className={styles.section}>
              <div className={styles.sectionHeading}>
                <div><h2>Account</h2><p>Your personal identity and session.</p></div>
              </div>
              {session === undefined ? (
                <p className={styles.muted}>Loading account…</p>
              ) : user ? (
                <>
                  <dl className={styles.account}>
                    <dt>Email</dt><dd>{user.email}</dd>
                    <dt>Display name</dt><dd>{user.name || <em>Not set</em>}</dd>
                  </dl>
                  <div className={styles.sectionActions}>
                    <button type="button" className={styles.dangerButton} onClick={() => signOutAndForget().then(() => window.location.reload())}>
                      Sign out
                    </button>
                  </div>
                </>
              ) : (
                <p className={styles.muted}>Authentication is disabled; requests use the local development account.</p>
              )}
            </section>

            <section id="appearance" className={styles.section}>
              <div className={styles.sectionHeading}>
                <div><h2>Appearance</h2><p>Personal settings that follow your account.</p></div>
              </div>
              {loading ? <p className={styles.muted}>Loading preferences…</p> : (
                <label className={styles.field}>
                  <span><strong>Theme</strong><small>Choose a light, dark, or system appearance.</small></span>
                  <select
                    value={prefs?.theme ?? 'system'}
                    disabled={saving}
                    onChange={(e) => {
                      const choice = THEMES.find((t) => t.value === e.target.value);
                      setColorMode(choice.colorMode);
                      save({ theme: choice.value });
                    }}
                  >
                    {THEMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </label>
              )}
              {status && <p className={styles.status} role="status">{status}</p>}
              {error && <p className={styles.error} role="alert">{error}</p>}
              {prefs?.updatedAt && <p className={styles.savedAt}>Last saved {new Date(prefs.updatedAt).toLocaleString()}</p>}
            </section>
          </div>

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

          {canManageSite && (
            <section id="workspace-navigation" className={styles.section}>
              <div className={styles.sectionTitleRow}>
                <div className={styles.sectionHeading}>
                  <div><h2>Navigation</h2><p>Choose which existing links appear in the navbar and arrange their order.</p></div>
                </div>
                <Link className={styles.textButton} to={`/w/${encodeURIComponent(activeWorkspace.slug)}/files`}>Manage files</Link>
              </div>

              {!siteConfig ? <p className={styles.muted}>Loading navigation…</p> : (
                <div className={styles.siteFields}>
                  <div className={styles.navigationList}>
                    {siteConfig.navigation.length === 0 && <p className={styles.emptyState}>No workspace navigation has been configured.</p>}
                    {siteConfig.navigation.map((item, index) => (
                      <div className={`${styles.navigationItem} ${item.hidden ? styles.navigationItemHidden : ''}`} key={`${item.label}:${item.path}`}>
                        <span className={styles.navigationPosition}>{index + 1}</span>
                        <span className={styles.navigationIdentity}>
                          <strong>{item.label}</strong>
                          <small>{item.path}</small>
                        </span>
                        <label className={styles.visibilityToggle}>
                          <input type="checkbox" checked={!item.hidden} onChange={event => setNavigationVisibility(index, event.target.checked)} />
                          <span>Show</span>
                        </label>
                        <span className={styles.orderButtons}>
                          <button type="button" disabled={index === 0} aria-label={`Move ${item.label} up`} onClick={() => moveNavigation(index, -1)}>↑</button>
                          <button type="button" disabled={index === siteConfig.navigation.length - 1} aria-label={`Move ${item.label} down`} onClick={() => moveNavigation(index, 1)}>↓</button>
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className={styles.saveBar}>
                    <span>Content types and paths are managed separately to prevent accidental route changes.</span>
                    {siteMessage && <span className={siteMessage.kind === 'error' ? styles.error : styles.status} role="status">{siteMessage.text}</span>}
                    <button type="button" className={styles.primaryButton} disabled={siteSaving} onClick={saveSite}>{siteSaving ? 'Saving…' : 'Save navigation'}</button>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Layout title="Settings" description="Your account and preferences">
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
