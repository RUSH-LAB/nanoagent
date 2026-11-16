import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import {benchmarkApi} from './api';
import {attemptStatus, explanationText, verdictText} from './runs';
import {followStream} from './sse';
import {buildTrace} from './traceModel';
import useLoad from './useLoad';
import TraceActivity from './TraceActivity';
import Metrics from './MetricsPanel';
import styles from './styles.module.css';
import traceStyles from './trace.module.css';

export default function TraceView({attemptId, onBack, backLabel = 'All runs'}) {
  const attempt = useLoad(() => benchmarkApi.attempt(attemptId).then(result => result.attempt), [attemptId]);
  const spans = useLoad(() => benchmarkApi.spans(attemptId), [attemptId]);
  const model = useMemo(() => buildTrace(spans.data ?? {}), [spans.data]);
  const sealed = attempt.data?.sealed;

  const reloadSoon = useRef(null);
  const reload = useCallback(() => {
    if (reloadSoon.current) return;
    reloadSoon.current = setTimeout(() => { reloadSoon.current = null; attempt.reload(); spans.reload(); }, 1000);
  }, [attempt.reload, spans.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sealed !== false) return undefined;
    const controller = new AbortController();
    followStream({attemptId, open: benchmarkApi.openStream, read: benchmarkApi.readStream, signal: controller.signal, onFrame: reload}).then(() => {
      if (!controller.signal.aborted) reload();
    });
    return () => controller.abort();
  }, [attemptId, sealed, reload]);
  // Cleared and forgotten: a hidden section (Shell's <Activity>) keeps its refs, and a stale one would stop every reload after.
  useEffect(() => () => { clearTimeout(reloadSoon.current); reloadSoon.current = null; }, []);

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
      {a && !spans.error && <TraceActivity attemptId={attemptId} model={model} loading={spans.loading} />}
    </div>
  );
}
