import React, {useEffect, useState} from 'react';
import Link from '@docusaurus/Link';
import {clientPlatform} from '@site/src/platform/client';
import useWorkspaceApps, {forgetWorkspaceApps} from '@site/src/hooks/useWorkspaceApps';
import {apiRequest} from '@site/src/utils/api';
import {PaneHeading, Skeleton} from './_parts';
import styles from './styles.module.css';

/**
 * The plugins the workspace added from the marketplace, which its members use
 * on the Plugins page; an owner removes them here and adds them there.
 */
export default function Plugins({workspace}) {
  const {apps, error} = useWorkspaceApps(workspace);
  const [shown, setShown] = useState(null);
  const [state, setState] = useState({busy: null, error: null});
  useEffect(() => setShown(apps), [apps]);
  const owner = workspace.role === 'owner';
  const marketplace = `/w/${encodeURIComponent(workspace.slug)}/marketplace`;

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
              </div>
              {owner && (
                <div className={styles.rowControl}>
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
