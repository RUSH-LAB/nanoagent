import React from 'react';
import Head from '@docusaurus/Head';
import LabInstall from '@site/src/theme/Root/LabInstall';
import styles from '@site/src/theme/Root/authScreen.module.css';

/**
 * Where anyone gets RUSH Lab, the desktop app members sign in to and run their AI and plugins in
 * (src/utils/signIn.js: open without a session). Windows comes once its app is built.
 */
export default function Download() {
  return (
    <>
      <Head><title>Download RUSH Lab</title></Head>
      <div className={styles.page}>
        <div className={styles.card}>
          <img src="/img/rush-lab.png" alt="" className={styles.logo} />
          <h1 className={styles.title}>Get RUSH Lab</h1>
          <p className={styles.tagline}>The RUSH Lab app for your Mac: sign in there, and your AI and plugins run on this computer.</p>
          <LabInstall />
          <p className={styles.tagline}>Windows is coming soon.</p>
        </div>
      </div>
    </>
  );
}
