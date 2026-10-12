import React, {useEffect, useRef, useState} from 'react';
import clsx from 'clsx';
import {useClickOutside} from '@site/src/hooks/useClickOutside';
// The blog's group sidebar, reused so settings reads like docs, blogs and plugins.
import styles from '@site/src/components/BlogGroupSidebar/styles.module.css';

/**
 * The settings sidebar, shaped like the Plugins one: the switcher between your
 * own settings and the workspace's, then the sections of the one in view.
 * Which is in view lives in the URL hash, so every entry is a plain link.
 */

function ScopeIcon({scope}) {
  return (
    <svg className={styles.groupIcon} viewBox="0 0 20 20" aria-hidden="true">
      {scope === 'user' ? (
        <>
          <circle cx="10" cy="6.5" r="3.25" />
          <path d="M3.75 17c.6-3.2 3.1-5.25 6.25-5.25S15.65 13.8 16.25 17" />
        </>
      ) : (
        <>
          <rect x="3" y="3" width="5.5" height="5.5" rx="1.2" />
          <rect x="11.5" y="3" width="5.5" height="5.5" rx="1.2" />
          <rect x="3" y="11.5" width="5.5" height="5.5" rx="1.2" />
          <rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.2" />
        </>
      )}
    </svg>
  );
}

function ScopeSwitcher({scopes, scope}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef(null);
  useClickOutside(wrapper, () => setOpen(false), open);
  const current = scopes.find(item => item.id === scope);

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
        <ScopeIcon scope={scope} />
        <span className={styles.groupTitle}>{current.label}</span>
        <svg className={styles.chevron} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className={styles.groupMenu} role="listbox" aria-label="Choose settings">
          {scopes.map(item => (
            <div key={item.id} className={styles.groupOptionRow}>
              <a
                className={clsx(styles.groupOption, item.id === scope && styles.groupOptionSelected)}
                role="option"
                aria-selected={item.id === scope}
                href={item.href}
                onClick={() => setOpen(false)}
              >
                <span>{item.label}</span>
                {item.id === scope && <span className={styles.checkmark} aria-hidden="true">✓</span>}
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

export default function SettingsSidebar({scopes, scope, panes, activePane, collapsed, onCollapse}) {
  return (
    <div className={clsx(styles.sidebar, collapsed && styles.sidebarHidden)}>
      <div className={styles.sidebarControls}>
        <ScopeSwitcher scopes={scopes} scope={scope} />
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
      <nav className={clsx('menu thin-scrollbar', styles.menu)} aria-label="Settings sections">
        <ul className="menu__list">
          {panes.map(pane => (
            <li className="menu__list-item" key={pane.id}>
              <a
                className={clsx('menu__link', styles.categoryLink, pane.id === activePane && 'menu__link--active')}
                href={`#${pane.id}`}
                aria-current={pane.id === activePane ? 'location' : undefined}
              >
                <span className={styles.taxonomyTitle}>{pane.label}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
