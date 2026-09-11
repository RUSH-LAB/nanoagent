import React, { useState } from 'react';
import { idFromLink } from '@site/src/utils/invite';
import { createWorkspace } from '@site/src/utils/workspaces';
import {clientPlatform} from '@site/src/platform/client';
import styles from './authScreen.module.css';

/**
 * What a signed-in account with no workspace sees.
 *
 * Everything in the product that is not a published page belongs to an
 * organization: channels, direct messages, the people directory, invitations.
 * An account in none of them could sign in perfectly well and then find that
 * every one of those answered 409, which reads as a broken site rather than an
 * empty one. So the gate stops here instead, and the two ways out are the two
 * things on this screen.
 *
 * Rendered in the same place, and from the same stylesheet, as AuthScreen: it is
 * the second half of one arrival, and a different-looking page between signing
 * up and using the site would read as having landed somewhere else.
 *
 * The short name is a placeholder rather than a filled-in value on purpose. An
 * untouched field sends nothing, and the server derives the slug from the
 * workspace name and numbers it if that is taken. Typing one makes it a choice,
 * and a choice that is taken is refused rather than quietly altered.
 */

/** The server's slugify, for the placeholder only. The server decides. */
function previewSlug(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export default function OnboardingScreen({ user, onSignOut }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function create(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Reloads on success, from within src/utils/workspaces: the session's
      // active workspace has just changed and every page's data depends on it.
      await createWorkspace({ name, slug: slug.trim() });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  function openInvitation(event) {
    event.preventDefault();
    const id = idFromLink(invite);
    if (!id) {
      setError('That does not look like an invitation link.');
      return;
    }
    // The /join page does the accepting. It reads the invitation, says which
    // workspace and which address it is for, and is exempt from this gate.
    clientPlatform.location.assign(`/join?i=${encodeURIComponent(id)}`);
  }

  const label = user?.username || user?.name || user?.email || 'you';

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <img src="/img/mochi.jpg" alt="" className={styles.logo} />
        <h1 className={styles.title}>Create a workspace</h1>
        <p className={styles.tagline}>
          Signed in as {label}. A workspace is where your channels, people, and
          invitations live.
        </p>

        <form className={styles.stack} onSubmit={create}>
          <label className={styles.field}>
            <span>Workspace name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Research Group"
              minLength={2}
              maxLength={60}
              autoFocus
              required
            />
          </label>

          <label className={styles.field}>
            <span>Short name <em>(optional)</em></span>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder={previewSlug(name) || 'acme-research-group'}
              maxLength={40}
              autoComplete="off"
            />
          </label>

          <p className={styles.hint}>
            Lowercase letters, digits, and dashes. Left empty, it follows the name.
          </p>

          {error && <p className={styles.error} role="alert">{error}</p>}

          <button type="submit" className={styles.submit} disabled={busy || name.trim().length < 2}>
            {busy ? 'Creating...' : 'Create workspace'}
          </button>
        </form>

        <div className={styles.divider}><span>or</span></div>

        <form className={styles.stack} onSubmit={openInvitation}>
          <label className={styles.field}>
            <span>Join with an invitation</span>
            <input
              type="text"
              value={invite}
              onChange={(e) => { setInvite(e.target.value); setError(null); }}
              placeholder="Paste the link you were sent"
              autoComplete="off"
            />
          </label>
          <button type="submit" className={styles.rootButton} disabled={!invite.trim()}>
            Open invitation
          </button>
        </form>

        <button type="button" className={styles.switch} onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
