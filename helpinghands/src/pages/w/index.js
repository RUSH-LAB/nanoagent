import React from 'react';
import clsx from 'clsx';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {Redirect} from '@docusaurus/router';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import {useAccount} from '@site/src/utils/account';
import styles from './index.module.css';

/**
 * Where the site starts, from the landing page (pages/index) or after signing in:
 * the account's workspace, reached before anything is drawn, or, for an account
 * in none, where to start.
 */
export default function Start() {
  const {siteConfig} = useDocusaurusContext();
  const {workspaces, defaultWorkspaceId} = useAccount();
  const workspace = workspaces.find(item => item.id === defaultWorkspaceId) ?? workspaces[0];
  if (workspace) return <Redirect to={`/w/${encodeURIComponent(workspace.slug)}`} />;

  return (
    <Layout
      title={siteConfig.title}
      description={siteConfig.tagline}>
      <header className={clsx('hero hero--primary', styles.heroBanner)}>
        <div className="container">
          <Heading as="h1" className="hero__title">
            {siteConfig.title}
          </Heading>
          <p className="hero__subtitle">{siteConfig.tagline}</p>
          <p>Create or join a workspace to get started.</p>
        </div>
      </header>
    </Layout>
  );
}
