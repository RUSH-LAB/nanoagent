import React, {useMemo, useState} from 'react';
import clsx from 'clsx';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import {benchmarkApi} from './api';
import {STATUS_LABELS, actionPayloads, conditionRows, deltaText, estimateText, fieldDiffs, rowActionIds, rowTitle, visibleRows} from './compare';
import {buildTrace} from './traceModel';
import TraceActivity from './TraceActivity';
import useLoad from './useLoad';
import Payload from './Payload';
import styles from './styles.module.css';

function ActionInspector({label, attemptId, action}) {
  const [open, setOpen] = useState(false);
  return (
    <details className={styles.inspector} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Attempt {label} action record</summary>
      {!action && <p className={styles.fieldHint}>No aligned action on this side.</p>}
      {open && action && <>
        <dl className={styles.facts}>
          <dt>Status</dt><dd>{action.status ?? 'Unknown'}</dd>
          <dt>Duration</dt><dd>{action.duration_ns == null ? 'Unknown' : `${(action.duration_ns / 1e6).toFixed(1)} ms`}</dd>
          <dt>Tokens</dt><dd>{action.tokens ?? 'Unknown'}</dd>
          <dt>Evidence</dt><dd>{Object.entries(action.coverage ?? {}).filter(([, state]) => state !== 'complete').map(([field, state]) => `${field} ${state}`).join(', ') || 'complete'}</dd>
        </dl>
        <h5>Input</h5><pre>{JSON.stringify(action.input, null, 2)}</pre>
        <h5>Output</h5><pre>{JSON.stringify(action.output, null, 2)}</pre>
        {actionPayloads(action).map(item => <Payload key={`${item.label}:${item.sha}`} attemptId={attemptId} sha={item.sha} label={item.label} />)}
      </>}
    </details>
  );
}

function Diffs({title, diff}) {
  const {unknown, fields} = fieldDiffs(diff);
  if (!unknown && !fields.length) return null;
  return (
    <section>
      <h5>{title}</h5>
      {unknown ? <p className={styles.warn}>Unknown: {unknown}</p> : (
        <table className={styles.table}><thead><tr><th>Field</th><th>A</th><th>B</th></tr></thead>
          <tbody>{fields.map(field => <tr key={field.path}><td><code>{field.path}</code></td><td><pre>{field.a}</pre></td><td><pre>{field.b}</pre></td></tr>)}</tbody></table>
      )}
    </section>
  );
}

/**
 * Full traces use the same elapsed-time scale. The server's alignment links matching events and supplies field differences.
 */
export default function Compare({a, b, go, back}) {
  const result = useLoad(() => benchmarkApi.compareAttempts(a, b), [a, b]);
  const spansA = useLoad(() => benchmarkApi.spans(a), [a]);
  const spansB = useLoad(() => benchmarkApi.spans(b), [b]);
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const [selection, setSelection] = useState({});
  const modelA = useMemo(() => buildTrace(spansA.data ?? {}), [spansA.data]);
  const modelB = useMemo(() => buildTrace(spansB.data ?? {}), [spansB.data]);
  const data = result.data;
  const rows = useMemo(() => (data ? visibleRows(data.rows, differencesOnly) : []), [data, differencesOnly]);
  const rowOf = useMemo(() => {
    const index = {a: new Map(), b: new Map()};
    for (const row of data?.rows ?? []) {
      for (const side of ['a', 'b']) {
        for (const action of row[side]) index[side].set(action.action_id, row);
      }
    }
    return index;
  }, [data]);

  if (result.error) return <div><button type="button" className={styles.link} onClick={back}>← Back</button><p className={styles.error} role="alert">{result.error}</p></div>;
  if (!data) return <LoadingSkeleton shape="block" height={180} />;
  const selected = data.rows.find(row => row.index === selection.index);
  const lengths = [modelA, modelB].map(model => model.window.end - model.window.start);
  const scaleNs = lengths[0] > lengths[1] ? lengths[0] : lengths[1];
  const chooseRow = row => {
    const ids = rowActionIds(row);
    setSelection({index: row.index, a: ids.a[0] ?? null, b: ids.b[0] ?? null});
  };
  const selectSpan = (side, id) => {
    const row = rowOf[side].get(id);
    if (!row) {
      setSelection(previous => ({...previous, index: null, [side]: id}));
      return;
    }
    const other = side === 'a' ? 'b' : 'a';
    setSelection(previous => ({
      index: row.index, [side]: id,
      [other]: row[other].some(action => action.action_id === previous[other]) ? previous[other] : row[other][0]?.action_id ?? null,
    }));
  };
  const jump = () => {
    const row = data.rows.find(row => row.index === data.first_difference);
    if (row) chooseRow(row);
  };
  const {header} = data;
  return (
    <div>
      <header className={styles.header}>
        <button type="button" className={styles.link} onClick={back}>Back</button>
        <h2>Compare attempts <code>{a.slice(0, 8)}</code> and <code>{b.slice(0, 8)}</code></h2>
        <p className={styles.fieldHint}>{header.case.task_id} · pinned case <code>{header.case.content_digest.slice(0, 12)}</code></p>
      </header>
      <div className={styles.toolbar}>
        <button type="button" className={styles.secondaryButton} disabled={data.first_difference === null} onClick={jump}>First action difference</button>
        <button type="button" className={styles.secondaryButton} onClick={() => go({attempt: a})}>Open trace A</button>
        <button type="button" className={styles.secondaryButton} onClick={() => go({attempt: b})}>Open trace B</button>
      </div>
      <div className={styles.twin}>
        <TraceActivity attemptId={a} model={modelA} loading={spansA.loading} error={spansA.error} label="Timeline A"
          timelineOnly scaleNs={scaleNs} selected={selection.a} onSelect={id => selectSpan('a', id)} />
        <TraceActivity attemptId={b} model={modelB} loading={spansB.loading} error={spansB.error} label="Timeline B"
          timelineOnly scaleNs={scaleNs} selected={selection.b} onSelect={id => selectSpan('b', id)} />
      </div>
      <details className={clsx(styles.section, styles.advanced)}>
        <summary>Conditions and evidence</summary>
        <p className={styles.fieldHint}>Verifier package <code>{header.case.package_sha256.slice(0, 12)}</code></p>
        <table className={styles.table}>
          <thead><tr><th>Condition</th><th>A</th><th>B</th><th /></tr></thead>
          <tbody>
            {conditionRows(header).map(row => (
              <tr key={row.name} className={clsx({[styles.differs]: row.state === 'different', [styles.unknownRow]: row.state === 'unknown'})}>
                <td>{row.label}</td><td><code>{row.a}</code></td><td><code>{row.b}</code></td>
                <td>{row.state === 'different' ? 'Differs' : row.state === 'unknown' ? 'Unknown' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>Latency-adjusted estimate difference · {estimateText(header)}</p>
        {(header.redactions.a.some(s => s !== 'none') || header.redactions.b.some(s => s !== 'none')) && <p className={styles.muted}>Some payloads were redacted or cut short. Those fields read Unknown.</p>}
        {(header.missing_payloads.a.length > 0 || header.missing_payloads.b.length > 0) && <p className={styles.warn}>Missing payloads · A {header.missing_payloads.a.length}, B {header.missing_payloads.b.length}.</p>}
      </details>
      <details className={clsx(styles.section, styles.advanced)}>
        <summary>Aligned actions ({rows.length})</summary>
        <div className={styles.toolbar}>
          <label><input type="checkbox" checked={differencesOnly} onChange={event => setDifferencesOnly(event.target.checked)} /> Differences only</label>
          {data.first_difference === null && <span className={styles.muted}>The aligned actions have no recorded differences.</span>}
        </div>
        <ol className={styles.actions}>
          {rows.map(row => (
            <li key={row.index} className={clsx(styles[`row_${row.status}`], {[styles.selected]: row.index === selection.index})}>
              <button type="button" aria-pressed={row.index === selection.index} onClick={() => chooseRow(row)}>
                <span className={styles.badge}>{STATUS_LABELS[row.status]}</span> {rowTitle(row)}
                {row.index === data.first_difference && <span className={styles.badge}>First difference</span>}
                {row.reason && <small className={styles.muted}> {row.reason}</small>}
                {['duration_delta_ns', 'token_delta', 'cost_delta'].some(key => row[key] != null) && (
                  <small className={styles.muted}> {[deltaText(row.duration_delta_ns, 'ms'), deltaText(row.token_delta), deltaText(row.cost_delta, 'usd')].filter(Boolean).join(' · ')}</small>
                )}
              </button>
            </li>
          ))}
          {!rows.length && <li className={styles.muted}>No aligned actions match.</li>}
        </ol>
      </details>
      {selected && (
        <section className={styles.section}>
          <h3 className={styles.sectionHeading}>Selected action differences</h3>
          <Diffs title="Input differences" diff={selected.input_diff} />
          <Diffs title="Output differences" diff={selected.output_diff} />
          {selected.status_diff && !selected.status_diff.unknown && selected.status_diff[0] !== selected.status_diff[1] && <p>Status: {String(selected.status_diff[0])} to {String(selected.status_diff[1])}</p>}
          <div className={styles.twin}>
            <ActionInspector label="A" attemptId={a} action={selected.a.find(action => action.action_id === selection.a)} />
            <ActionInspector label="B" attemptId={b} action={selected.b.find(action => action.action_id === selection.b)} />
          </div>
        </section>
      )}
    </div>
  );
}
