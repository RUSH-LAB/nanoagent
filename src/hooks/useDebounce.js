import {useState, useEffect} from 'react';

/**
 * Debounce a fast-changing value: returns the latest `value` only after it has
 * stayed unchanged for `delay` milliseconds. Shared by the content-search,
 * bibliography, and glossary pages to throttle their search inputs.
 *
 * Each change to `value` (or `delay`) arms a fresh timer; the previous timer is
 * cleared on the next change or on unmount, so only the final value in a burst
 * is committed. The debounced state is seeded with the initial `value`, so the
 * first render already reflects it.
 *
 * @param {*} value  The value to debounce.
 * @param {number} delay  Quiet period in milliseconds before the value commits.
 * @returns {*} The most recent value that has held steady for `delay` ms.
 */
export function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
