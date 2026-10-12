import React, {useRef} from 'react';
import {usePopover} from '@site/src/hooks/usePopover';
import menu from '@site/src/css/menu.module.css';
import styles from './people.module.css';

export const ROLES = ['owner', 'editor', 'viewer'];

export const ROLE_NOTE = {
  owner: 'Everything, including making other owners.',
  editor: 'Create, edit, and publish workspace content.',
  viewer: 'Read content and participate in comments.',
};

/** The pill a role is shown in. */
export function roleClass(role) {
  return `${styles.role} ${styles[`role_${role}`] ?? ''}`;
}

/** Roughly the tallest the list gets, in pixels: three roles and their notes. */
const MENU_ROOM = 200;

/**
 * Picks a workspace role, with what each role may do written under its name.
 *
 * A native select draws its list with the operating system, which neither
 * matches the page nor has room to say what a role means. Opens on the role
 * already held; the arrow keys move between roles.
 */
export default function RolePicker({value, onChange, label, disabled, className}) {
  const itemRefs = useRef([]);
  const popover = usePopover(MENU_ROOM, () => itemRefs.current[ROLES.indexOf(value)]?.focus());

  const onKeyDown = (event) => {
    popover.onKeyDown(event);
    if (!popover.open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    event.preventDefault();
    const at = itemRefs.current.indexOf(document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    itemRefs.current[(at + step + ROLES.length) % ROLES.length]?.focus();
  };

  return (
    <span className={styles.picker} ref={popover.wrapRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={popover.triggerRef}
        className={className}
        disabled={disabled}
        onClick={popover.toggle}
        aria-haspopup="listbox"
        aria-expanded={popover.open}
        aria-label={label}
        title={ROLE_NOTE[value]}
      >
        {value}
      </button>

      {popover.open && (
        <span className={`${menu.menu} ${styles.pickerMenu} ${popover.above ? menu.above : ''}`} role="listbox" aria-label={label}>
          {ROLES.map((role, i) => (
            <button
              key={role}
              type="button"
              role="option"
              aria-selected={role === value}
              ref={el => { itemRefs.current[i] = el; }}
              className={`${menu.item} ${styles.pickerItem}`}
              onClick={() => {
                popover.close({toTrigger: true});
                if (role !== value) onChange(role);
              }}
            >
              <span className={styles.pickerName}>{role}</span>
              <span className={styles.pickerNote}>{ROLE_NOTE[role]}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
