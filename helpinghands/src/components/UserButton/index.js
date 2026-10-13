import React, { useEffect, useRef, useState } from 'react';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import Avatar from '@site/src/components/Avatar';
import {signOutAndForget} from '@site/src/utils/authClient';
import {useAccount} from '@site/src/utils/account';
import {clientPlatform} from '@site/src/platform/client';
import styles from './styles.module.css';

/**
 * The navbar's account menu: who you are, account settings, and sign-out.
 *
 * Registered as the custom navbar item type `custom-userButton` in
 * theme/NavbarItem/ComponentTypes.js, and placed after the search bar in
 * docusaurus.config.js.
 *
 * Who you are is the auth gate's answer (utils/account.js), which is known
 * before any page, this navbar included, is drawn.
 */

function labelOf(user) {
  return user?.username || user?.name || user?.email || 'Account';
}

function workspaceSlugFromPath(pathname) {
  const match = /^\/w\/([^/]+)(?:\/|$)/.exec(String(pathname ?? ''));
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

export default function UserButton({ mobile = false }) {
  const {account: user} = useAccount();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef(null);
  const workspaceSlug = workspaceSlugFromPath(useLocation().pathname);
  const settingsPath = workspaceSlug && !workspaceSlug.startsWith(':')
    ? `/w/${encodeURIComponent(workspaceSlug)}/settings`
    : '/settings';

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = event => {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = event => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOutAndForget();
    } finally {
      clientPlatform.location.assign('/');
    }
  };

  const label = labelOf(user);

  // In the mobile sidebar the navbar collapses to a list of text links, where a
  // bare circle would read as a bullet with no meaning.
  if (mobile) {
    return (
      <div className={styles.mobileAccount}>
        <Link className="menu__link" to={settingsPath}>
          {user ? `Signed in as ${label}` : 'Account'}
        </Link>
        {user ? (
          <button type="button" className={`menu__link ${styles.mobileSignOut}`} disabled={signingOut} onClick={signOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        ) : null}
      </div>
    );
  }

  if (!user) {
    return (
      <Link className={styles.button} to={settingsPath} title="Account and settings" aria-label="Account">
        <span className={styles.signedOut} aria-hidden="true" />
      </Link>
    );
  }

  return (
    <div className={styles.accountMenu} ref={menuRef}>
      <button
        type="button"
        className={styles.button}
        title={`Signed in as ${label}`}
        aria-label={`Account: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <Avatar user={user} />
      </button>
      {open ? (
        <div className={styles.menu} role="menu">
          <div className={styles.identity}>
            <strong>{label}</strong>
            {user.email && user.email !== label ? <small>{user.email}</small> : null}
          </div>
          <Link role="menuitem" to={settingsPath} onClick={() => setOpen(false)}>Settings</Link>
          <button type="button" role="menuitem" disabled={signingOut} onClick={signOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
