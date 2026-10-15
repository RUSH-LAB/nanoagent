import React, {useEffect, useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {INSTALL_HINT, useInstallCommand} from '@site/src/utils/labInstall';
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

/** While RUSH Lab is not connected: the line that installs it, to paste in a terminal (utils/labInstall.js). */
function InstallLab() {
  const {command, note, copy} = useInstallCommand();
  return (
    <section className={styles.group}>
      <div className={styles.groupHead}>
        <h4 className={styles.groupTitle}>Install RUSH Lab</h4>
      </div>
      <div className={`${styles.row} ${ai.installRow}`}>
        <div className={styles.rowLabel}>
          <strong>Paste this in a terminal</strong>
          {note?.error ? <span className={styles.error} role="alert">{note.error}</span>
            : <span role="status">{note?.text ?? INSTALL_HINT}</span>}
        </div>
        <div className={styles.rowControl}>
          <button type="button" className={styles.secondaryButton} disabled={!command} onClick={copy}>Copy</button>
        </div>
        <code className={ai.installCommand}>{command ?? '…'}</code>
      </div>
    </section>
  );
}

/**
 * Settings → Connection: whether RUSH Lab on the member's computer, where their AI
 * and plugins run, is connected to their account (server/runner.js), and the line
 * that installs it while it is not.
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
          Your AI and plugins run here. It starts at every login and stays connected while this
          computer is on, whether or not you are signed in to this site.
        </p>
      </section>
      {!computer.connected && <InstallLab />}
    </>
  );
}
