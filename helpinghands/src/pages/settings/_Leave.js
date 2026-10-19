import React, {useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {clientPlatform} from '@site/src/platform/client';
import styles from './styles.module.css';

/** Leaving the current workspace, which the server refuses to its only owner. */
export default function Leave({workspace}) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const owner = workspace.role === 'owner';

  async function leave() {
    if (!(await clientPlatform.dialogs.confirm(`Leave ${workspace.name}? You will need a new invitation to come back.`))) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/workspaces/${encodeURIComponent(workspace.id)}/leave`, {method: 'POST'});
      clientPlatform.location.assign('/settings');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <section className={`${styles.group} ${styles.leave}`}>
      <div className={styles.row}>
        <div className={styles.rowLabel}>
          <strong>Leave {workspace.name}</strong>
          <span>{owner ? 'Needs another owner first. ' : ''}You will need a new invitation to come back.</span>
        </div>
        <div className={styles.rowControl}>
          <button type="button" className={styles.dangerButton} disabled={busy} onClick={leave}>Leave</button>
        </div>
      </div>
      {error && <p className={`${styles.empty} ${styles.error}`} role="alert">{error}</p>}
    </section>
  );
}
