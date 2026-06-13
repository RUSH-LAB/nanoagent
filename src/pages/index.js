import React, {useState, useEffect} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Translate from '@docusaurus/Translate';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import { displayDirPath } from '@site/src/utils/paths';

import Heading from '@theme/Heading';
import styles from './index.module.css';

function formatAge(ts) {
  const ms = Date.now() - ts;
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

// Map a content/* source path to its published site route.
function toViewPath(filePath) {
  return '/' + filePath.replace(/^content\//, '').replace(/^books\//, '').replace(/^posts\//, '').replace(/\.(md|mdx)$/, '');
}

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

function RecentActivity() {
  const API_BASE = require('@site/src/utils/api').default;
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    Promise.all([
      fetch(`${API_BASE}/api/files/recent?limit=5`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`Files ${r.status}`)))
        .then(d => (d?.files || []).map(f => ({
          type: 'file',
          title: f.name.replace(/\.(md|mdx)$/, ''),
          subtitle: displayDirPath(f.path),
          timestamp: f.mtime,
          link: toViewPath(f.path),
        })))
        .catch(() => []),
      fetch(`${API_BASE}/api/activity-feed?limit=20`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`Activity ${r.status}`)))
        .then(d => (d?.events || [])
          .filter(e => e.type === 'comment')
          .slice(0, 3)
          .map(e => ({
            type: 'comment',
            title: e.author || 'Anonymous',
            subtitle: e.preview || '',
            timestamp: new Date(e.timestamp).getTime(),
          })))
        .catch(() => []),
    ]).then(([fileItems, commentItems]) => {
      const merged = [...fileItems, ...commentItems]
        .filter(i => i.timestamp)
        .sort((a, b) => b.timestamp - a.timestamp);
      setItems(merged);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <section style={{maxWidth: 960, margin: '0 auto', padding: '2rem 1.5rem'}}>
        <h2 style={{margin: 0, fontSize: '1.2rem', fontWeight: 600, marginBottom: '1rem'}}>Recent Activity</h2>
        <div style={{display: 'flex', flexDirection: 'column', gap: '0.5rem'}}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              height: 44, borderRadius: 6,
              background: 'var(--ifm-color-emphasis-100)',
              border: '1px solid var(--ifm-color-emphasis-200)',
            }} />
          ))}
        </div>
      </section>
    );
  }

  if (error || items.length === 0) {
    return null;
  }

  return (
    <section style={{maxWidth: 960, margin: '0 auto', padding: '2rem 1.5rem'}}>
      <h2 style={{margin: 0, fontSize: '1.2rem', fontWeight: 600, marginBottom: '1rem'}}>Recent Activity</h2>
      <div style={{display: 'flex', flexDirection: 'column', gap: '0.5rem'}}>
        {items.map((item, i) => (
          <div
            key={i}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              padding: '10px 14px', borderRadius: 6,
              border: '1px solid var(--ifm-color-emphasis-200)',
              fontSize: '0.88rem',
            }}
          >
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
              background: item.type === 'comment' ? '#10b981' : '#3b82f6',
              color: '#fff', fontSize: '0.75rem',
            }}>
              {item.type === 'comment' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              )}
            </span>
            <div style={{flex: 1, minWidth: 0}}>
              {item.type === 'comment' ? (
                <span>
                  <strong>{item.title}</strong>
                  <span style={{color: 'var(--ifm-color-emphasis-600)'}}> commented: </span>
                  <span style={{color: 'var(--ifm-color-emphasis-500)'}}>{item.subtitle}</span>
                </span>
              ) : (
                <Link to={item.link} style={{textDecoration: 'none', color: 'inherit'}}>
                  <strong>{item.title}</strong>
                  <span style={{color: 'var(--ifm-color-emphasis-500)', marginLeft: 6, fontSize: '0.8rem'}}>{item.subtitle}</span>
                </Link>
              )}
            </div>
            <span style={{flexShrink: 0, fontSize: '0.78rem', color: 'var(--ifm-color-emphasis-400)'}}>
              {formatAge(item.timestamp)}
            </span>
          </div>
        ))}
      </div>
    </section>
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
              {displayDirPath(f.path)} &middot; {formatAge(f.mtime)}
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
        <BrowserOnly>{() => <ErrorBoundary><RecentFiles /></ErrorBoundary>}</BrowserOnly>
        <BrowserOnly>{() => <ErrorBoundary><RecentActivity /></ErrorBoundary>}</BrowserOnly>
      </main>
    </Layout>
  );
}
