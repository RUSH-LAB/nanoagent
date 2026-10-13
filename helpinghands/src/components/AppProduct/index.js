import React from 'react';
import styles from './styles.module.css';

/**
 * A marketplace plugin's page, kept short: its icon, name and author, what it
 * does (its product/ folder's tagline and summary, as NanoAgent sends them),
 * and the marketplace's `actions`. `byline` names the author; `meta` is a
 * quiet line of links and facts under the actions.
 */

export default function AppProduct({app, byline, actions, meta}) {
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
          <h1 className={styles.name}>{app.name}</h1>
          <p className={styles.byline}>{byline}</p>
          <p className={styles.tagline}>{product.tagline}</p>
        </div>
      </header>
      <div className={styles.actions}>{actions}</div>
      {meta && <p className={styles.meta}>{meta}</p>}

      <p className={styles.summary}>{product.summary}</p>
    </article>
  );
}
