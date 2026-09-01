import React, {useEffect, useState} from 'react';
import clsx from 'clsx';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import {loadWorkspaces, navigateClient} from '@site/src/utils/workspaces';
import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  const [message, setMessage] = useState('Opening your workspace…');

  useEffect(() => {
    let cancelled = false;
    loadWorkspaces()
      .then(({workspaces, defaultWorkspaceId}) => {
        if (cancelled) return;
        const workspace = workspaces.find(item => item.id === defaultWorkspaceId) ?? workspaces[0];
        if (!workspace) {
          setMessage('Create or join a workspace to get started.');
          return;
        }
        navigateClient(`/w/${encodeURIComponent(workspace.slug)}`, {replace: true});
      })
      .catch(error => {
        if (!cancelled) setMessage(error.message || 'Your workspaces could not be loaded.');
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <p>{message}</p>
      </div>
    </header>
  );
}

export default function Home() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description={siteConfig.tagline}>
      <HomepageHeader />
    </Layout>
  );
}
