import {useEffect, useRef} from 'react';

/**
 * Dismiss-on-outside-click effect shared by ShareButton, QuickActions, the
 * Comments reaction picker, the TipTapEditor export menu, and Annotations.
 *
 * While `active` is truthy, a single `document` `mousedown` listener is
 * attached; it calls `handler(event)` whenever the click lands outside the
 * element held by `ref` (`ref.current && !ref.current.contains(event.target)`).
 * The listener is removed on cleanup (unmount, or when `active`/`ref` changes),
 * so passing `active` reproduces a conditional "only listen while open" effect,
 * while the default `active = true` reproduces an always-listening one.
 *
 * The latest `handler` is read through a ref so passing an inline closure does
 * not re-subscribe the listener on every render; subscription tracks `active`
 * only, matching the per-component effects this replaces.
 *
 * @param {React.RefObject<HTMLElement>} ref  Element treated as "inside".
 * @param {(event: MouseEvent) => void} handler  Run on an outside mousedown.
 * @param {boolean} [active=true]  Whether the listener is attached.
 */
export function useClickOutside(ref, handler, active = true) {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!active) return undefined;
    function handleMouseDown(event) {
      if (ref.current && !ref.current.contains(event.target)) {
        handlerRef.current(event);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [ref, active]);
}
