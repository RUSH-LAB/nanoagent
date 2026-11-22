import {useCallback, useEffect, useMemo, useRef} from 'react';
import {traceApi} from './api';
import {packRows} from './packRows';
import {transcriptRows} from './transcriptRows';
import {actionSpans, buildTrace} from './traceModel';
import useLoad, {usePoll} from '../Benchmarks/useLoad';

const TIMELINE_KINDS = new Set(['model_call', 'tool', 'command', 'process', 'subagent']);

/** One attempt's header record, spans, cost and the models derived from them: the timeline's packed bars and the transcript rows. */
export default function useTrace(attemptId, showProcesses = true) {
  const attempt = useLoad(() => traceApi.attempt(attemptId), [attemptId]);
  const spans = useLoad(() => traceApi.spans(attemptId), [attemptId]);
  const accounting = useLoad(() => traceApi.accounting(attemptId), [attemptId]);
  // A live attempt's trace is read again until it is sealed, keeping what is on screen meanwhile.
  const {reload: reloadAttempt} = attempt;
  const {reload: reloadSpans} = spans;
  const {reload: reloadAccounting} = accounting;
  const refresh = useCallback(() => Promise.all([reloadAttempt(), reloadSpans(), reloadAccounting()]), [reloadAttempt, reloadSpans, reloadAccounting]);
  const live = attempt.data !== null && !attempt.data.sealed;
  usePoll(refresh, 3000, live);
  // Once a read finds it sealed, its spans and cost are read once more: the poll that saw the seal may have read them just before it.
  const wasLive = useRef(false);
  useEffect(() => {
    if (live) wasLive.current = true;
    else if (wasLive.current && attempt.data?.sealed) {
      wasLive.current = false;
      reloadSpans();
      reloadAccounting();
    }
  }, [live, attempt.data, reloadSpans, reloadAccounting]);
  const model = useMemo(() => buildTrace(spans.data ?? {}), [spans.data]);
  const actions = useMemo(() => actionSpans(model), [model]);
  const visible = useMemo(() => ({...model, spans: actions.filter(span => showProcesses || span.kind !== 'process')}), [model, actions, showProcesses]);
  const packed = useMemo(() => packRows(visible.spans.filter(span => TIMELINE_KINDS.has(span.kind)), model.window.end), [model, visible]);
  // A model call's cost is its settled admission, by call_id: the spans carry tokens but no cost.
  const costs = useMemo(() => new Map((accounting.data?.calls ?? []).filter(call => call.admission.status === 'settled').map(call => [call.call_id, call.admission.cost_usd])), [accounting.data]);
  const rows = useMemo(() => transcriptRows(visible, costs), [visible, costs]);
  return {
    attempt: attempt.data, accounting: accounting.data, model, packed, rows, hasProcesses: actions.some(span => span.kind === 'process'),
    truncated: Boolean(spans.data?.truncated),
    error: attempt.error ?? spans.error, loading: attempt.loading || spans.loading,
  };
}
