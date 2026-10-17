import React, {useEffect, useRef} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {CONNECT_HINT, DOWNLOADS, INSTALL_HINT, inLabApp, useConnectLink} from '@site/src/utils/labApp';
import styles from './authScreen.module.css';

// How often the screen asks whether RUSH Lab has connected.
const STATUS_MS = 5_000;

/**
 * What a signed-in member sees until RUSH Lab on their computer is connected.
 *
 * Every AI run goes to the member's own computer (server/runner.js), so the site
 * is not entered without it: the screen offers the app to download and the link
 * that connects it, and lets the member in by itself once it connects. In the
 * app's own window, this computer is the app's, so the screen hands it the link
 * at once, and the app connects it. Rendered from the same stylesheet as
 * AuthScreen and OnboardingScreen, as the last step of arriving.
 */
export default function LabScreen({onConnected, onSignOut}) {
  const {link, error} = useConnectLink();
  const inApp = inLabApp();
  const handed = useRef(false);

  // Once: the app follows the link itself (the page stays), and says so if it cannot connect.
  useEffect(() => {
    if (!inApp || !link || handed.current) return;
    handed.current = true;
    window.location.href = link;
  }, [inApp, link]);

  useEffect(() => {
    const timer = setInterval(() => apiRequest('/api/runner/status')
      .then(status => { if (status.connected) onConnected(); })
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
        <h1 className={styles.title}>Install RUSH Lab</h1>
        <p className={styles.tagline}>Your AI and plugins run on your own Mac, in the RUSH Lab app.</p>
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
