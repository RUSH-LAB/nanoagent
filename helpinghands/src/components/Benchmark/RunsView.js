import React, {useState} from 'react';
import clsx from 'clsx';
import {toast} from '@site/src/components/Toast/toast';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import {clientPlatform} from '@site/src/platform/client';
import {benchmarkApi} from './api';
import {plural} from './labels';
import {POLICY_LABELS, attemptStatus, attemptsOf, explanationText, liveAttempts, personLabel, runIsActive, runPairProblem, scoreText, toggleRun, verdictText} from './runs';
import {LIMIT_LABELS} from './publish';
import useLoad, {useLiveReload, usePoll} from './useLoad';
import Metrics from './MetricsPanel';
import RunSummaryCard from './RunSummaryCard';
import PrepareHarness from './PrepareHarness';
import styles from './styles.module.css';
import compareStyles from './run-compare.module.css';

const when = iso => (iso ? new Date(iso).toLocaleString() : '');

export function RunsList({go}) {
  return (
    <>
      <PrepareHarness />
      <RunHistory go={go} />
    </>
  );
}

function RunHistory({go}) {
  const {data, error, loading, reload} = useLoad(async () => ({runs: await benchmarkApi.allRuns()}), []);
  const [ticked, setTicked] = useState([]);
  usePoll(reload, 8000, true);
  if (error) return <p className={styles.error}>{error}</p>;
  if (loading && !data) return <LoadingSkeleton shape="block" height={120} />;
  if (!data.runs.length) return <div className={styles.emptyState}><p>No runs yet. Start one from Benchmark Your Harness.</p></div>;
  const kept = ticked.filter(id => data.runs.some(run => run.run_id === id));
  const problem = runPairProblem(kept, data.runs);
  return (
    <div className={compareStyles.runs}>
      <div className={compareStyles.selectionBar}>
        <div><strong>Compare runs</strong><p className={styles.muted}>{problem ?? 'Ready to compare. The verifier package is checked when you open the comparison.'}</p></div>
        <button type="button" className={styles.primaryButton} disabled={Boolean(problem)} onClick={() => go({runs: kept.join(',')})}>Compare {kept.length}/2 runs</button>
      </div>
      <div className={compareStyles.runGrid}>
        {data.runs.map(run => <RunSummaryCard key={run.run_id} run={run} ticked={kept} onToggle={id => setTicked(toggleRun(kept, id, data.runs))} onOpen={id => go({run: id})} />)}
      </div>
    </div>
  );
}

/**
 * One run, kept live: it is read again while it is active and whenever an attempt a worker holds commits an event (each such
 * attempt's stream is followed, resuming from its last cursor).
 */
export function RunView({runId, go}) {
  const {data: run, error, reload} = useLoad(() => benchmarkApi.run(runId).then(result => result.run), [runId]);
  const [busy, setBusy] = useState(false);
  usePoll(reload, 4000, run ? runIsActive(run) : true);

  useLiveReload(run ? liveAttempts(run) : [], reload);

  if (error && !run) return <p className={styles.error}>{error}</p>;
  if (!run) return <LoadingSkeleton shape="block" height={160} />;
  const act = async (work, success) => {
    setBusy(true);
    try { await work(); if (success) toast.success(success); reload(); } catch (failure) { toast.error(failure.message); } finally { setBusy(false); }
  };
  const {case_set: caseSet} = run;

  return (
    <div>
      <header className={styles.header}>
        <button type="button" className={styles.link} onClick={() => go({})}>All runs</button>
        {error && <p className={styles.error} role="alert">Could not refresh this run: {error}</p>}
        <h2>Run <code>{run.run_id.slice(0, 8)}</code> <span className={clsx(styles.badge, styles[`status_${run.status}`])}>{run.status}</span></h2>
        <p className={styles.muted}>{run.model} on {run.endpoint_profile} · started {when(run.created_at)} · source <code>{run.source.sha256.slice(0, 12)}</code> · {run.prompt.renderer_version}</p>
        <dl className={styles.facts}>
          <dt>Task</dt><dd>{caseSet.plugin.name} v{caseSet.plugin.version} · {caseSet.task_id} ({caseSet.task.kind})</dd>
          <dt>Case set</dt><dd>{caseSet.name} by {personLabel(caseSet.publisher)} · digest <code>{caseSet.digest.slice(0, 12)}</code></dd>
          <dt>Participant policy</dt><dd>{POLICY_LABELS[run.policy] ?? run.policy}</dd>
          <dt>Prompt</dt><dd>{run.prompt.source}{run.prompt.source === 'custom' && <span className={styles.badge}>edited</span>}</dd>
          <dt>Cases</dt><dd>{plural(run.cases.length, 'case')} in this run</dd>
          <dt>Internet access</dt><dd>{run.limits.internet_access ? 'on' : 'off'}{run.unverified_egress && <span className={clsx(styles.badge, styles.unverified)} title="Model calls that bypass the gateway cannot be detected">unverified egress</span>}</dd>
          <dt>Egress hosts</dt><dd>{run.egress_hosts === null ? 'Not applicable (coding policy)' : run.egress_hosts.length ? run.egress_hosts.join(', ') : 'None'}</dd>
          <dt>Score</dt><dd><strong>{scoreText(run.score)}</strong></dd>
        </dl>
        <details><summary>Limits</summary>
          <dl className={styles.facts}>{Object.keys(LIMIT_LABELS).filter(name => name in run.limits).map(name => <React.Fragment key={name}><dt>{LIMIT_LABELS[name]}</dt><dd>{String(run.limits[name])}</dd></React.Fragment>)}</dl>
        </details>
        <details><summary>Prompt {run.policy === 'coding' ? 'template' : 'instructions'}</summary><pre>{run.prompt.text}</pre></details>
        <Metrics metrics={run.metrics} />
        {!run.canceled_at && run.status !== 'complete' && (
          <p><button type="button" disabled={busy} onClick={async () => (await clientPlatform.dialogs.confirm('Cancel this run? Attempts in progress are told to stop.')) && act(() => benchmarkApi.cancel(run.run_id), 'Cancel requested')}>Cancel run</button></p>
        )}
      </header>
      <section className={styles.suite}>
        <table className={styles.table}>
          <thead><tr><th>Case</th><th>Attempt</th><th>Status</th><th>Verdict</th><th>Explanation</th><th>Coverage</th><th>Tokens</th><th>Elapsed</th><th /></tr></thead>
          <tbody>
            {run.cases.flatMap(item => item.attempts.map(attempt => (
              <tr key={attempt.attempt_id} className={clsx({[styles.latest]: attempt.attempt_id === item.latest_attempt_id})}>
                <td>{item.case_id} <small className={styles.muted}>{item.kind}</small></td>
                <td>#{attempt.attempt_no}{attempt.rerun_of && ' (rerun)'}</td>
                <td>{attemptStatus(attempt)}{attempt.execution?.reason && <small className={styles.muted}> {attempt.execution.reason}</small>}</td>
                <td>{verdictText(attempt)}</td>
                <td>{explanationText(attempt.explanation)}{attempt.verifier_error && <small className={styles.muted}> {attempt.verifier_error}</small>}</td>
                <td>{attempt.coverage?.status ?? '–'}</td>
                <td>{attempt.metrics?.total_tokens?.toLocaleString?.('en-US') ?? '–'}</td>
                <td>{attempt.metrics?.elapsed_ms ?? '–'}{attempt.metrics?.elapsed_ms != null && ' ms'}</td>
                <td className={styles.actions}>
                  <button type="button" onClick={() => go({attempt: attempt.attempt_id, run: run.run_id})}>Trace</button>
                  {attempt.attempt_id === item.latest_attempt_id && attempt.state === 'final' && !run.canceled_at && (
                    <button type="button" disabled={busy} onClick={() => act(() => benchmarkApi.rerun(run.run_id, item.case_id), 'Rerun queued')}>Rerun</button>
                  )}
                </td>
              </tr>
            )))}
          </tbody>
        </table>
        <details><summary>Prompts ({run.cases.length} cases)</summary>
          {run.cases.map(item => (
            <details key={item.case_id}>
              <summary>{item.case_id} <code>{item.prompt.sha256.slice(0, 12)}</code></summary>
              {item.prompt.system !== null && <><h5>System</h5><pre>{item.prompt.system}</pre></>}
              {item.prompt.user !== null && <><h5>User</h5><pre>{item.prompt.user}</pre></>}
            </details>
          ))}
        </details>
      </section>
      <p className={styles.muted}>{attemptsOf(run).length} attempts.</p>
    </div>
  );
}
