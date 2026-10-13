import React, {useEffect, useState} from 'react';
import Link from '@docusaurus/Link';
import {clientPlatform} from '@site/src/platform/client';
import useWorkspaceApps, {forgetWorkspaceApps} from '@site/src/hooks/useWorkspaceApps';
import {apiRequest} from '@site/src/utils/api';
import {PaneHeading, Skeleton} from './_parts';
import styles from './styles.module.css';

const parseTags = text => [...new Set(text.split(',').map(tag => tag.trim()).filter(Boolean))];

/**
 * The plugins the workspace added from the marketplace, which its members use
 * on the Plugins page; an owner tags and removes them here and adds them there.
 * The tags are the workspace's own: the Plugins page files its plugins under them.
 */
export default function Plugins({workspace}) {
  const {apps, error} = useWorkspaceApps(workspace);
  const [shown, setShown] = useState(null);
  const [state, setState] = useState({busy: null, error: null});
  useEffect(() => setShown(apps), [apps]);
  const owner = workspace.role === 'owner';
  const marketplace = `/w/${encodeURIComponent(workspace.slug)}/marketplace`;

  async function saveTags(app, text) {
    const tags = parseTags(text);
    if (tags.join(',') === app.tags.join(',')) return;
    setState({busy: app.id, error: null});
    try {
      const saved = await apiRequest(`/api/workspaces/${encodeURIComponent(workspace.id)}/apps/${encodeURIComponent(app.id)}`, {
        method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({tags}),
      });
      forgetWorkspaceApps(workspace.id);
      setShown(current => current.map(item => (item.id === app.id ? {...item, tags: saved.tags} : item)));
      setState({busy: null, error: null});
    } catch (err) {
      setState({busy: null, error: err.message});
    }
  }

  async function remove(app) {
    if (!clientPlatform.dialogs.confirm(`Remove ${app.name} from ${workspace.name}? Its members can no longer use it.`)) return;
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
                <span>{app.status === 'unavailable' ? 'No longer in the marketplace' : app.product?.tagline}</span>
                {!owner && app.tags.length > 0 && <span>{app.tags.join(', ')}</span>}
              </div>
              {owner && (
                <div className={styles.rowControl}>
                  <input
                    // Remounted when the saved tags change, so the field shows them as stored.
                    key={app.tags.join(',')}
                    className={styles.input}
                    aria-label={`Tags for ${app.name}`}
                    placeholder="Tags, comma-separated"
                    defaultValue={app.tags.join(', ')}
                    disabled={state.busy === app.id}
                    onBlur={event => saveTags(app, event.target.value)}
                    onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
                  />
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={state.busy === app.id}
                    onClick={() => remove(app)}
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          )) : (
            <p className={styles.empty}>
              No plugins yet. {owner ? 'Add them from the marketplace.' : 'An owner can add them from the marketplace.'}
            </p>
          )}
          {state.error && <p className={`${styles.empty} ${styles.error}`} role="alert">{state.error}</p>}
        </section>
      )}
    </>
  );
}
