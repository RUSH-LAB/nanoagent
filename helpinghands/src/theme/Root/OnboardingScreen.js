import React, { useEffect, useState } from 'react';
import { idFromLink } from '@site/src/utils/invite';
import { apiRequest } from '@site/src/utils/api';
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
 * workspace is not offered yet. The invitations sent to the account's own
 * address are listed to join in one click, for somebody who signed in without
 * following their link; any other link can still be pasted.
 *
 * Rendered in the same place, and from the same stylesheet, as AuthScreen: it is
 * the second half of one arrival, and a different-looking page between signing
 * up and using the site would read as having landed somewhere else.
 */
export default function OnboardingScreen({ onSignOut }) {
  const [invite, setInvite] = useState('');
  const [error, setError] = useState(null);
  // null until asked: the pending invitations sent to this account's address.
  const [invitations, setInvitations] = useState(null);
  const [listError, setListError] = useState(null);
  const [joining, setJoining] = useState(null);

  useEffect(() => {
    apiRequest('/api/users/me/invitations', undefined, {failureLabel: 'Could not load your invitations'})
      .then(data => setInvitations(data.invitations))
      .catch(err => { setInvitations([]); setListError(err.message); });
  }, []);

  async function join(id) {
    setJoining(id);
    setListError(null);
    try {
      await apiRequest(`/api/invite/${encodeURIComponent(id)}/accept`, {method: 'POST'}, {failureLabel: 'Could not join'});
      // The gate reads the workspaces again and lets the account in.
      clientPlatform.location.reload();
    } catch (err) {
      setListError(err.message);
      setJoining(null);
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

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <img src="/img/mochi.jpg" alt="" className={styles.logo} />
        <h1 className={styles.title}>Join a workspace</h1>
        {invitations && (
          <>
            <p className={styles.tagline}>
              {invitations.length
                ? 'You have been invited. Join to get started.'
                : 'You are not in a workspace yet. Ask its owner for an invitation link.'}
            </p>

            {listError && <p className={styles.error} role="alert">{listError}</p>}

            {invitations.length > 0 && (
              <>
                <ul className={styles.invites}>
                  {invitations.map(invitation => (
                    <li key={invitation.id} className={styles.invite}>
                      <span className={styles.inviteText}>
                        <strong>{invitation.organization}</strong>
                        <span>Invited by {invitation.invitedBy} as {invitation.role}</span>
                      </span>
                      <button
                        type="button"
                        className={styles.joinButton}
                        onClick={() => join(invitation.id)}
                        disabled={joining !== null}
                      >
                        {joining === invitation.id ? 'Joining…' : 'Join'}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className={styles.divider}><span>or open another invitation</span></div>
              </>
            )}

            <form className={styles.stack} onSubmit={openInvitation}>
              <label className={styles.field}>
                <span>Invitation link</span>
                <input
                  type="text"
                  value={invite}
                  onChange={(e) => { setInvite(e.target.value); setError(null); }}
                  placeholder="Paste the link you were sent"
                  autoComplete="off"
                  autoFocus={invitations.length === 0}
                />
              </label>
              {error && <p className={styles.error} role="alert">{error}</p>}
              <button type="submit" className={styles.submit} disabled={!invite.trim()}>
                Open invitation
              </button>
            </form>
          </>
        )}

        <button type="button" className={styles.switch} onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
