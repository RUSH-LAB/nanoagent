import React, {useEffect, useState} from 'react';
import Link from '@docusaurus/Link';
import {clientPlatform} from '@site/src/platform/client';
import useWorkspaceApps, {forgetWorkspaceApps, prepareWorkspaceApps} from '@site/src/hooks/useWorkspaceApps';
import {apiRequest} from '@site/src/utils/api';
import {PaneHeading, Skeleton} from './_parts';
import styles from './styles.module.css';

/** What changed on GitHub from `app`'s version to its latest, or null when they are in different repositories. */
function changesUrl({repository: from, latestRepository: to}) {
  if (!from || !to || from.owner !== to.owner || from.repo !== to.repo) return null;
  return `https://github.com/${from.owner}/${from.repo}/compare/${from.commit}...${to.commit}`;
}

// The states of an install (server/workspace-apps.js) a newer version runs in, and what each says after its version.
const UPDATES = new Set(['update', 'needs-update']);
const VERSION_NOTES = {'needs-update': ', no longer runs here', outdated: ', outdated: no version runs here yet'};
const versionNote = app => (app.state === 'ready' && app.latest === app.version ? ', up to date' : VERSION_NOTES[app.state] ?? '');

/**
 * The plugins the member installed from the marketplace, which they use on the
 * Plugins page of every workspace they are in; they uninstall them here and
 * install them there. An upload updates itself to each new version, or with
 * Auto-update off stays on its version until they update it (server/routes/apps.js).
 */
export default function Plugins({workspace}) {
  const {apps, error} = useWorkspaceApps(workspace);
  const [shown, setShown] = useState(null);
  const [state, setState] = useState({busy: null, error: null});
  useEffect(() => setShown(apps), [apps]);
  const marketplace = `/w/${encodeURIComponent(workspace.slug)}/marketplace`;

  /** Keep `app` on `version`, or with null have it follow the latest. */
  async function pin(app, version) {
    setState({busy: app.id, error: null});
    try {
      const data = await apiRequest(`/api/workspaces/${encodeURIComponent(workspace.id)}/apps/${encodeURIComponent(app.id)}`, {
        method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({version}),
      });
      forgetWorkspaceApps(workspace.id);
      prepareWorkspaceApps(workspace.id, {again: true});
      setShown(current => current.map(item => (item.id === app.id ? {...data.app, tags: item.tags} : item)));
      setState({busy: null, error: null});
    } catch (err) {
      setState({busy: null, error: err.message});
    }
  }

  async function remove(app) {
    if (!(await clientPlatform.dialogs.confirm(`Uninstall ${app.name}? Your files from it stay in your folder.`))) return;
    setState({busy: app.id, error: null});
    try {
      await apiRequest(`/api/workspaces/${encodeURIComponent(workspace.id)}/apps/${encodeURIComponent(app.id)}`, {method: 'DELETE'});
      forgetWorkspaceApps(workspace.id);
      setShown(current => current.filter(item => item.id !== app.id));
      setState({busy: null, error: null});
    } catch (err) {
      setState({busy: null, error: err.message});
    }
  }

  return (
    <>
      <PaneHeading title="Plugins" aside={<Link to={marketplace}>Browse the marketplace</Link>} />
      {error && <p className={`${styles.empty} ${styles.error}`} role="alert">{error}</p>}
      {!error && !shown && <Skeleton rows={2} />}
      {shown && (
        <section className={styles.group}>
          {shown.length ? shown.map(app => (
            <div className={styles.row} key={app.id}>
              <div className={styles.rowLabel}>
                <strong>{app.name}</strong>
                <span>
                  {app.status === 'unavailable' ? 'No longer in the marketplace' : app.product?.tagline}
                  {app.version && ` · v${app.version}${versionNote(app)}`}
                </span>
              </div>
              <div className={styles.rowControl}>
                {UPDATES.has(app.state) && changesUrl(app) && (
                  <a href={changesUrl(app)} target="_blank" rel="noreferrer">What's new</a>
                )}
                {UPDATES.has(app.state) && (
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={state.busy === app.id}
                    onClick={() => pin(app, app.latest)}
                  >
                    Update to v{app.latest}
                  </button>
                )}
                {app.latest && (
                  <label className={styles.autoUpdate} title="Use each new version as soon as it is published">
                    <input
                      type="checkbox"
                      checked={app.autoUpdate}
                      disabled={state.busy === app.id}
                      onChange={event => pin(app, event.target.checked ? null : app.version)}
                    />
                    Auto-update
                  </label>
                )}
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={state.busy === app.id}
                  onClick={() => remove(app)}
                >
                  Uninstall
                </button>
              </div>
            </div>
          )) : (
            <p className={styles.empty}>
              No plugins yet. Install them from the marketplace.
            </p>
          )}
          {state.error && <p className={`${styles.empty} ${styles.error}`} role="alert">{state.error}</p>}
        </section>
      )}
    </>
  );
}
