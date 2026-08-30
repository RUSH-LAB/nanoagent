import React, { useState } from 'react';
import { authClient, setStoredToken } from '@site/src/utils/authClient';
import styles from './authScreen.module.css';

/**
 * The sign-in and sign-up screen, shown in place of the site whenever nobody is
 * signed in.
 *
 * Two modes on one form rather than two routes, because the gate renders above
 * the router: at this point Docusaurus has not decided what page you are on, so
 * there is nowhere to navigate to.
 *
 * Sign-in accepts either a username or an email address in the same field, and
 * picks the endpoint by looking for an "@". That keeps one input where two
 * would only ask the user to classify their own credential.
 */
export default function AuthScreen() {
  const [mode, setMode] = useState('signin');
  const [identifier, setIdentifier] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const signingIn = mode === 'signin';

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = signingIn
        ? identifier.includes('@')
          ? await authClient.signIn.email({ email: identifier, password })
          : await authClient.signIn.username({ username: identifier, password })
        : await authClient.signUp.email({ email, password, name: name || username, username });

      if (result?.error) {
        setError(result.error.message || 'Something went wrong. Please try again.');
        return;
      }
      // The client's onSuccess hook stores the token, but a full reload is the
      // simplest way to re-run every page's data fetch as the new user rather
      // than leaving stale unauthenticated results on screen.
      if (result?.data?.token) setStoredToken(result.data.token);
      window.location.reload();
    } catch (err) {
      setError(err?.message || 'Could not reach the API server. Is it running on port 3001?');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <img src="/img/mochi.jpg" alt="" className={styles.logo} />
        <h1 className={styles.title}>Mochi Lab</h1>
        <p className={styles.tagline}>
          {signingIn ? 'Sign in to continue' : 'Create an account'}
        </p>

        {signingIn ? (
          <label className={styles.field}>
            <span>Username or email</span>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </label>
        ) : (
          <>
            <label className={styles.field}>
              <span>Username</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                minLength={3}
                autoFocus
                required
              />
            </label>
            <label className={styles.field}>
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label className={styles.field}>
              <span>Display name <em>(optional)</em></span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            </label>
          </>
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
