/**
 * The window's shape: how tall it is, whether it is minimised, whether the rail
 * is showing, and the footprint it publishes to the rest of the page.
 *
 * The important part is that last one. The CLI is fixed to the bottom of the
 * viewport, so without a published height it would sit on top of the last
 * paragraph of every page. Layout's :global(#__docusaurus) padding-bottom and
 * --site-shell-height (which /graph and /whiteboard size themselves from) are
 * both derived from --site-cli-height on the root element, and this hook is the
 * only thing that writes it. Publish it late, forget to remove it on unmount,
 * or republish it on every pointermove, and the page either gains a permanent
 * gap at the bottom or reflows itself sixty times a second while the edge is
 * being dragged.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

/* Pane geometry. The height is the user's to set, so it is remembered across
   visits and clamped to something usable on any viewport. */
const HEIGHT_KEY = 'mochi-cli-height';
const COLLAPSED_KEY = 'mochi-cli-collapsed';
const RAIL_KEY = 'mochi-cli-rail';
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 140;

/* The chrome around the two parts that are measured: the strip's 1px top border
   and, only while it is open, the 10px drag handle (shell.module.css .bar and
   .handle). These two are constants rather than measurements because a
   footprint is published before React has re-rendered the window into its new
   state, so the handle is still in the DOM at the moment a collapse is
   announced and measuring it there would publish the height of the window that
   is going away. The row is safe to measure: it is the same element open or
   closed. */
const BORDER_PX = 1;
const HANDLE_PX = 10;

/* How far one arrow key moves the top edge, and how far it moves with Shift
   held. The small step is about a line of the transcript, so the edge can be
   settled precisely; the large one is about a third of the default window, so
   crossing the viewport does not mean holding a key down. */
const STEP_PX = 16;
const COARSE_STEP_PX = 64;

const maxHeight = () => Math.round(window.innerHeight * 0.8);

/** Never taller than most of the viewport, never shorter than one usable pane. */
const clampHeight = (h) => Math.min(Math.max(h, MIN_HEIGHT), maxHeight());

export default function useGeometry() {
  const [collapsed, setCollapsedState] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const [railOpen, setRailOpenState] = useState(true);
  // The handle is a separator that reports its range, and the top of that range
  // is a share of the viewport. It is held in state rather than measured while
  // rendering because nothing else in this hook reads `window` during a render,
  // and because the resize listener below can leave the height untouched (a
  // clamp to the same number is a bail-out), which would strand a computed
  // maximum at its old value.
  const [maxH, setMaxH] = useState(() => (typeof window === 'undefined' ? DEFAULT_HEIGHT : maxHeight()));

  const rowRef = useRef(null);
  // The live height, read by the resize listener and by the drag handlers,
  // neither of which may depend on a render having happened first.
  const heightRef = useRef(DEFAULT_HEIGHT);
  const draggingRef = useRef(false);
  // The last value written, so an unchanged footprint costs nothing: the row
  // observer below fires once merely for being attached, and again for every
  // resize that leaves the height where it was.
  const publishedRef = useRef(null);

  // The rest of the layout sizes itself off --site-cli-height, so publishing the
  // window's real footprint there keeps page padding and --site-shell-height
  // correct without either of them knowing this component exists. Deliberately
  // not updated mid-drag: reflowing the whole document per pointermove is not
  // worth it, so the window floats over the page until the pointer is released.
  //
  // The row is measured rather than assumed to be --site-cli-row. It is only
  // that tall at rest; while a paragraph is being composed it grows to six
  // lines, and a value composed from the variable would reserve the resting
  // height for a window occupying the grown one. Collapsed publishes a value
  // too, for the same reason: the prompt row is outside the collapsed branch,
  // so it grows there as well. The variable stays the answer only when there is
  // no row to measure yet, which is the pre-hydration case it is written for.
  const publishFootprint = useCallback((isCollapsed, h) => {
    const measured = rowRef.current?.offsetHeight;
    const row = measured ? `${measured}px` : 'var(--site-cli-row)';
    const chrome = BORDER_PX + (isCollapsed ? 0 : HANDLE_PX + h);
    const value = `calc(${row} + ${chrome}px)`;
    if (publishedRef.current === value) return;
    publishedRef.current = value;
    document.documentElement.style.setProperty('--site-cli-height', value);
  }, []);

  useEffect(() => {
    let startCollapsed = false;
    let startHeight = DEFAULT_HEIGHT;
    try {
      startCollapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
      // Shown unless it has been closed, so the conversations are there to be
      // found rather than behind a control nobody knows about.
      setRailOpenState(localStorage.getItem(RAIL_KEY) !== '0');
      const saved = Number.parseInt(localStorage.getItem(HEIGHT_KEY), 10);
      if (Number.isFinite(saved)) startHeight = clampHeight(saved);
    } catch {
      /* storage unavailable (private mode); the defaults are fine */
    }
    heightRef.current = startHeight;
    setHeight(startHeight);
    setCollapsedState(startCollapsed);
    publishFootprint(startCollapsed, startHeight);
    // The variable outlives the component unless it is taken back, and a page
    // padded for a window that is no longer mounted has a hole in it. The
    // record of what was published goes with it, or a remount would find its
    // own value already there and publish nothing.
    return () => {
      publishedRef.current = null;
      document.documentElement.style.removeProperty('--site-cli-height');
    };
  }, [publishFootprint]);

  // The prompt row is the one part of the footprint that changes without this
  // hook being told: the field grows a line at a time while a paragraph is
  // typed and shrinks again when it is sent. Nothing else notices, so watch the
  // element. Still silent mid-drag, for the reason publishFootprint gives.
  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (draggingRef.current) return;
      publishFootprint(collapsed, heightRef.current);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [collapsed, publishFootprint]);

  // Shrinking the window must not leave the pane taller than the viewport.
  useEffect(() => {
    const onResize = () => {
      setMaxH(maxHeight());
      const h = clampHeight(heightRef.current);
      heightRef.current = h;
      setHeight(h);
      publishFootprint(collapsed, h);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [collapsed, publishFootprint]);

  const setCollapsed = useCallback((next) => {
    setCollapsedState(next);
    publishFootprint(next, heightRef.current);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      /* non-fatal: the state just will not persist */
    }
  }, [publishFootprint]);

  const setRailOpen = useCallback((next) => {
    setRailOpenState(next);
    try {
      localStorage.setItem(RAIL_KEY, next ? '1' : '0');
    } catch {
      /* non-fatal: the choice just will not persist */
    }
  }, []);

  /* ── Resizing the top edge ────────────────────────────────────── */

  // Where a resize ends, however it was made: the height becomes the state the
  // window renders from, the footprint the page pads for, and the number the
  // next visit starts at. Both the pointer and the keyboard finish here, so the
  // two paths cannot drift into publishing or persisting differently.
  const commitHeight = useCallback((h) => {
    heightRef.current = h;
    setHeight(h);
    publishFootprint(collapsed, h);
    try {
      localStorage.setItem(HEIGHT_KEY, String(h));
    } catch {
      /* non-fatal: the height just will not persist */
    }
  }, [collapsed, publishFootprint]);

  const startDrag = useCallback((e) => {
    e.preventDefault();
    draggingRef.current = true;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onDrag = useCallback((e) => {
    if (!draggingRef.current) return;
    // The window is anchored to the bottom, so its height is whatever sits
    // between the pointer and the top of the prompt row.
    const row = rowRef.current?.offsetHeight ?? 0;
    const h = clampHeight(window.innerHeight - e.clientY - row);
    heightRef.current = h;
    setHeight(h);
  }, []);

  const endDrag = useCallback((e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    // pointercancel releases capture for us, and releasing twice throws.
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Only now, for the reason publishFootprint gives: the height has been
    // moving with the pointer, and the page is told about it once.
    commitHeight(heightRef.current);
  }, [commitHeight]);

  // The handle is in the tab order, so the keyboard has to be able to do what
  // the pointer does. Every press lands on a finished height, so there is no
  // midpoint to hold back and each one commits: the footprint follows the edge
  // immediately, which is the pointer path's behaviour on release.
  const onHandleKey = useCallback((e) => {
    const step = e.shiftKey ? COARSE_STEP_PX : STEP_PX;
    let next;
    switch (e.key) {
      // The window is anchored to the bottom of the viewport, so pushing its
      // top edge up is what makes it taller.
      case 'ArrowUp':
        next = heightRef.current + step;
        break;
      case 'ArrowDown':
        next = heightRef.current - step;
        break;
      // The ends of the range the separator reports, which is the slider
      // convention: Home is the minimum value, not the top of the screen.
      case 'Home':
        next = MIN_HEIGHT;
        break;
      case 'End':
        next = maxHeight();
        break;
      default:
        return;
    }
    // All four keys scroll the document by default, and the handle sits on the
    // window's edge, so the page would slide out from under the control being
    // held.
    e.preventDefault();
    commitHeight(clampHeight(next));
  }, [commitHeight]);

  return {
    collapsed,
    setCollapsed,
    height,
    dragging,
    railOpen,
    setRailOpen,
    rowRef,
    bodyStyle: {height},
    /* Everything the top edge needs, so the caller only has to place it. A
       focusable separator has to say where it currently sits and how far it can
       go, or a screen reader announces a control with no state at all; the three
       values are the same ones clampHeight works between. */
    handleProps: {
      onPointerDown: startDrag,
      onPointerMove: onDrag,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onKeyDown: onHandleKey,
      tabIndex: 0,
      role: 'separator',
      'aria-orientation': 'horizontal',
      'aria-label': 'Resize the command bar',
      'aria-valuenow': height,
      'aria-valuemin': MIN_HEIGHT,
      'aria-valuemax': maxH,
      title: 'Drag or press the arrow keys to resize',
    },
  };
}
