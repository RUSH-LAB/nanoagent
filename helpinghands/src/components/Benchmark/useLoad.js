import {useCallback, useEffect, useRef, useState} from 'react';
import {benchmarkApi} from './api';
import {followStream} from './sse';

/**
 * `load()` read now and again by `reload()`: `{data, error, loading, reload}`. A read again keeps the last data on screen
 * until the new one arrives, and `deps` changing starts a new read of what the page now names.
 */
export default function useLoad(load, deps) {
  const [state, setState] = useState({data: null, error: null, loading: true, key: null});
  const latest = useRef(0);
  const key = JSON.stringify(deps);
  const run = useCallback(() => {
    const mine = ++latest.current;
    return load().then(
      data => { if (mine === latest.current) setState({data, error: null, loading: false, key}); },
      error => { if (mine === latest.current) setState(previous => ({data: previous.key === key ? previous.data : null, error: error.message, loading: false, key})); },
    );
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    run();
    return () => { latest.current += 1; };
  }, [run]);
  return {data: state.key === key ? state.data : null, error: state.error, loading: state.loading || state.key !== key, reload: run};
}

/** Call `reload` every `ms` while `active`. */
export function usePoll(reload, ms, active) {
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(reload, ms);
    return () => clearInterval(timer);
  }, [reload, ms, active]);
}

/**
 * Call `reload` (at most once a second) whenever an attempt in `attemptIds` commits an event: each one's stream is followed,
 * resuming from its last cursor, and once it ends.
 */
export function useLiveReload(attemptIds, reload) {
  const live = attemptIds.join(',');
  const soon = useRef(null);
  const reloadSoon = useCallback(() => {
    if (soon.current) return;
    soon.current = setTimeout(() => { soon.current = null; reload(); }, 1000);
  }, [reload]);
  useEffect(() => {
    if (!live) return undefined;
    const controller = new AbortController();
    for (const attemptId of live.split(',')) {
      followStream({attemptId, open: benchmarkApi.openStream, read: benchmarkApi.readStream, signal: controller.signal, onFrame: reloadSoon}).then(() => {
        if (!controller.signal.aborted) reloadSoon();
      });
    }
    return () => controller.abort();
  }, [live, reloadSoon]);
  // Cleared and forgotten: a hidden section (Shell's <Activity>) keeps its refs, and a stale one would stop every reload after.
  useEffect(() => () => { clearTimeout(soon.current); soon.current = null; }, []);
}
