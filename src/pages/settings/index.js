import React, { useCallback, useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import pageStyles from '@site/src/css/page.module.css';
import API_BASE, { apiFetch } from '@site/src/utils/api';
import styles from './styles.module.css';

/**
 * Account and preferences.
 *
 * The preferences API has existed for a long time with nothing on the other end
 * of it; this is that end. Everything here is scoped to the signed-in caller by
 * the server, so there is no user id to pass and no way to read anyone else's
 * settings by asking.
 */

const THEMES = [
  { value: 'system', label: 'Follow system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function SettingsApp() {
  const { useSession, signOutAndForget } = require('@site/src/utils/authClient');
  const { data: session } = useSession();

  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`${API_BASE}/api/preferences`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setPrefs(d.preferences || {}); })
      .catch(() => { if (!cancelled) setError('Could not load your settings. Is the API server running?'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
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

  if (loading) {
    return <div className={styles.placeholder}>Loading your settings...</div>;
  }

  const user = session?.user;

  return (
    <div className={pageStyles.pageContainer}>
      <h1 className={styles.heading}>Settings</h1>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Account</h2>
        {user ? (
          <dl className={styles.account}>
            <dt>Username</dt><dd>{user.username || <em>not set</em>}</dd>
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
        <h2 className={styles.sectionTitle}>Preferences</h2>

        <label className={styles.field}>
          <span>Theme</span>
          <select
            value={prefs?.theme ?? 'system'}
            disabled={saving}
            onChange={(e) => save({ theme: e.target.value })}
          >
            {THEMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>

        <label className={styles.field}>
          <span>Editor font size</span>
          <input
            type="number"
            min={10}
            max={32}
            defaultValue={prefs?.fontSize ?? 16}
            disabled={saving}
            onBlur={(e) => {
              const fontSize = Number(e.target.value);
              if (Number.isFinite(fontSize) && fontSize !== prefs?.fontSize) save({ fontSize });
            }}
          />
        </label>

        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={Boolean(prefs?.compactSidebar)}
            disabled={saving}
            onChange={(e) => save({ compactSidebar: e.target.checked })}
          />
          <span>Compact sidebar</span>
        </label>

        {status && <p className={styles.status}>{status}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}

        {prefs?.updatedAt && (
          <p className={styles.muted}>
            Last saved {new Date(prefs.updatedAt).toLocaleString()}
          </p>
        )}
      </section>
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
