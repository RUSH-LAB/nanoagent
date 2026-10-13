import {useEffect, useRef, useState} from 'react';
import {useClickOutside} from './useClickOutside';

/**
 * The open, close and placement of a small menu anchored to a trigger, shared
 * by the row menus and the role picker.
 *
 * Closes on an outside click and on Escape, and puts focus back on the trigger
 * when Escape closes it, so a keyboard does not lose its place. `onOpen` runs
 * once each time the menu opens, for the caller to move focus into it.
 *
 * The CLI is docked to the bottom of every page, so a menu on the last row of a
 * list would open underneath it. `above` says to hang it upward instead; it is
 * measured on opening rather than guessed from the row's index, which says
 * nothing about where the page happens to be scrolled to.
 *
 * @param {number} room  Roughly the tallest the menu gets, in pixels.
 * @param {() => void} [onOpen]  Run after the menu opens.
 */
export function usePopover(room, onOpen) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useClickOutside(wrapRef, () => setOpen(false), open);

  useEffect(() => {
    if (!open) return;
    setAbove(window.innerHeight - triggerRef.current.getBoundingClientRect().bottom < room);
    onOpenRef.current?.();
  }, [open, room]);

  const close = ({toTrigger = false} = {}) => {
    setOpen(false);
    if (toTrigger) triggerRef.current?.focus();
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      close({toTrigger: true});
    }
  };

  return {open, above, wrapRef, triggerRef, toggle: () => setOpen(v => !v), close, onKeyDown};
}
