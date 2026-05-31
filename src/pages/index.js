/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import React, {useState, useEffect} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Translate from '@docusaurus/Translate';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import BrowserOnly from '@docusaurus/BrowserOnly';

import Heading from '@theme/Heading';
import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg margin-right--md"
            to="/research">
            <Translate>Research</Translate>
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="/blog">
            <Translate>Blog</Translate>
          </Link>
        </div>
      </div>
    </header>
  );
}

function RecentFiles() {
  const API_BASE = require('@site/src/utils/api').default;
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/files/recent?limit=6`)
      .then(r => {
        if (!r.ok) throw new Error(`Failed to load recent files (${r.status})`);
        return r.json();
      })
      .then(data => {
        setFiles(data?.files || []);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <section style={{maxWidth: 960, margin: '0 auto', padding: '2rem 1.5rem 0'}}>
        <h2 style={{margin: 0, fontSize: '1.2rem', fontWeight: 600, marginBottom: '1rem'}}>Recently Updated</h2>
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.75rem'}}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              padding: '12px 16px', borderRadius: 8,
              border: '1px solid var(--ifm-color-emphasis-200)',
              background: 'var(--ifm-color-emphasis-100)',
              height: 60,
            }} />
          ))}
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section style={{maxWidth: 960, margin: '0 auto', padding: '2rem 1.5rem 0'}}>
        <h2 style={{margin: 0, fontSize: '1.2rem', fontWeight: 600, marginBottom: '1rem'}}>Recently Updated</h2>
        <p style={{color: 'var(--ifm-color-danger-dark, #e74c3c)', fontSize: '0.9rem'}}>
          Could not load recent files: {error}
        </p>
      </section>
    );
  }

  if (files.length === 0) {
    return (
      <section style={{maxWidth: 960, margin: '0 auto', padding: '2rem 1.5rem 0'}}>
        <h2 style={{margin: 0, fontSize: '1.2rem', fontWeight: 600, marginBottom: '1rem'}}>Recently Updated</h2>
        <p style={{color: 'var(--ifm-color-emphasis-500)', fontSize: '0.9rem'}}>
          No recently updated files found. Start writing to see your latest work here.
        </p>
      </section>
    );
  }

  function toViewPath(filePath) {
    return '/' + filePath.replace(/^content\//, '').replace(/^books\//, '').replace(/^posts\//, '').replace(/\.(mdx?|md)$/, '');
  }

  function formatAge(mtime) {
    const ms = Date.now() - mtime;
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    return `${d}d ago`;
  }

  return (
    <section style={{maxWidth: 960, margin: '0 auto', padding: '2rem 1.5rem 0'}}>
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem'}}>
        <h2 style={{margin: 0, fontSize: '1.2rem', fontWeight: 600}}>Recently Updated</h2>
        <Link to="/editor" style={{fontSize: '0.85rem'}}>View all</Link>
      </div>
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.75rem'}}>
        {files.map(f => (
          <Link
            key={f.path}
            to={toViewPath(f.path)}
            style={{
              display: 'block', padding: '12px 16px', borderRadius: 8,
              border: '1px solid var(--ifm-color-emphasis-200)',
              textDecoration: 'none', color: 'inherit',
              transition: 'border-color 0.15s, box-shadow 0.15s',
            }}
          >
            <div style={{fontWeight: 600, fontSize: '0.9rem', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
              {f.name.replace(/\.(md|mdx)$/, '')}
            </div>
            <div style={{fontSize: '0.78rem', color: 'var(--ifm-color-emphasis-500)'}}>
              {f.path.replace(/^content\//, '').replace(/\/[^/]+$/, '')} &middot; {formatAge(f.mtime)}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <Layout
      title="Mochi Lab"
      description="A collection of research and projects from Mochi Lab">
      <HomepageHeader />
      <main>
        <HomepageFeatures />
        <BrowserOnly>{() => <RecentFiles />}</BrowserOnly>
      </main>
    </Layout>
  );
}
