import React, {useEffect} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {useInstallCommand} from '@site/src/utils/labInstall';
import styles from './authScreen.module.css';

// How often the screen asks whether RUSH Lab has connected.
const STATUS_MS = 5_000;

const CopyIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1.5h7A1.5 1.5 0 0 1 13.5 3v8H12V3H5zM2.5 5A1.5 1.5 0 0 1 4 3.5h6A1.5 1.5 0 0 1 11.5 5v8.5A1.5 1.5 0 0 1 10 15H4a1.5 1.5 0 0 1-1.5-1.5zM4 5v8.5h6V5z" /></svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.8 4.2 6.5 11.5 2.2 7.2l1.1-1.1 3.2 3.2 6.2-6.2z" /></svg>
);

/**
 * What a signed-in member sees until RUSH Lab on their computer is connected.
 *
 * Every AI run goes to the member's own computer (server/runner.js), so the site
 * is not entered without it: the screen offers the line that installs it, and
 * lets the member in by itself once it connects. Rendered from the same
 * stylesheet as AuthScreen and OnboardingScreen, as the last step of arriving.
 */
export default function LabScreen({onConnected, onSignOut}) {
  const {command, note, copy} = useInstallCommand();

  useEffect(() => {
    const timer = setInterval(() => apiRequest('/api/runner/status')
      .then(status => { if (status.connected) onConnected(); })
      .catch(() => {}), STATUS_MS);
    return () => clearInterval(timer);
  }, [onConnected]);

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <img src="/img/rush-lab.png" alt="" className={styles.logo} />
        <h1 className={styles.title}>Install RUSH Lab</h1>
        <p className={styles.tagline}>Run this command in your terminal once.</p>
        <div className={styles.commandBox}>
          <code className={styles.command}>{command ?? '…'}</code>
          <button type="button" className={styles.copy} disabled={!command} onClick={copy}
            aria-label={note?.text ? 'Copied' : 'Copy the command'} title={note?.text ? 'Copied' : 'Copy'}>
            {note?.text ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
        {note?.error && <p className={styles.error} role="alert">{note.error}</p>}
        <button type="button" className={styles.switch} onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
