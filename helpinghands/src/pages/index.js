import React, {useState} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Head from '@docusaurus/Head';
import {Redirect} from '@docusaurus/router';
import LabInstall from '@site/src/theme/Root/LabInstall';
import {inLabApp, visitorSystem} from '@site/src/utils/labApp';
import styles from '@site/src/theme/Root/authScreen.module.css';

// The systems RUSH Lab installs on, each as its tab names it.
const SYSTEMS = [['mac', 'macOS'], ['windows', 'Windows']];

/**
 * The site's root, the landing page, signed in or not (src/utils/signIn.js): RUSH Lab is
 * the app, so it offers how to install it, on the visitor's system's tab first, a Mac's
 * for any other. RUSH Lab's own window is the app already, and goes on to the site (/w).
 */
export default function Landing() {
  const {siteConfig} = useDocusaurusContext();
  const [system, setSystem] = useState(() => visitorSystem() ?? 'mac');
  if (inLabApp()) return <Redirect to="/w" />;
  return (
    <>
      <Head><title>{siteConfig.title}</title></Head>
      <div className={styles.page}>
        <div className={`${styles.card} ${styles.landingCard}`}>
          <img src="/img/rush-lab.png" alt="" className={styles.logo} />
          <h1 className={styles.title}>{siteConfig.title}</h1>
          <p className={styles.tagline}>Efficient, private and convenient: your AI and plugins run right on your own computer.</p>
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
            {system === 'mac' ? <LabInstall /> : <p className={styles.landingNote}>RUSH Lab for Windows is coming soon.</p>}
          </div>
        </div>
      </div>
    </>
  );
}
