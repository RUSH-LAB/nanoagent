import React, {useState} from 'react';
import market from '@site/src/pages/marketplace/styles.module.css';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import useWorkspaceApps from '@site/src/hooks/useWorkspaceApps';
import {ChoiceCard} from './Choice';
import {filterPlugins} from './filterPlugins';
import styles from './styles.module.css';

/** The member's installed plugins that are ready to run: `{apps, error}`, `apps` null until they arrive. */
export function useBenchmarkPlugins() {
  const {workspace} = useWorkspaceSite();
  const {apps, error} = useWorkspaceApps(workspace);
  return {apps: apps && apps.filter(app => app.status === 'ready'), error};
}

/** A search bar over cards of the installed plugins: picking one calls `onPick`. */
export default function PluginCards({apps, onPick}) {
  const [query, setQuery] = useState('');
  if (!apps) return <p>Loading your plugins…</p>;
  if (!apps.length) return <p>No installed plugin is ready to benchmark. Install one from the Marketplace.</p>;
  const shown = filterPlugins(apps, query);
  return (
    <>
      <label className={`${market.search} ${styles.searchBar}`}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input type="search" aria-label="Search your plugins" placeholder="Search your plugins" value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      {!shown.length && <p>No plugin matches</p>}
      <div className={market.grid}>
        {shown.map(app => (
          <ChoiceCard key={app.id} onClick={() => onPick(app)}>
            <img className={market.icon} src={app.product.icon} alt="" />
            <span className={market.cardBody}>
              <span className={market.name}>{app.name}</span>
              <span className={market.tagline}>{app.product.tagline}</span>
              <span className={market.meta}>v{app.version}</span>
            </span>
          </ChoiceCard>
        ))}
      </div>
    </>
  );
}

/** A screen's head: a link back to the list it came from, then the picked plugin's icon and name. */
export function PluginHeader({plugin, back, onBack}) {
  return (
    <>
      <button type="button" className={`${styles.link} ${styles.back}`} onClick={onBack}>← {back}</button>
      <header className={`${market.header} ${styles.pluginHead}`}>
        <img className={styles.headIcon} src={plugin.product.icon} alt="" />
        <h1>{plugin.name}</h1>
      </header>
    </>
  );
}
