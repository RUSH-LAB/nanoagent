import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import NavbarLogo from '@theme/Navbar/Logo';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import { useThemeConfig } from '@docusaurus/theme-common';
import { useLocation } from '@docusaurus/router';
import { useClickOutside } from '@site/src/hooks/useClickOutside';
import { getCachedWorkspaces, loadWorkspaces, switchWorkspace } from '@site/src/utils/workspaces';
import styles from './styles.module.css';

/**
 * The navbar's top-left corner: which workspace you are in, and a way to the
 * others.
 *
 * It stands in for the site brand rather than sitting beside it, because the two
 * would say almost the same thing in adjacent words. The brand is a build-time
 * constant that never changes; the workspace is the thing that decides what
 * every channel, person, and invitation on the page refers to, so that is the
 * more useful of the two to have on screen.
 *
 * Falls back to the ordinary logo, unchanged, in every case where there is no
 * workspace to name: authentication off, signed out, the API unreachable, and
 * the static build. That fallback is also what makes hydration safe. The navbar
 * is part of every prerendered page, so the first client render has to match the
 * HTML exactly or React reports a mismatch; rendering the stock logo until the
 * request answers is the same markup the build produced.
 */

/** Marks the workspace you are in, in the list of the ones you could be in. */
function Check() {
  return (
    <svg className={styles.check} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M13.5 4.5 6.5 11.5 3 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function WorkspaceSwitcher() {
  const { siteConfig } = useDocusaurusContext();
  const { navbar } = useThemeConfig();
  const authEnabled = siteConfig.customFields?.authEnabled;
  const location = useLocation();

  const cached = getCachedWorkspaces();
  const [workspaces, setWorkspaces] = useState(cached?.memberships ?? null);
  const [activeId, setActiveId] = useState(cached?.activeId ?? null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const wrapper = useRef(null);
  // Unconditional, because it is a hook: the early return below is beneath it.
  const logoUrl = useBaseUrl(navbar.logo?.src ?? '');

  useClickOutside(wrapper, () => setOpen(false), open);

  // Escape closes it, because a menu you can open with the keyboard and only
  // close with the mouse is a trap.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!authEnabled) return undefined;
    let cancelled = false;
    loadWorkspaces()
      .then(({ memberships, activeId: active }) => {
        if (cancelled) return;
        setWorkspaces(memberships ?? []);
        setActiveId(active ?? null);
      })
      .catch(() => { /* the brand stays the brand */ });
    return () => { cancelled = true; };
  }, [authEnabled]);

  const routeSlug = /^\/w\/([^/]+)/.exec(location.pathname)?.[1];
  const active = workspaces?.find((w) => w.slug === routeSlug)
    ?? workspaces?.find((w) => w.id === activeId);

  // Nothing to name yet, or nothing to name at all. The stock logo, untouched.
  if (!active) return <NavbarLogo />;

  async function choose(workspace) {
    if (workspace.slug === active?.slug) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await switchWorkspace(workspace);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className={clsx('navbar__item', styles.wrapper)} ref={wrapper}>
      <button
        type="button"
        className={clsx('navbar__brand', styles.trigger)}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`${active.name} — switch workspace`}
        aria-label={`Current workspace: ${active.name}. Switch workspace`}
      >
        {navbar.logo && (
          <div className="navbar__logo">
            <img src={logoUrl} alt="" className={styles.logo} />
          </div>
        )}
        <span className={styles.identity}>
          <b className={clsx('navbar__title', 'text--truncate', styles.name)}>{active.name}</b>
          <span className={styles.context}>Workspace</span>
        </span>
        <svg className={styles.caret} viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          <p className={styles.heading}>Workspaces</p>
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitem"
              className={clsx(styles.option, workspace.id === active.id && styles.current)}
              disabled={busy}
              onClick={() => choose(workspace)}
            >
              <span className={styles.workspaceMark} aria-hidden="true">
                {workspace.name.trim().charAt(0).toUpperCase() || 'W'}
              </span>
              <span className={styles.label}>
                <span className={styles.optionName}>{workspace.name}</span>
                <span className={styles.meta}>
                  {workspace.role}, {workspace.memberCount}{' '}
                  {workspace.memberCount === 1 ? 'person' : 'people'}
                </span>
              </span>
              <span className={styles.slot}>{workspace.id === active.id && <Check />}</span>
            </button>
          ))}

          {error && <p className={styles.error} role="alert">{error}</p>}

          <div className={styles.footer}>
            {/* Creating and leaving both live on the settings page, which has
                room to explain them. This is the switcher, not the manager. */}
            <Link className={styles.manage} to={`/w/${active.slug}/people`} onClick={() => setOpen(false)}>
              People
            </Link>
            <Link className={styles.manage} to={`/w/${active.slug}/settings`} onClick={() => setOpen(false)}>
              Workspace settings <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
