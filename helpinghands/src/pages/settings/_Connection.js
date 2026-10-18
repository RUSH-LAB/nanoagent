import React, {useEffect, useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {CONNECT_HINT, DOWNLOADS, INSTALL_HINT, WINDOWS_INSTALL_HINT, useConnectLink, visitorSystem} from '@site/src/utils/labApp';
import {Fact, PaneHeading, Skeleton} from './_parts';
import styles from './styles.module.css';
import ai from './ai.module.css';

// How often the pane asks whether RUSH Lab is connected.
const STATUS_MS = 5_000;
// Times are in Central Time, with its zone: "Oct 15, 2026, 2:05 PM CDT".
const CENTRAL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', timeZoneName: 'short',
  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

/** While RUSH Lab is not connected: the app to download, and the link that connects it (utils/labApp.js). */
function InstallLab() {
  const {link, error} = useConnectLink();
  return (
    <section className={styles.group}>
      <div className={styles.groupHead}>
        <h4 className={styles.groupTitle}>Install RUSH Lab</h4>
      </div>
      <div className={styles.row}>
        <div className={styles.rowLabel}>
          <strong>Download the app</strong>
          <span>{visitorSystem() === 'windows' ? WINDOWS_INSTALL_HINT : INSTALL_HINT}</span>
        </div>
        <div className={styles.rowControl}>
          <a className={`${styles.primaryButton} ${ai.primaryLink}`} href={DOWNLOADS.appleSilicon} download>Apple silicon</a>
          <a className={`${styles.secondaryButton} ${ai.secondaryLink}`} href={DOWNLOADS.intel} download>Intel</a>
          <a className={`${styles.secondaryButton} ${ai.secondaryLink}`} href={DOWNLOADS.windows} download>Windows</a>
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.rowLabel}>
          <strong>Connect it to your account</strong>
          {error ? <span className={styles.error} role="alert">{error}</span> : <span>{CONNECT_HINT}</span>}
        </div>
        <div className={styles.rowControl}>
          <a className={`${styles.secondaryButton} ${ai.secondaryLink}`} href={link ?? undefined} aria-disabled={!link}>Connect</a>
        </div>
      </div>
    </section>
  );
}

/**
 * Settings → Connection: whether RUSH Lab on the member's computer, where their AI
 * and plugins run, is connected to their account (server/runner.js), and the app
 * to install and connect while it is not.
 */
export default function Connection() {
  const [computer, setComputer] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const check = () => apiRequest('/api/runner/status')
      .then(value => { setComputer(value); setError(null); })
      .catch(err => setError(err.message));
    check();
    const timer = setInterval(check, STATUS_MS);
    return () => clearInterval(timer);
  }, []);

  const heading = <PaneHeading title="Connection" aside={error && <span className={styles.error} role="alert">{error}</span>} />;
  if (!computer) {
    return (
      <>
        {heading}
        {!error && <Skeleton rows={2} />}
      </>
    );
  }
  return (
    <>
      {heading}
      <section className={styles.group}>
        <div className={styles.groupHead}>
          <h4 className={styles.groupTitle}>RUSH Lab on your computer</h4>
        </div>
        <Fact label="Status">
          {computer.connected
            ? <span className={ai.online}>Connected</span>
            : <span className={ai.offline}>Not connected</span>}
        </Fact>
        {computer.connected && <Fact label="Connected at">{CENTRAL.format(new Date(computer.since))}</Fact>}
        <p className={ai.connectionNote}>
          Your AI and plugins run here. RUSH Lab opens at every login, in the menu bar, and stays
          connected while this computer is on, whether or not you are signed in to this site.
        </p>
      </section>
      {!computer.connected && <InstallLab />}
    </>
  );
}
