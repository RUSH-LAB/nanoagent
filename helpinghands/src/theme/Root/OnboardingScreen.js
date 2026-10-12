import React, { useState } from 'react';
import { idFromLink } from '@site/src/utils/invite';
import {clientPlatform} from '@site/src/platform/client';
import styles from './authScreen.module.css';

/**
 * What a signed-in account with no workspace sees.
 *
 * Everything in the product that is not a published page belongs to a
 * workspace: channels, direct messages, people, invitations. An account in
 * none of them could sign in perfectly well and then find that every one of
 * those answered 409, which reads as a broken site rather than an empty one.
 * So the gate stops here instead, and the way in is an invitation: creating a
 * workspace is not offered yet.
 *
 * Rendered in the same place, and from the same stylesheet, as AuthScreen: it is
 * the second half of one arrival, and a different-looking page between signing
 * up and using the site would read as having landed somewhere else.
 */
export default function OnboardingScreen({ onSignOut }) {
  const [invite, setInvite] = useState('');
  const [error, setError] = useState(null);

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

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <img src="/img/mochi.jpg" alt="" className={styles.logo} />
        <h1 className={styles.title}>Join a workspace</h1>
        <p className={styles.tagline}>
          You are not in a workspace yet. Ask its owner for an invitation link.
        </p>

        <form className={styles.stack} onSubmit={openInvitation}>
          <label className={styles.field}>
            <span>Invitation link</span>
            <input
              type="text"
              value={invite}
              onChange={(e) => { setInvite(e.target.value); setError(null); }}
              placeholder="Paste the link you were sent"
              autoComplete="off"
              autoFocus
            />
          </label>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button type="submit" className={styles.submit} disabled={!invite.trim()}>
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
