import React, {useCallback, useMemo} from 'react';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import {benchmarkApi} from './api';
import {attemptStatus, explanationText, verdictText} from './runs';
import {buildTrace} from './traceModel';
import {spansCut} from './pagination';
import useLoad, {useLiveReload} from './useLoad';
import TraceActivity from './TraceActivity';
import Metrics from './MetricsPanel';
import styles from './styles.module.css';
import traceStyles from './trace.module.css';

export default function TraceView({attemptId, onBack, backLabel = 'All runs'}) {
  const attempt = useLoad(() => benchmarkApi.attempt(attemptId).then(result => result.attempt), [attemptId]);
  const spans = useLoad(() => benchmarkApi.spans(attemptId), [attemptId]);
  const model = useMemo(() => buildTrace(spans.data ?? {}), [spans.data]);
  const sealed = attempt.data?.sealed;

  const reload = useCallback(() => { attempt.reload(); spans.reload(); }, [attempt.reload, spans.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  useLiveReload(sealed === false ? [attemptId] : [], reload);

  const a = attempt.data;

  return (
    <div className={traceStyles.trace}>
      <button type="button" className={styles.link} onClick={onBack}>← {backLabel}</button>
      {(attempt.error || spans.error) && <p className={styles.error} role="alert">{attempt.error ?? spans.error}</p>}
      {!attempt.error && !spans.error && !a && <LoadingSkeleton shape="block" height={160} />}
      {a && (
        <header className={traceStyles.header}>
          <h2>{a.case_id}{!a.sealed && <span className={styles.badge}>Live</span>}</h2>
          <p className={styles.fieldHint}>{a.kind === 'refuse' ? 'Refusal' : 'Answer'} case · Attempt {a.attempt_no} · Run <code>{a.run_id.slice(0, 8)}</code></p>
          <p className={traceStyles.outcome}>
            <strong>{attemptStatus(a)}</strong>{a.execution?.reason && ` (${a.execution.reason})`}
            {verdictText(a) !== '–' && <span className={styles.badge}>{verdictText(a)}</span>}
            {a.explanation && <> · {explanationText(a.explanation)}</>}
            {a.verifier_error && <> · Verifier error: {a.verifier_error}</>}
          </p>
          <Metrics metrics={a.metrics} />
          <details className={traceStyles.traceContext}>
            <summary>Prompt and timing details</summary>
            {a.prompt?.system != null && <><h4>System prompt</h4><pre>{a.prompt.system}</pre></>}
            {a.prompt?.user != null && <><h4>User prompt</h4><pre>{a.prompt.user}</pre></>}
            <Metrics metrics={a.metrics} coverage={a.coverage} timing showPrimary={false} />
          </details>
        </header>
      )}
      {spansCut(spans.data) && <p className={styles.muted}>This trace is too large to show whole; only its first {spans.data.spans.length.toLocaleString('en-US')} spans are shown.</p>}
      {a && !spans.error && <TraceActivity attemptId={attemptId} model={model} loading={spans.loading} />}
    </div>
  );
}
