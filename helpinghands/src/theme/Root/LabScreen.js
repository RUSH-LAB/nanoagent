import React, {useEffect, useRef, useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {CONNECT_HINT, DOWNLOADS, INSTALL_HINT, inLabApp, useConnectLink} from '@site/src/utils/labApp';
import {admits} from '@site/src/utils/runner';
import styles from './authScreen.module.css';

// How often the screen asks whether RUSH Lab has connected.
const STATUS_MS = 5_000;

/**
 * What a signed-in member sees while their plugins have nowhere to run: they run
 * on their computer (server/cloud-runs.js) and RUSH Lab there is not connected.
 *
 * The screen offers the app to download and the link that connects it, and lets
 * the member in by itself once it connects. Where the site offers RUSH Lab cloud
 * (`cloud`), it offers that first: one click, nothing to install, and the member
 * is in. In the app's own window, this computer is the app's, so the screen hands
 * it the link at once, and the app connects it. Rendered from the same stylesheet
 * as AuthScreen and OnboardingScreen, as the last step of arriving.
 */
export default function LabScreen({cloud = false, onConnected, onSignOut}) {
  const {link, error} = useConnectLink();
  const inApp = inLabApp();
  const handed = useRef(false);
  // Running in RUSH Lab cloud instead: {saving} while asked, {error} if refused.
  const [choosing, setChoosing] = useState(null);
  const runInCloud = () => {
    setChoosing({saving: true});
    apiRequest('/api/runner/target', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({runner: 'cloud'}),
    })
      .then(status => (admits(status) ? onConnected() : setChoosing({error: 'RUSH Lab cloud did not take your plugins. Try again.'})))
      .catch(err => setChoosing({error: err.message}));
  };

  // Once: the app follows the link itself (the page stays), and says so if it cannot connect.
  useEffect(() => {
    if (!inApp || !link || handed.current) return;
    handed.current = true;
    window.location.href = link;
  }, [inApp, link]);

  useEffect(() => {
    const timer = setInterval(() => apiRequest('/api/runner/status')
      .then(status => { if (admits(status)) onConnected(); })
      .catch(() => {}), STATUS_MS);
    return () => clearInterval(timer);
  }, [onConnected]);

  if (inApp) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <img src="/img/rush-lab.png" alt="" className={styles.logo} />
          <h1 className={styles.title}>Connecting this computer</h1>
          <p className={styles.tagline}>Your AI and plugins will run here, on this Mac. The first time takes a minute.</p>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button type="button" className={styles.switch} onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <img src="/img/rush-lab.png" alt="" className={styles.logo} />
        {cloud ? (
          <>
            <h1 className={styles.title}>Where should your plugins run?</h1>
            <p className={styles.tagline}>You can change this later, in Settings → Connection.</p>
            <div className={styles.choice}>
              <button type="button" className={styles.submit} onClick={runInCloud} disabled={Boolean(choosing?.saving)}>
                Run them in RUSH Lab cloud
              </button>
              <span className={styles.stepNote}>
                Nothing to install, on any computer: your plugins run on RUSH Lab&apos;s servers, within your
                workspace&apos;s AI budget.
              </span>
            </div>
            {choosing?.error && <p className={styles.error} role="alert">{choosing.error}</p>}
            <div className={styles.divider}><span>or run them on your own Mac</span></div>
          </>
        ) : (
          <>
            <h1 className={styles.title}>Install RUSH Lab</h1>
            <p className={styles.tagline}>Your AI and plugins run on your own Mac, in the RUSH Lab app.</p>
          </>
        )}
        <ol className={styles.steps}>
          <li>
            <a className={styles.submit} href={DOWNLOADS.appleSilicon} download>Download for Mac</a>
            <span className={styles.stepNote}>
              For Apple silicon. On an Intel Mac, <a href={DOWNLOADS.intel} download>download this one</a>.
            </span>
          </li>
          <li><span className={styles.stepNote}>{INSTALL_HINT}</span></li>
          <li>
            <a className={styles.submit} href={link ?? undefined} aria-disabled={!link}>Connect RUSH Lab</a>
            <span className={styles.stepNote}>{CONNECT_HINT}</span>
          </li>
        </ol>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <button type="button" className={styles.switch} onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
