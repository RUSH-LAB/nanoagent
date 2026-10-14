import React, {useEffect, useState} from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import pageStyles from '@site/src/css/page.module.css';
import dir from '@site/src/css/directory.module.css';
import joinStyles from '../join/styles.module.css';

/**
 * Where `mochi login` sends you, and where Mochi Lab shows you in its window
 * (`client=desktop`, desktop/src-tauri/src/supervisor.rs): approve or deny the
 * client's device code, as the account this browser is signed in to with GitHub.
 *
 * Behind the sign-in gate like every other page, so whoever sees the buttons
 * has a session. Reading the code claims it for that session, and Better Auth
 * then lets only that session approve it.
 */
function Device() {
  const {authClient} = require('@site/src/utils/authClient');
  const query = new URLSearchParams(window.location.search);
  const userCode = query.get('user_code');
  const desktop = query.get('client') === 'desktop';
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userCode) {
      setStatus('gone');
      setMessage('That link is missing its code. Run mochi login again.');
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

  if (status === 'loading') return <div className={pageStyles.pageContainer}><p>Loading…</p></div>;

  return (
    <div className={pageStyles.pageContainer}>
      <h1 className={dir.title}>{desktop ? 'Connect this computer to RUSH Lab' : 'Command-line sign-in'}</h1>
      {status === 'pending' && (
        <>
          <p className={dir.note}>
            {desktop
              ? <>RUSH Lab on this computer is asking to run your AI here, as you, with your own OpenRouter key. Approve to connect it.</>
              : <>A <code>mochi</code> command-line client is asking to sign in as you with the code{' '}
                <strong>{userCode}</strong>. Approve only if that code is the one in your terminal.</>}
          </p>
          {message && <p className={dir.error} role="alert">{message}</p>}
          <div className={joinStyles.next}>
            <button type="button" className={dir.cta} onClick={() => decide(true)} disabled={busy}>Approve</button>
            <button type="button" className={dir.action} onClick={() => decide(false)} disabled={busy}>Deny</button>
          </div>
        </>
      )}
      {status === 'approved' && <p className={dir.note}>{desktop ? 'Approved. Opening RUSH Lab…' : 'Approved. Return to your terminal.'}</p>}
      {status === 'denied' && <p className={dir.note}>{desktop ? 'Denied. This computer was not connected.' : 'Denied. The command-line client was not signed in.'}</p>}
      {status === 'gone' && <p className={dir.note}>{message}</p>}
    </div>
  );
}

export default function DevicePage() {
  return (
    <Layout title="Command-line sign-in" noFooter>
      <BrowserOnly fallback={<div className={pageStyles.pageContainer}><p>Loading…</p></div>}>
        {() => <Device />}
      </BrowserOnly>
    </Layout>
  );
}
