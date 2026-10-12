import React, {useRef} from 'react';
import {usePopover} from '@site/src/hooks/usePopover';
import menu from '@site/src/css/menu.module.css';
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
 * `danger` marks an item red on hover only: destruction should be unmistakable
 * when you reach for it and quiet the rest of the time.
 */
export default function RowMenu({label, items}) {
  const firstItemRef = useRef(null);
  const popover = usePopover(MENU_ROOM, () => firstItemRef.current?.focus());

  const usable = items.filter(Boolean);
  if (usable.length === 0) return null;

  return (
    <span className={styles.wrap} ref={popover.wrapRef} onKeyDown={popover.onKeyDown}>
      <button
        type="button"
        ref={popover.triggerRef}
        className={`${styles.trigger} ${popover.open ? styles.triggerOpen : ''}`}
        onClick={popover.toggle}
        aria-haspopup="menu"
        aria-expanded={popover.open}
        aria-label={label}
        title={label}
      >
        &#8943;
      </button>

      {popover.open && (
        <span className={`${menu.menu} ${styles.menu} ${popover.above ? menu.above : ''}`} role="menu">
          {usable.map((item, i) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              ref={i === 0 ? firstItemRef : null}
              className={`${menu.item} ${item.danger ? styles.danger : ''}`}
              disabled={item.disabled}
              onClick={() => {
                popover.close();
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
