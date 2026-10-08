import React from 'react';
import styles from './styles.module.css';

/**
 * An app's product page: its plugin's product/ folder as NanoAgent sends it
 * (tagline, summary, highlights, steps and icon), and its settings: the
 * permissions in its manifest and what they mean for the user's privacy. `onOpen` switches to the app itself.
 */

const ICONS = {
  // A cloud with a slash: no network.
  offline: 'M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 9.1 4.5 4.5 0 0 0 7 18zM3 3l18 18',
  // A globe: the hosts it reaches.
  network: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  // A folder: where it saves.
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  // An eye: it only reads.
  readOnly: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  // A padlock: what stays with you.
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  // A person: who can see it.
  person: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5',
};

function Icon({name}) {
  return (
    <svg className={styles.accessIcon} viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

/**
 * The app's settings, in a user's words, from its manifest permissions: what
 * it may touch, and what that means for the user's data. The workspace an app
 * saves to is the caller's own (server/agent-workspace.js).
 */
function settingsOf(permissions) {
  const hosts = permissions.network.hosts;
  const writes = permissions.filesystem.write;
  const workspace = writes.includes('workspace');
  return [
    {title: 'Permissions', items: [
      hosts.length
        ? {icon: 'network', title: 'Network', text: `Connects only to ${hosts.join(', ')}.`}
        : {icon: 'offline', title: 'Network', text: 'None. It works offline.'},
      writes.length
        ? {icon: 'folder', title: 'Files', text: workspace ? 'Saves to your workspace, nowhere else.' : `Saves to ${writes.join(', ')}.`}
        : {icon: 'readOnly', title: 'Files', text: 'None. It saves nothing.'},
    ]},
    {title: 'Privacy', items: [
      hosts.length
        ? {icon: 'lock', title: 'Your data', text: `Only what it asks ${hosts.join(', ')} leaves Mochi.`}
        : {icon: 'lock', title: 'Your data', text: 'Nothing you give it leaves Mochi.'},
      workspace
        ? {icon: 'person', title: 'Who sees it', text: 'Only you. Your workspace is private.'}
        : {icon: 'person', title: 'Who sees it', text: 'No one. It keeps nothing.'},
    ]},
  ];
}

export default function AppProduct({app, onOpen}) {
  const {product} = app;
  if (!product) {
    return <div className={styles.error}>NanoAgent sent {app.name} without its product page (the plugin's product/ folder).</div>;
  }
  return (
    <article className={styles.product}>
      <header className={styles.hero}>
        {/* A data: URL from NanoAgent, in an <img>, where an SVG cannot run anything. */}
        <img className={styles.icon} src={product.icon} alt="" />
        <div className={styles.heroText}>
          <p className={styles.eyebrow}>{app.group}</p>
          <h1 className={styles.name}>{app.name}</h1>
          <p className={styles.tagline}>{product.tagline}</p>
          <p className={styles.summary}>{product.summary}</p>
          <button type="button" className={`button button--primary button--lg ${styles.open}`} onClick={onOpen}>
            Open app
          </button>
        </div>
      </header>

      <section aria-label="Highlights" className={styles.highlights}>
        {product.highlights.map(highlight => (
          <div key={highlight} className={styles.card}>
            <svg className={styles.check} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            <p>{highlight}</p>
          </div>
        ))}
      </section>

      <section className={styles.section}>
        <h2>How it works</h2>
        <ol className={styles.steps}>
          {product.steps.map((step, index) => (
            <li key={step} className={styles.step}>
              <span className={styles.stepNumber} aria-hidden="true">{index + 1}</span>
              <p>{step}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.section}>
        <h2>Settings</h2>
        <div className={styles.settings}>
          {settingsOf(app.permissions).map(group => (
            <div key={group.title}>
              <h3 className={styles.settingsTitle}>{group.title}</h3>
              <dl className={styles.access}>
                {group.items.map(({icon, title, text}) => (
                  <div key={title} className={styles.accessItem}>
                    <Icon name={icon} />
                    <div>
                      <dt>{title}</dt>
                      <dd>{text}</dd>
                    </div>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>

      <footer className={styles.footer}>Version {app.version}</footer>
    </article>
  );
}
