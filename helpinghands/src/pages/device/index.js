import React, {useEffect, useState} from 'react';
import Head from '@docusaurus/Head';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {useAccount} from '@site/src/utils/account';
import styles from '@site/src/theme/Root/authScreen.module.css';

/**
 * Where `rush login` sends you, and where RUSH Lab sends you to connect a
 * computer (`client=desktop`: the app's window, desktop/src-tauri/src/supervisor.rs,
 * or lab.log for the one-line install): approve or deny the client's device
 * code, as the account this browser is signed in to with GitHub.
 *
 * Behind the sign-in gate like every other page, so whoever sees the buttons
 * has a session. Reading the code claims it for that session, and Better Auth
 * then lets only that session approve it. Drawn as the same card as signing in
 * (theme/Root/AuthScreen.js), as it is a step of signing a client in.
 */
function Device() {
  const {authClient} = require('@site/src/utils/authClient');
  const {account} = useAccount();
  const query = new URLSearchParams(window.location.search);
  const userCode = query.get('user_code');
  const desktop = query.get('client') === 'desktop';
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userCode) {
      setStatus('gone');
      setMessage(desktop ? 'That link is missing its code. Start RUSH Lab again.' : 'That link is missing its code. Run rush login again.');
      return;
    }
    authClient.device({query: {user_code: userCode}}).then(({data, error}) => {
      if (error) {
        setStatus('gone');
        setMessage(error.error_description || error.message || 'That code is not valid.');
        return;
      }
      setStatus(data.status);
    });
  }, [userCode]);

  const decide = async (approve) => {
    setBusy(true);
    setMessage(null);
    const {error} = approve
      ? await authClient.device.approve({userCode})
      : await authClient.device.deny({userCode});
    setBusy(false);
    if (error) {
      setMessage(error.error_description || error.message || 'That did not work.');
      return;
    }
    setStatus(approve ? 'approved' : 'denied');
  };

  const who = account?.githubLogin ? `@${account.githubLogin}` : account?.email;
  const outcome = {
    approved: desktop ? 'Approved. RUSH Lab on this computer is connecting; you can close this page.' : 'Approved. Return to your terminal.',
    denied: desktop ? 'Denied. This computer was not connected.' : 'Denied. The command-line client was not signed in.',
    gone: message,
  }[status];

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <img src="/img/rush-lab.png" alt="" className={styles.logo} />
        <h1 className={styles.title}>{desktop ? 'Connect this computer' : 'Sign in to rush'}</h1>
        {status === 'loading' && <p className={styles.tagline}>Loading…</p>}
        {status === 'pending' && (
          <>
            <p className={styles.tagline}>
              {desktop
                ? 'RUSH Lab on this computer asks to run your AI here, as you, with your own API keys.'
                : 'The rush command-line client asks to sign in as you. Approve only if this is the code in your terminal.'}
            </p>
            {!desktop && <code className={styles.userCode}>{userCode}</code>}
            {message && <p className={styles.error} role="alert">{message}</p>}
            <button type="button" className={styles.submit} onClick={() => decide(true)} disabled={busy}>
              {`Approve as ${who}`}
            </button>
            <button type="button" className={styles.switch} onClick={() => decide(false)} disabled={busy}>
              Deny
            </button>
          </>
        )}
        {outcome && <p className={styles.tagline} role="status">{outcome}</p>}
      </div>
    </div>
  );
}

export default function DevicePage() {
  return (
    <>
      <Head><title>Connect to RUSH Lab</title></Head>
      <BrowserOnly fallback={null}>{() => <Device />}</BrowserOnly>
    </>
  );
}
