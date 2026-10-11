import React, {useEffect, useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {Skeleton} from './_parts';
import styles from './styles.module.css';

const usd = value => `$${Number(value).toFixed(2)}`;

function bytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Number(value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount < 10 && unit ? amount.toFixed(1) : Math.round(amount)} ${units[unit]}`;
}

function Meter({label, used, limit, format}) {
  const share = limit > 0 ? Math.min(used / limit, 1) : 1;
  return (
    <div className={styles.meter}>
      <div className={styles.meterLabel}>
        <span>{label}</span>
        <span>{format(used)} of {format(limit)}</span>
      </div>
      <div className={styles.meterTrack} role="progressbar" aria-label={label}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <span className={share >= 0.9 ? styles.meterFull : styles.meterFill} style={{width: `${share * 100}%`}} />
      </div>
    </div>
  );
}

/** What the current workspace has used against its limits (postgres/tenancy.js). */
export default function WorkspaceControls({workspace}) {
  const [usage, setUsage] = useState(undefined);
  const base = `/api/workspaces/${encodeURIComponent(workspace.id)}`;

  useEffect(() => {
    let cancelled = false;
    setUsage(undefined);
    apiRequest(`${base}/usage`)
      .then(data => { if (!cancelled) setUsage(data.usage); })
      .catch(() => { if (!cancelled) setUsage(null); });
    return () => { cancelled = true; };
  }, [base]);

  return (
    <section className={styles.group}>
      <h2 className={styles.groupTitle}>Usage</h2>
      {usage === undefined ? <Skeleton rows={3} bare />
        : usage === null ? <p className={styles.empty}>Usage is not available.</p> : (
          <>
            <div className={styles.meters}>
              <Meter label="Assistant today" used={usage.ai.today} limit={usage.limits.aiDailyUsd} format={usd} />
              <Meter label="Assistant this month" used={usage.ai.month} limit={usage.limits.aiMonthlyUsd} format={usd} />
              <Meter label="Your assistant use today" used={usage.ai.memberToday} limit={usage.limits.memberAiDailyUsd} format={usd} />
              <Meter label="Storage" used={usage.storageBytes} limit={usage.limits.storageBytes} format={bytes} />
              <Meter label="Members" used={usage.members} limit={usage.limits.maxMembers} format={String} />
            </div>
            <p className={styles.groupNote}>Daily budgets reset at midnight UTC. An administrator can raise these limits.</p>
          </>
        )}
    </section>
  );
}
