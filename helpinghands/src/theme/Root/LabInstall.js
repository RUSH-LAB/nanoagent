import React, {useState} from 'react';
import {CHIPS, DOWNLOADS, installCommand, useMacChip, visitorSystem} from '@site/src/utils/labApp';
import styles from './authScreen.module.css';

/**
 * How to install RUSH Lab (pages/index, pages/download, LabScreen.js) on the visitor's system, a
 * Mac's for any other: the download, or the command, which installs it and opens it.
 */
export default function LabInstall() {
  const system = visitorSystem() ?? 'mac';
  return (
    <div className={styles.install}>
      {system === 'mac' ? <MacDownload /> : (
        <a className={styles.submit} href={DOWNLOADS.windows} download>Download for Windows</a>
      )}
      <div className={styles.divider}><span>or</span></div>
      <Command system={system} />
    </div>
  );
}

/** The download for this kind of Mac, or one for each when the browser does not say which (useMacChip). */
function MacDownload() {
  const chip = useMacChip();
  if (chip === null) {
    return (
      <div className={styles.chips}>
        {Object.entries(CHIPS).map(([key, name]) => (
          <a key={key} className={styles.submit} href={DOWNLOADS[key]} download>{name}</a>
        ))}
      </div>
    );
  }
  return <a className={styles.submit} href={chip && DOWNLOADS[chip]} aria-disabled={!chip} download>Download for Mac</a>;
}

/** The command that installs RUSH Lab on `system`, with a button that copies it. */
function Command({system}) {
  const command = installCommand(system);
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(command).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  });
  return (
    <div className={styles.command}>
      <code>{command}</code>
      <button type="button" className={styles.copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}
