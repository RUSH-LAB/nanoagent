import {useEffect, useState} from 'react';

/** `{data, error, loading}` of `read()`, read again when `key` changes; `skip` reads nothing. */
export default function useLoad(read, key, skip = false) {
  // Loading from the first render, so a section opened later never shows its empty data before its first read starts.
  const [state, setState] = useState({data: null, error: null, loading: true});
  useEffect(() => {
    if (skip) return undefined;
    let live = true;
    setState({data: null, error: null, loading: true});
    read().then(
      data => live && setState({data, error: null, loading: false}),
      error => live && setState({data: null, error: error.message, loading: false}),
    );
    return () => { live = false; };
  }, [key, skip]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}
