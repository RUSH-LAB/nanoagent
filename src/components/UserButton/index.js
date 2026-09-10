import React, { useEffect, useState } from 'react';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import styles from './styles.module.css';

/**
 * The navbar's account button: who you are, and a way to your settings.
 *
 * Registered as the custom navbar item type `custom-userButton` in
 * theme/NavbarItem/ComponentTypes.js, and placed after the search bar in
 * docusaurus.config.js.
 *
 * The session is fetched after mount rather than during render. The navbar is
 * part of every statically built page, so there is no session at build time and
 * the markup has to be identical on the server and on the first client render
 * or React reports a hydration mismatch. The button therefore ships as a
 * neutral placeholder and fills itself in a moment later.
 */

/** The letter shown in the circle: the first of the username, or a fallback. */
function initialOf(user) {
  const source = user?.username || user?.name || user?.email || '';
  return source.trim().charAt(0).toUpperCase() || '·';
}

function labelOf(user) {
  return user?.username || user?.name || user?.email || 'Account';
}

function workspaceSlugFromPath(pathname) {
  const match = /^\/w\/([^/]+)(?:\/|$)/.exec(String(pathname ?? ''));
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

export default function UserButton({ mobile = false }) {
  const { siteConfig } = useDocusaurusContext();
  const authEnabled = siteConfig.customFields?.authEnabled;
  const [user, setUser] = useState(null);
  const workspaceSlug = workspaceSlugFromPath(useLocation().pathname);
  const settingsPath = workspaceSlug && !workspaceSlug.startsWith(':')
    ? `/w/${encodeURIComponent(workspaceSlug)}/settings`
    : '/settings';

  useEffect(() => {
    if (!authEnabled) return undefined;
    let cancelled = false;
    fetch('/api/auth/get-session', {credentials: 'include'})
      .then((response) => response.ok ? response.json() : null)
      .then((result) => { if (!cancelled) setUser(result?.user ?? null); })
      .catch(() => { /* signed out or API down; the button still links to settings */ });
    return () => { cancelled = true; };
  }, [authEnabled]);

  const label = labelOf(user);

  // In the mobile sidebar the navbar collapses to a list of text links, where a
  // bare circle would read as a bullet with no meaning.
  if (mobile) {
    return (
      <Link className="menu__link" to={settingsPath}>
        {user ? `Signed in as ${label}` : 'Account'}
      </Link>
    );
  }

  return (
    <Link
      className={styles.button}
      to={settingsPath}
      title={user ? `Signed in as ${label}` : 'Account and settings'}
      aria-label={user ? `Account: ${label}` : 'Account'}
    >
      <span className={styles.avatar} aria-hidden="true">{initialOf(user)}</span>
    </Link>
  );
}
