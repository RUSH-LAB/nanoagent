import React, {useEffect, useRef, useState} from 'react';
import {useClickOutside} from '@site/src/hooks/useClickOutside';
import styles from './styles.module.css';

/** Roughly the tallest this menu gets, in pixels: four items and its padding. */
const MENU_ROOM = 180;

/**
 * The overflow menu on a row of a directory.
 *
 * A row can offer five things and a person wants one of them. Showing all five
 * as buttons gives the common action and the irreversible one the same weight
 * and turns a list into a wall, so the row keeps what you do often and this
 * holds what you do once: renaming, archiving, removing, deleting.
 *
 * Closes on an outside click and on Escape, and puts focus back on the trigger
 * when it does, so a keyboard does not lose its place. `danger` marks an item
 * red on hover only: destruction should be unmistakable when you reach for it
 * and quiet the rest of the time.
 */
export default function RowMenu({label, items}) {
  const [open, setOpen] = useState(false);
  // Whether the panel hangs above the trigger instead of below it.
  const [above, setAbove] = useState(false);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const firstItemRef = useRef(null);

  useClickOutside(wrapRef, () => setOpen(false), open);

  useEffect(() => {
    if (!open) return;
    // The CLI is docked to the bottom of every page, so a menu on the last row
    // of a list would open underneath it. Measured on opening rather than
    // guessed from the row's index, which says nothing about where the page
    // happens to be scrolled to.
    const room = window.innerHeight - triggerRef.current.getBoundingClientRect().bottom;
    setAbove(room < MENU_ROOM);
    firstItemRef.current?.focus();
  }, [open]);

  const close = ({toTrigger = false} = {}) => {
    setOpen(false);
    if (toTrigger) triggerRef.current?.focus();
  };

  const usable = items.filter(Boolean);
  if (usable.length === 0) return null;

  return (
    <span
      className={styles.wrap}
      ref={wrapRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close({toTrigger: true});
        }
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        &#8943;
      </button>

      {open && (
        <span className={`${styles.menu} ${above ? styles.menuAbove : ''}`} role="menu">
          {usable.map((item, i) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              ref={i === 0 ? firstItemRef : null}
              className={`${styles.item} ${item.danger ? styles.danger : ''}`}
              disabled={item.disabled}
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
