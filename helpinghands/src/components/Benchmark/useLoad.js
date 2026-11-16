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
