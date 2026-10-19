import React from 'react';
import {SIDE_DEFAULT, useShell} from './context';
import styles from './styles.module.css';

const STEP = 16;

/**
 * The narrowest `bar` is drawn at: the width its content needs to show every
 * label, count, badge and action whole, which its layout's CSS holds it to
 * (min-width: min-content). Read by drawing it at no width for a moment,
 * folded or not, since a folded side bar keeps its layout, unseen.
 */
function narrowest(bar) {
  const {width} = bar.style;
  bar.style.width = '0px';
  const min = bar.offsetWidth;
  bar.style.width = width;
  return min;
}

/**
 * The shell's side bar's right edge, after VS Code's sash: dragging it sets
 * the width every section's side bar shares, at least what the side bar in
 * view needs to show its content whole (narrowest) and at most half the page;
 * dragged past half of that the side bar folds away, and dragged back out,
 * still held, it opens again. Folded, the sash waits at the page's left edge
 * to be dragged out. Double-click resets the width. It is the side bar's last
 * child, and the side bar is positioned.
 */
export default function Sash() {
  const {setOpen, setWidth, drag} = useShell();
  const min = React.useRef(0);
  // The width the drag is at, set on the page as the pointer moves (drag.move); null when no drag is on.
  const dragged = React.useRef(null);

  // The side bar sits at its layout's left edge, at most half of which it takes;
  // `set` draws it at the width it comes to.
  const place = (x, bar, set) => {
    const open = drag.isOpen();
    if (x < min.current / 2) {
      if (open) setOpen(false);
      return;
    }
    if (!open) setOpen(true);
    set(Math.round(Math.min(Math.max(x, min.current), bar.parentElement.clientWidth / 2)));
  };
  const end = () => {
    if (dragged.current === null) return;
    drag.end();
    // Folded at the end, the side bar keeps the width it last had open.
    if (drag.isOpen() && dragged.current) setWidth(dragged.current);
    dragged.current = null;
  };

  return (
    <div
      className={styles.sash}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side bar"
      tabIndex={0}
      title="Drag to resize or fold away, double-click to reset"
      onPointerDown={event => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        min.current = narrowest(event.currentTarget.parentElement);
        dragged.current = 0;
        drag.start();
      }}
      onPointerMove={event => {
        if (dragged.current === null) return;
        const bar = event.currentTarget.parentElement;
        place(event.clientX - bar.getBoundingClientRect().left, bar, px => {
          dragged.current = px;
          drag.move(px);
        });
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => {
        setOpen(true);
        setWidth(SIDE_DEFAULT);
      }}
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const bar = event.currentTarget.parentElement;
        min.current = narrowest(bar);
        const step = event.key === 'ArrowRight' ? STEP : -STEP;
        place(drag.isOpen() ? bar.offsetWidth + step : step > 0 ? min.current : 0, bar, setWidth);
      }}
    />
  );
}
