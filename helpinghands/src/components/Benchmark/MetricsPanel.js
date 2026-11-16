import React from 'react';
import {coverageText, primaryMetrics, timingRows} from './metrics';
import styles from './styles.module.css';

/** The primary metrics first, then (for one attempt) the timing analysis and coverage. */
export default function Metrics({metrics, coverage, timing = false, showPrimary = true}) {
  const rows = showPrimary ? primaryMetrics(metrics) : [];
  const analysis = timing ? timingRows(metrics) : [];
  return (
    <div className={styles.metrics}>
      {showPrimary && <dl className={styles.primary}>
        {rows.map(row => (
          <div key={row.key}>
            <dt>{row.label}</dt>
            <dd>{row.text}{row.missing && <small className={styles.warn}> ({row.missing})</small>}</dd>
          </div>
        ))}
      </dl>}
      {timing && (
        <dl className={styles.timing}>
          {analysis.map(row => (
            <div key={row.key} className={row.estimate ? styles.estimate : undefined}>
              <dt>{row.label}</dt>
              <dd>{row.text} <small>{row.known ? row.note : `(${row.note})`}</small></dd>
            </div>
          ))}
        </dl>
      )}
      {coverage !== undefined && <p className={styles.muted}>{coverageText(coverage)}</p>}
    </div>
  );
}
