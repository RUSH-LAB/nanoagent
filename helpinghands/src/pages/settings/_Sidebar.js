import React, {useEffect, useRef, useState} from 'react';
import clsx from 'clsx';
import {useClickOutside} from '@site/src/hooks/useClickOutside';
import SidebarTree from '@site/src/components/SidebarTree';
// The blog's group sidebar, reused so settings reads like docs, blogs and plugins.
import styles from '@site/src/components/BlogGroupSidebar/styles.module.css';

/**
 * The settings sidebar, shaped like the blog's: a switcher on top, then your
 * own settings and the workspace's as two groups of sections, all on one page.
 * Which section is in view lives in the URL hash, so every entry is a plain link.
 */

function GroupIcon({group, className}) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
      {group === 'user' ? (
        <>
          <circle cx="10" cy="6.5" r="3.25" />
          <path d="M3.75 17c.6-3.2 3.1-5.25 6.25-5.25S15.65 13.8 16.25 17" />
        </>
      ) : group === 'workspace' ? (
        <>
          <rect x="3" y="3" width="5.5" height="5.5" rx="1.2" />
          <rect x="11.5" y="3" width="5.5" height="5.5" rx="1.2" />
          <rect x="3" y="11.5" width="5.5" height="5.5" rx="1.2" />
          <rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.2" />
        </>
      ) : (
        <>
          <circle cx="10" cy="10" r="2.75" />
          <path d="M10 2.5v2.25M10 15.25v2.25M2.5 10h2.25M15.25 10h2.25M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6" />
        </>
      )}
    </svg>
  );
}

/** The one place settings live, for now; the switcher has room for more. */
const PLACES = [{id: 'settings', label: 'Settings', href: '#account'}];

function PlaceSwitcher() {
  const [open, setOpen] = useState(false);
  const wrapper = useRef(null);
  useClickOutside(wrapper, () => setOpen(false), open);
  const current = PLACES[0];

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = event => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  return (
    <div className={styles.groupSwitcher} ref={wrapper}>
      <button
        className={styles.groupTrigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <GroupIcon className={styles.groupIcon} />
        <span className={styles.groupTitle}>{current.label}</span>
        <svg className={styles.chevron} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className={styles.groupMenu} role="listbox" aria-label="Choose settings">
          {PLACES.map(item => (
            <div key={item.id} className={styles.groupOptionRow}>
              <a
                className={clsx(styles.groupOption, item === current && styles.groupOptionSelected)}
                role="option"
                aria-selected={item === current}
                href={item.href}
                onClick={() => setOpen(false)}
              >
                <span>{item.label}</span>
                {item === current && <span className={styles.checkmark} aria-hidden="true">✓</span>}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DoubleChevron() {
  return (
    <svg className={styles.doubleChevron} viewBox="0 0 16 16" aria-hidden="true">
      <path d="m7 4-4 4 4 4M12 4 8 8l4 4" />
    </svg>
  );
}

/** User and Workspace as collapsible categories; both start open, since they are one page. */
function GroupTree({groups, activePane}) {
  const items = groups.map(group => ({
    key: group.id,
    label: group.label,
    to: `#${group.panes[0].id}`,
    icon: <GroupIcon group={group.id} className={styles.taxonomyIcon} />,
    active: group.panes.some(pane => pane.id === activePane),
    children: group.panes.map(pane => ({key: pane.id, label: pane.label, to: `#${pane.id}`, active: pane.id === activePane})),
  }));
  return <SidebarTree label="Settings sections" items={items} />;
}

export default function SettingsSidebar({groups, activePane, collapsed, onCollapse}) {
  return (
    <div className={clsx(styles.sidebar, collapsed && styles.sidebarHidden)}>
      {/* Inside the shell the side bar's title names Settings, and the activity bar hides it. */}
      {onCollapse && (
        <div className={styles.sidebarControls}>
          <PlaceSwitcher />
          <button
            className={styles.collapseButton}
            type="button"
            title="Collapse settings navigation"
            aria-label="Collapse settings navigation"
            onClick={onCollapse}
          >
            <DoubleChevron />
          </button>
        </div>
      )}
      <GroupTree groups={groups} activePane={activePane} />
    </div>
  );
}
