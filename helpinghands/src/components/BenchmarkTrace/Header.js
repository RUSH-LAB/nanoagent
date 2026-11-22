import React, {useState} from 'react';
import {traceApi} from './api';
import {accountingCost, formatTokens} from './format';
import useLoad from './useLoad';
import styles from './trace.module.css';

// Terminal control sequences, which a recording holds beside its text.
const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const decode = data => new TextDecoder().decode(Uint8Array.from(atob(data), char => char.charCodeAt(0))).replace(ESCAPES, '');

/** A section folded away until it is opened, which is when `read` is first called. */
function Folded({title, read, attemptId, children}) {
  const [open, setOpen] = useState(false);
  const state = useLoad(() => read(attemptId), attemptId, !open);
  return (
    <details className={styles.folded} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {open && state.loading && <p className={styles.muted}>Loading…</p>}
      {state.error && <p className={styles.warn}>{state.error}</p>}
      {open && !state.loading && !state.error && children(state.data)}
    </details>
  );
}

const diffList = snapshot => !snapshot ? <p className={styles.muted}>No snapshot was taken.</p>
  : snapshot.diff.length === 0 ? <p className={styles.muted}>None.</p>
    : <ul>{snapshot.diff.map(entry => <li key={entry.path}><code>{entry.change} {entry.path}</code> <small>{entry.size} bytes</small></li>)}{snapshot.diff_truncated && <li>Cut to fit.</li>}</ul>;

const terminals = recording => recording.terminals.length === 0 ? <p className={styles.muted}>No terminal was recorded.</p>
  : recording.terminals.map(({terminal, data}) => <pre key={terminal} aria-label={`Terminal ${terminal}`}>{decode(data)}</pre>);

/** Outcome, verdict, cost and tokens of one attempt; the workspace diff and the terminal recording are folded away. */
export default function Header({attemptId, attempt, accounting, harnessName}) {
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
        {' · '}Cost {accountingCost(accounting)}
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
      <Folded title="Terminal recording" read={traceApi.recording} attemptId={attemptId}>{terminals}</Folded>
    </header>
  );
}
