import React, { useState } from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {authClient} from '@site/src/utils/authClient';
import API_BASE from '@site/src/utils/api';
import styles from './authScreen.module.css';

/**
 * The sign-in and sign-up screen, shown in place of the site whenever nobody is
 * signed in.
 *
 * Two modes on one form rather than two routes, because the gate renders above
 * the router: at this point Docusaurus has not decided what page you are on, so
 * there is nowhere to navigate to.
 *
 * Accounts use an email address and password. Display names are optional and
 * are not credentials.
 *
 * With `devAutoLogin` there is also a one-click sign-in as root. The server
 * performs an ordinary password sign-in on our behalf and refuses unless it is
 * outside production, explicitly enabled, and called from loopback, so the
 * button is a shortcut past the keyboard rather than past authentication.
 */
export default function AuthScreen({ devAutoLogin = false, googleAuthEnabled = false, unreachable = null }) {
  const {siteConfig} = useDocusaurusContext();
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const signingIn = mode === 'signin';

  async function signInAsRoot() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/dev-login`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || 'Development sign-in was refused.');
      }
      window.location.reload();
    } catch (err) {
      setError(
        err?.message?.includes('fetch')
          ? 'Could not reach the API server on port 3001. Is it running?'
          : err.message,
      );
      setBusy(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (signingIn && email.trim().toLowerCase() === 'root@mochi.local') {
        const response = await fetch(`${API_BASE}/api/dev-login`, {
          method: 'POST',
          credentials: 'include',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({email: email.trim().toLowerCase(), password}),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok && response.status !== 404) throw new Error(body.error || 'Root sign-in failed.');
        if (response.ok) {
          window.location.reload();
          return;
        }
      }
      const result = signingIn
        ? await authClient.signIn.email({email, password})
        : await authClient.signUp.email({email, password, name: name || email.split('@')[0]});

      if (result?.error) {
        setError(result.error.message || 'Something went wrong. Please try again.');
        return;
      }
      window.location.reload();
    } catch (err) {
      setError(err?.message || 'Could not reach the API server. Is it running on port 3001?');
    } finally {
      setBusy(false);
    }
  }

  async function signInWithGoogle() {
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.signIn.social({
        provider: 'google',
        callbackURL: window.location.href,
      });
      if (result?.error) setError(result.error.message || 'Google sign-in failed.');
    } catch (err) {
      setError(err?.message || 'Google sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <img src="/img/mochi.jpg" alt="" className={styles.logo} />
        <h1 className={styles.title}>{siteConfig.title}</h1>
        <p className={styles.tagline}>
          {signingIn ? 'Sign in to continue' : 'Create an account'}
        </p>

        {googleAuthEnabled && (
          <>
            <button type="button" className={styles.googleButton} onClick={signInWithGoogle} disabled={busy}>
              <span aria-hidden="true">G</span>
              Continue with Google
            </button>
            <div className={styles.divider}><span>or use email</span></div>
          </>
        )}

        {devAutoLogin && signingIn && (
          <>
            <button
              type="button"
              className={styles.rootButton}
              onClick={signInAsRoot}
              disabled={busy}
            >
              Sign in as root
            </button>
            <p className={styles.rootHint}>
              Local development. No password needed.
            </p>
            <div className={styles.divider}><span>or</span></div>
          </>
        )}

        <label className={styles.field}>
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
            required
          />
        </label>

        {!signingIn && (
            <label className={styles.field}>
              <span>Display name <em>(optional)</em></span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            </label>
        )}

        <label className={styles.field}>
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={signingIn ? 'current-password' : 'new-password'}
            minLength={8}
            required
          />
        </label>

        {!signingIn && (
          <p className={styles.hint}>At least 8 characters.</p>
        )}

        {unreachable && !error && (
          <p className={styles.error} role="alert">
            Could not reach the API server on {API_BASE || 'this origin'}. Start it with{' '}
            <code>npm start</code>, then reload. ({unreachable})
          </p>
        )}

        {error && <p className={styles.error} role="alert">{error}</p>}

        <button type="submit" className={styles.submit} disabled={busy}>
          {busy ? 'Working...' : signingIn ? 'Sign in' : 'Create account'}
        </button>

        <button
          type="button"
          className={styles.switch}
          onClick={() => { setMode(signingIn ? 'signup' : 'signin'); setError(null); }}
        >
          {signingIn ? 'No account? Create one' : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
