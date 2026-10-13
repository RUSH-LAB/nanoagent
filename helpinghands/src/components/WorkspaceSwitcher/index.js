import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import NavbarLogo from '@theme/Navbar/Logo';
import { useLocation } from '@docusaurus/router';
import { useClickOutside } from '@site/src/hooks/useClickOutside';
import { switchWorkspace, workspaceSlugFromPath } from '@site/src/utils/workspaces';
import { useAccount } from '@site/src/utils/account';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
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
 * Falls back to the ordinary brand (the site's name) when there is no
 * workspace to name: signed out, or a URL naming a workspace you are not in.
 * The workspaces are the auth gate's answer (utils/account.js), known before
 * the navbar is drawn.
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
  const location = useLocation();
  const workspaceSite = useWorkspaceSite();

  const { workspaces, defaultWorkspaceId: activeId } = useAccount();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const wrapper = useRef(null);

  useClickOutside(wrapper, () => setOpen(false), open);

  // Escape closes it, because a menu you can open with the keyboard and only
  // close with the mouse is a trap.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const routeSlug = workspaceSlugFromPath(location.pathname);
  // A workspace URL is authoritative. Never replace an unknown or still
  // loading URL workspace with the session's default workspace: doing so
  // briefly displays one organization's identity inside another tab.
  const active = routeSlug
    ? workspaces.find((workspace) => workspace.slug === routeSlug)
    : workspaces.find((workspace) => workspace.id === activeId);

  // Nothing to name yet, or nothing to name at all. The stock logo, untouched.
  if (!active) return <NavbarLogo />;

  const displayName = workspaceSite.slug === routeSlug
    ? workspaceSite.site?.site?.title || active.name
    : active.name;
  const homeHref = `/w/${encodeURIComponent(active.slug)}`;

  async function choose(workspace) {
    if (workspace.slug === active?.slug) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await switchWorkspace(workspace);
      // This component survives client-side navigation. Close the old menu and
      // release its interaction lock immediately so the newly rendered
      // workspace can be switched again without waiting for page data or the
      // global CLI to finish loading.
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={clsx('navbar__brand', 'navbar__item', styles.wrapper)} ref={wrapper}>
      <Link
        className={styles.homeLink}
        to={homeHref}
        onClick={() => setOpen(false)}
        title={`${displayName} home`}
        aria-label={`Open ${displayName} home`}
      >
        <span className={styles.identity}>
          <b className={clsx('navbar__title', 'text--truncate', styles.name)}>{displayName}</b>
        </span>
      </Link>
      <button
        type="button"
        className={styles.menuTrigger}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Switch workspace"
        aria-label={`Switch workspace. Current workspace: ${displayName}`}
      >
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
              <span className={styles.optionName}>{workspace.name}</span>
              <span className={styles.slot}>{workspace.id === active.id && <Check />}</span>
            </button>
          ))}

          {error && <p className={styles.error} role="alert">{error}</p>}

          <Link
            to="/new-workspace"
            role="menuitem"
            className={clsx(styles.option, styles.create)}
            onClick={() => setOpen(false)}
          >
            <span className={styles.createMark} aria-hidden="true">
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </span>
            <span className={styles.optionName}>New Workspace</span>
          </Link>
        </div>
      )}
    </div>
  );
}
