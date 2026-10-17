import React, {useState} from 'react';
import {CHIPS, DOWNLOADS, INSTALL_HINT, installCommand, useMacChip} from '@site/src/utils/labApp';
import styles from './authScreen.module.css';

/**
 * The two ways to install RUSH Lab on a Mac (pages/download, LabScreen.js): the command, which
 * installs it in Applications and opens it with no question from macOS, or the download, the one
 * for this kind of Mac, or both when the browser does not say which (useMacChip).
 */
export default function LabInstall() {
  const command = installCommand();
  const chip = useMacChip();
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(command).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  });
  return (
    <ol className={styles.steps}>
      <li>
        <span className={styles.stepNote}>Paste this into Terminal. It installs RUSH Lab in Applications and opens it.</span>
        <div className={styles.command}>
          <code>{command}</code>
          <button type="button" className={styles.copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      </li>
      <li>
        <span className={styles.stepNote}>Or download it:</span>
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
    </ol>
  );
}
