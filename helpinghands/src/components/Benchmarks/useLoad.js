import {useCallback, useEffect, useRef, useState} from 'react';

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
  return {...viewOf(state, key), reload: run};
}

/** What a load of `key` shows of `state`: data, error and loading belong to the load they came from, never to the one before it. */
export function viewOf(state, key) {
  return {data: state.key === key ? state.data : null, error: state.key === key ? state.error : null, loading: state.loading || state.key !== key};
}

/** Call `reload` every `ms` while `active`, skipping a tick while the read before it is still under way (a later read would discard it). */
export function usePoll(reload, ms, active) {
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(oneAtATime(reload), ms);
    return () => clearInterval(timer);
  }, [reload, ms, active]);
}

/** `read` as a function that starts it only when the read it started before has ended, and otherwise does nothing. */
export function oneAtATime(read) {
  let busy = false;
  return () => {
    if (busy) return;
    busy = true;
    Promise.resolve(read()).finally(() => { busy = false; });
  };
}
