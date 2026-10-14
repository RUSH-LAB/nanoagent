import React, { useEffect, useState } from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {authClient} from '@site/src/utils/authClient';
import API_BASE from '@site/src/utils/api';
import {clientPlatform} from '@site/src/platform/client';
import {isSignInPage, nextFrom} from '@site/src/utils/signIn';
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
        callbackURL: isSignInPage(clientPlatform.location.pathname())
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
        <img src="/img/rush-lab.png" alt="" className={styles.logo} />
        <h1 className={styles.title}>Sign in to {siteConfig.title}</h1>
        <p className={styles.tagline}>{siteConfig.tagline}</p>

        {unreachable && !error && (
          <p className={styles.error} role="alert">
            Could not reach the API server on {API_BASE || 'this origin'}. Start it with{' '}
            <code>npm start</code>, then reload. ({unreachable})
          </p>
        )}

        {error && <p className={styles.error} role="alert">{error}</p>}

        <button type="button" className={styles.githubButton} onClick={signInWithGitHub} disabled={busy}>
          <GitHubMark />
          {busy ? 'Opening GitHub…' : 'Continue with GitHub'}
        </button>

        {policy && policy.signupMode !== 'open' && (
          <p className={styles.note}>
            <LockIcon />
            <span>
              {policy.signupMode === 'invite' ? (
                <><strong>Invitation only.</strong> New here? Use the GitHub account that was invited, or one whose primary email was.</>
              ) : (
                <><strong>Approved addresses only.</strong> New here? Use a GitHub account whose primary email was approved.</>
              )}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4zm1.5 0h5V5a2.5 2.5 0 0 0-5 0v2z" />
    </svg>
  );
}
