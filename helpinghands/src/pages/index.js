import React from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Head from '@docusaurus/Head';
import {Redirect} from '@docusaurus/router';
import LabInstall from '@site/src/theme/Root/LabInstall';
import {inLabApp} from '@site/src/utils/labApp';
import styles from '@site/src/theme/Root/authScreen.module.css';

/**
 * The site's root, the landing page, signed in or not (src/utils/signIn.js): RUSH Lab is
 * the app, so it offers how to install it (LabInstall.js). RUSH Lab's own window is the app
 * already, and goes on to the site (/w).
 */
export default function Landing() {
  const {siteConfig} = useDocusaurusContext();
  if (inLabApp()) return <Redirect to="/w" />;
  return (
    <>
      <Head><title>{siteConfig.title}</title></Head>
      <div className={styles.page}>
        <div className={`${styles.card} ${styles.landingCard}`}>
          <img src="/img/rush-lab.png" alt="" className={styles.logo} />
          <h1 className={styles.title}>{siteConfig.title}</h1>
          <p className={styles.tagline}>Efficient, private and convenient: your AI and plugins run right on your own computer.</p>
          <LabInstall />
        </div>
      </div>
    </>
  );
}
