import React, {useState} from 'react';
import {CHIPS, DOWNLOADS, INSTALL_HINT, WINDOWS_INSTALL_HINT, installCommand, useMacChip, visitorSystem} from '@site/src/utils/labApp';
import styles from './authScreen.module.css';

// The systems RUSH Lab installs on, each as its tab names it.
const SYSTEMS = [['mac', 'macOS'], ['windows', 'Windows']];

/**
 * How to install RUSH Lab (pages/index, pages/download, LabScreen.js), on a tab for each system,
 * the visitor's first, a Mac's for any other: the command, which installs it and opens it with no
 * question from the system, or the download.
 */
export default function LabInstall() {
  const [system, setSystem] = useState(() => visitorSystem() ?? 'mac');
  return (
    <>
      <div className={styles.systems} role="tablist" aria-label="Your computer">
        {SYSTEMS.map(([id, name]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={system === id}
            className={system === id ? `${styles.system} ${styles.systemActive}` : styles.system}
            onClick={() => setSystem(id)}>
            {name}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        <ol className={styles.steps}>
          {system === 'mac' ? <MacSteps /> : <WindowsSteps />}
        </ol>
      </div>
    </>
  );
}

/** The command that installs RUSH Lab on `system`, with a button that copies it. */
function Command({system, note}) {
  const command = installCommand(system);
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(command).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  });
  return (
    <li>
      <span className={styles.stepNote}>{note}</span>
      <div className={styles.command}>
        <code>{command}</code>
        <button type="button" className={styles.copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </li>
  );
}

/** A Mac's: the download is the one for this kind of Mac, or both when the browser does not say which (useMacChip). */
function MacSteps() {
  const chip = useMacChip();
  return (
    <>
      <Command system="mac" note="Paste this command into Terminal. It installs RUSH Lab in your Applications folder and opens it." />
      <li>
        <span className={styles.stepNote}>Or download the app:</span>
        {chip === null ? (
          <div className={styles.chips}>
            {Object.entries(CHIPS).map(([key, name]) => (
              <a key={key} className={styles.submit} href={DOWNLOADS[key]} download>{name}</a>
            ))}
          </div>
        ) : (
          <a className={styles.submit} href={chip && DOWNLOADS[chip]} aria-disabled={!chip} download>Download for Mac</a>
        )}
        <span className={styles.stepNote}>
          {chip === null && 'Which chip your Mac has is in the Apple menu, About This Mac. '}{INSTALL_HINT}
        </span>
      </li>
    </>
  );
}

function WindowsSteps() {
  return (
    <>
      <Command system="windows" note="Paste this command into PowerShell. It installs RUSH Lab and opens it." />
      <li>
        <span className={styles.stepNote}>Or download the app:</span>
        <a className={styles.submit} href={DOWNLOADS.windows} download>Download for Windows</a>
        <span className={styles.stepNote}>{WINDOWS_INSTALL_HINT}</span>
      </li>
    </>
  );
}
