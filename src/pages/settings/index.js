import React, { useCallback, useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import pageStyles from '@site/src/css/page.module.css';
import { useColorMode } from '@docusaurus/theme-common';
import API_BASE, { apiFetch, invalidateApiJson } from '@site/src/utils/api';
import {
  loadWorkspaces, switchWorkspace, createWorkspace, workspaceSlugFromPath,
} from '@site/src/utils/workspaces';
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

  const [session, setSession] = useState(null);
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
  const [navigationText, setNavigationText] = useState('');
  const [siteSaving, setSiteSaving] = useState(false);
  const [siteMessage, setSiteMessage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    // getSession rather than the useSession hook: the hook silently never
    // issued its request, which is what left the auth gate showing the sign-in
    // form to people who were signed in.
    authClient.getSession()
      .then((r) => { if (!cancelled) setSession(r?.data ?? null); })
      .catch(() => { /* the account section simply stays empty */ });

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
    apiFetch(`${API_BASE}/api/workspaces/${encodeURIComponent(activeId)}/site`)
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not load workspace site settings');
        if (cancelled) return;
        setSiteConfig(data.site);
        setNavigationText((data.site.navigation || []).map(item => `${item.label} | ${item.path}`).join('\n'));
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
      const navigation = navigationText.split('\n').map(line => line.trim()).filter(Boolean).map((line, index) => {
        const separator = line.indexOf('|');
        if (separator < 1) throw new Error(`Navigation line ${index + 1} must be “Label | document/path.md”`);
        return {label: line.slice(0, separator).trim(), path: line.slice(separator + 1).trim()};
      });
      const response = await apiFetch(`${API_BASE}/api/workspaces/${encodeURIComponent(activeId)}/site`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({site: {...siteConfig, navigation}}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not save workspace site settings');
      invalidateApiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(activeId)}/site`);
      setSiteConfig(data.site);
      setNavigationText((data.site.navigation || []).map(item => `${item.label} | ${item.path}`).join('\n'));
      setSiteMessage({kind: 'success', text: 'Workspace site settings saved.'});
    } catch (error) {
      setSiteMessage({kind: 'error', text: error.message});
    } finally {
      setSiteSaving(false);
    }
  }, [activeId, navigationText, siteConfig]);

  if (loading) {
    return <div className={styles.placeholder}>Loading your settings...</div>;
  }

  const user = session?.user;
  const activeWorkspace = Array.isArray(workspaces)
    ? workspaces.find(workspace => workspace.id === activeId)
    : null;

  return (
    <div className={`${pageStyles.pageContainer} ${pageStyles.wide}`}>
      <header className={styles.pageHeader}>
        <span className={styles.eyebrow}>Settings</span>
        <h1 className={styles.heading}>{activeWorkspace?.name ?? 'Your workspace'}</h1>
        <p>Manage your account, workspace access, and appearance.</p>
      </header>

      <div className={styles.settingsGrid}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Account</h2>
        {user ? (
          <dl className={styles.account}>
            <dt>Email</dt><dd>{user.email}</dd>
            <dt>Display name</dt><dd>{user.name || <em>not set</em>}</dd>
            <dt>User ID</dt><dd><code>{user.id}</code></dd>
          </dl>
        ) : (
          <p className={styles.muted}>
            Not signed in. Authentication is off, so every request is the local
            development user.
          </p>
        )}
        {user && (
          <button
            type="button"
            className={styles.signOut}
            onClick={() => signOutAndForget().then(() => window.location.reload())}
          >
            Sign out
          </button>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <div>
            <h2 className={styles.sectionTitle}>Organizations</h2>
            <p className={styles.muted}>Switching changes the content and people you see.</p>
          </div>
          {activeWorkspace && (
            <Link className={styles.peopleLink} to={`/w/${encodeURIComponent(activeWorkspace.slug)}/people`}>
              Manage people
            </Link>
          )}
        </div>

        {workspaces === undefined ? (
          <p className={styles.muted}>Loading your workspaces...</p>
        ) : workspaces === null ? (
          <p className={styles.muted}>Could not load your workspaces.</p>
        ) : workspaces.length === 0 ? (
          <p className={styles.muted}>
            You are not in a workspace yet. Create one below, or follow an
            invitation link somebody sends you.
          </p>
        ) : (
          <ul className={styles.workspaces}>
            {workspaces.map((workspace) => (
              <li key={workspace.id} className={`${styles.workspace} ${workspace.id === activeId ? styles.workspaceActive : ''}`}>
                <span className={styles.workspaceMark} aria-hidden="true">
                  {workspace.name.trim().charAt(0).toUpperCase() || 'W'}
                </span>
                <span className={styles.workspaceIdentity}>
                  <strong>{workspace.name}</strong>
                  <em className={styles.muted}>
                    {workspace.role} · {workspace.memberCount}{' '}
                    {workspace.memberCount === 1 ? 'member' : 'members'}
                  </em>
                </span>
                {workspace.id === activeId ? (
                  <span className={styles.currentBadge}>Current</span>
                ) : (
                  <button
                    type="button"
                    className={styles.signOut}
                    disabled={switching}
                    onClick={() => workspaceAction(() => switchWorkspace(workspace))}
                  >
                    Switch to this
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <form
          className={styles.createWorkspace}
          onSubmit={(e) => {
            e.preventDefault();
            // No slug: left out, the server derives one from the name and
            // numbers it if that is already taken.
            workspaceAction(() => createWorkspace({ name: newWorkspace }));
          }}
        >
          <span className={styles.createLabel}>Create organization</span>
          <input
            type="text"
            value={newWorkspace}
            onChange={(e) => setNewWorkspace(e.target.value)}
            placeholder="Organization name"
            minLength={2}
            maxLength={60}
            required
          />
          <button
            type="submit"
            className={styles.signOut}
            disabled={switching || newWorkspace.trim().length < 2}
          >
            Create
          </button>
        </form>

        {workspaceError && <p className={styles.error} role="alert">{workspaceError}</p>}

        <p className={styles.muted}>
          You can also switch organizations directly from the logo in the top-left corner.
        </p>
      </section>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Preferences</h2>

        <label className={styles.field}>
          <span>Theme</span>
          <select
            value={prefs?.theme ?? 'system'}
            disabled={saving}
            onChange={(e) => {
              const choice = THEMES.find((t) => t.value === e.target.value);
              // Apply it before saving, so the page changes as you choose
              // rather than after a round trip.
              setColorMode(choice.colorMode);
              save({ theme: choice.value });
            }}
          >
            {THEMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>

        <p className={styles.muted}>
          Stored on your account, so it follows you to another browser. The navbar
          toggle changes this device only.
        </p>

        {status && <p className={styles.status}>{status}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}

        {prefs?.updatedAt && (
          <p className={styles.muted}>
            Last saved {new Date(prefs.updatedAt).toLocaleString()}
          </p>
        )}
      </section>

      {activeWorkspace ? (
        <section className={styles.section}>
          <div className={styles.sectionTitleRow}>
            <div>
              <h2 className={styles.sectionTitle}>Workspace site</h2>
              <p className={styles.muted}>Data-only Docusaurus presentation. Changes do not rebuild the app.</p>
            </div>
            <Link className={styles.peopleLink} to={`/w/${encodeURIComponent(activeWorkspace.slug)}/files`}>
              Manage files
            </Link>
          </div>
          {!siteConfig ? <p className={styles.muted}>Loading site settings…</p> : (
            <div className={styles.siteFields}>
              <label>
                <span>Site title</span>
                <input
                  value={siteConfig.site.title || ''}
                  readOnly={activeWorkspace.role !== 'owner'}
                  onChange={event => setSiteConfig(current => ({...current, site: {...current.site, title: event.target.value}}))}
                />
              </label>
              <label>
                <span>Tagline</span>
                <input
                  value={siteConfig.site.tagline || ''}
                  readOnly={activeWorkspace.role !== 'owner'}
                  onChange={event => setSiteConfig(current => ({...current, site: {...current.site, tagline: event.target.value}}))}
                />
              </label>
              <label>
                <span>Home document</span>
                <input
                  value={siteConfig.site.homeDocument || ''}
                  readOnly={activeWorkspace.role !== 'owner'}
                  placeholder="books/programming/0-intro.md"
                  onChange={event => setSiteConfig(current => ({...current, site: {...current.site, homeDocument: event.target.value}}))}
                />
              </label>
              <label>
                <span>Navigation</span>
                <textarea
                  value={navigationText}
                  readOnly={activeWorkspace.role !== 'owner'}
                  rows={Math.max(4, navigationText.split('\n').length + 1)}
                  placeholder={'Research | posts/research\nProgramming | books/programming/0-intro.md'}
                  onChange={event => setNavigationText(event.target.value)}
                />
              </label>
              <div className={styles.renderingFlags}>
                {Object.entries(siteConfig.rendering || {}).map(([name, enabled]) => (
                  <label key={name}>
                    <input
                      type="checkbox"
                      checked={Boolean(enabled)}
                      disabled={activeWorkspace.role !== 'owner'}
                      onChange={event => setSiteConfig(current => ({
                        ...current,
                        rendering: {...current.rendering, [name]: event.target.checked},
                      }))}
                    />
                    {name}
                  </label>
                ))}
              </div>
              {activeWorkspace.role === 'owner' ? (
                <button type="button" className={styles.signOut} disabled={siteSaving} onClick={saveSite}>
                  {siteSaving ? 'Saving…' : 'Save workspace site'}
                </button>
              ) : <p className={styles.muted}>Only workspace owners can change these settings.</p>}
              {siteMessage ? (
                <p className={siteMessage.kind === 'error' ? styles.error : styles.status} role="status">
                  {siteMessage.text}
                </p>
              ) : null}
            </div>
          )}
        </section>
      ) : null}
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
