import React, {useState} from 'react';
import {traceApi} from './api';
import {accountingCost, formatTokens} from './format';
import useLoad from '../Benchmarks/useLoad';
import styles from './trace.module.css';

// Terminal control sequences, which a recording holds beside its text.
const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const decode = data => new TextDecoder().decode(Uint8Array.from(atob(data), char => char.charCodeAt(0))).replace(ESCAPES, '');

/** What a folded section holds once opened, which is when `read` is first called. */
function Opened({read, attemptId, children}) {
  const state = useLoad(() => read(attemptId), [attemptId]);
  if (state.loading) return <p className={styles.muted}>Loading…</p>;
  if (state.error) return <p className={styles.warn}>{state.error}</p>;
  return children(state.data);
}

/** A section folded away until it is opened. */
function Folded({title, read, attemptId, children}) {
  const [open, setOpen] = useState(false);
  return (
    <details className={styles.folded} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {open && <Opened read={read} attemptId={attemptId}>{children}</Opened>}
    </details>
  );
}

const diffList = snapshot => !snapshot ? <p className={styles.muted}>No snapshot was taken.</p>
  : snapshot.diff.length === 0 ? <p className={styles.muted}>None.</p>
    : <ul>{snapshot.diff.map(entry => <li key={entry.path}><code>{entry.change} {entry.path}</code> {Number.isFinite(entry.size) && <small>{entry.size} bytes</small>}</li>)}{snapshot.diff_truncated && <li>Cut to fit.</li>}</ul>;

const terminals = recording => recording.terminals.length === 0 ? <p className={styles.muted}>No terminal was recorded.</p>
  : recording.terminals.map(({terminal, data}) => <pre key={terminal} aria-label={`Terminal ${terminal}`}>{decode(data)}</pre>);

/** Outcome, verdict, cost and tokens of one attempt; the workspace diff and, for a Terminal session, its recording are folded away. */
export default function Header({attemptId, attempt, accounting, accountingError, harnessName, session = false}) {
  const metrics = attempt.metrics;
  const usage = [
    ['Input', 'input_tokens', 'input'], ['Output', 'output_tokens', 'output'],
    ['Cache read', 'cache_read_tokens', 'cache_read'], ['Cache write', 'cache_write_tokens', 'cache_write'],
    ['Total', 'total_tokens', 'total'],
  ];
  const outcome = attempt.execution ? `${attempt.execution.status.replaceAll('_', ' ')}${attempt.execution.reason ? ` (${attempt.execution.reason})` : ''}` : attempt.state;
  return (
    <header className={styles.header}>
      {harnessName && <p className={styles.harnessName}>{harnessName}</p>}
      <h3>{attempt.case_id}{!attempt.sealed && <span className={styles.badge}>Live</span>}</h3>
      <p>
        <strong>{outcome}</strong>
        {attempt.verdict && <span className={styles.badge} data-verdict={attempt.verdict}>{attempt.verdict}</span>}
        {attempt.verifier_error && <> · Verifier error: {attempt.verifier_error}</>}
        {' · '}Cost {accountingError ? `could not be read (${accountingError})` : accountingCost(accounting)}
      </p>
      <dl className={styles.usage} aria-label="Token usage">
        {usage.map(([label, field, missing]) => (
          <div key={field}>
            <dt>{label} tokens</dt>
            <dd>{formatTokens(metrics?.[field])}{metrics?.missing_calls?.[missing] > 0 ? '+' : ''}</dd>
          </div>
        ))}
      </dl>
      <Folded title="Workspace changes" read={traceApi.snapshot} attemptId={attemptId}>{diffList}</Folded>
      {session && <Folded title="Terminal recording" read={traceApi.recording} attemptId={attemptId}>{terminals}</Folded>}
    </header>
  );
}
