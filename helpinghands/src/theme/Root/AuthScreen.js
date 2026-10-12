import React, { useEffect, useState } from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {authClient} from '@site/src/utils/authClient';
import API_BASE from '@site/src/utils/api';
import {clientPlatform} from '@site/src/platform/client';
import {SIGN_IN_PATH, nextFrom} from '@site/src/utils/signIn';
import styles from './authScreen.module.css';

/**
 * The sign-in screen: the sign-in page (pages/signin), and in place of the site
 * when the API server cannot be reached.
 *
 * GitHub is the only way in. Signing in for the first time creates the account,
 * under the GitHub account's verified primary email, when the server's sign-up
 * policy (open, invitation, or allowlist) admits that address; the screen says
 * which policy applies. GitHub sends the browser back to the page it left, or
 * from the sign-in page to the page the visitor was sent there from.
 */
export default function AuthScreen({ unreachable = null }) {
  const {siteConfig} = useDocusaurusContext();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/signup-policy`, {credentials: 'include'})
      .then(res => (res.ok ? res.json() : null))
      .then(setPolicy)
      .catch(() => setPolicy(null));
  }, []);

  async function signInWithGitHub() {
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.signIn.social({
        provider: 'github',
        callbackURL: clientPlatform.location.pathname().replace(/\/$/, '') === SIGN_IN_PATH
          ? `${clientPlatform.location.origin()}${nextFrom(clientPlatform.location.search())}`
          : clientPlatform.location.href(),
      });
      if (result?.error) setError(result.error.message || 'GitHub sign-in failed.');
    } catch (err) {
      setError(err?.message || 'GitHub sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <img src="/img/mochi.jpg" alt="" className={styles.logo} />
        <h1 className={styles.title}>{siteConfig.title}</h1>
        <p className={styles.tagline}>Sign in to continue</p>

        {policy && policy.signupMode !== 'open' && (
          <p className={styles.hint}>
            {policy.signupMode === 'invite'
              ? 'New accounts are by invitation. Sign in with the GitHub account whose primary email was invited.'
              : 'New accounts are limited to approved addresses.'}
          </p>
        )}

        {unreachable && !error && (
          <p className={styles.error} role="alert">
            Could not reach the API server on {API_BASE || 'this origin'}. Start it with{' '}
            <code>npm start</code>, then reload. ({unreachable})
          </p>
        )}

        {error && <p className={styles.error} role="alert">{error}</p>}

        <button type="button" className={styles.githubButton} onClick={signInWithGitHub} disabled={busy}>
          {busy ? 'Working...' : 'Continue with GitHub'}
        </button>
      </div>
    </div>
  );
}
