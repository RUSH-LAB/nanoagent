import React, {useState} from 'react';
import {linkFor, copyLink, inviteeLabel, inviteeOf} from '@site/src/utils/invite';
import dir from '@site/src/css/directory.module.css';
import RolePicker from './_RolePicker';
import card from './styles.module.css';
import styles from './people.module.css';

export function CopyLink({invitationId, onResult}) {
  return (
    <button
      type="button"
      className={dir.action}
      onClick={async () => {
        const {copied, link} = await copyLink(invitationId);
        onResult({kind: 'ok', text: copied ? 'Invitation link copied.' : link});
      }}
    >
      Copy link
    </button>
  );
}

export default function AddPeople({call, onResult, onChanged, onClose}) {
  const [invitee, setInvitee] = useState('');
  const [role, setRole] = useState('viewer');
  const [busy, setBusy] = useState(false);
  const [invited, setInvited] = useState(null);

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    try {
      const {invitation} = await call('/invitations', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({...inviteeOf(invitee), role}),
      });
      setInvited(invitation);
      setInvitee('');
      onResult({kind: 'ok', text: `${inviteeLabel(invitation)} is invited. Send them the link.`});
      await onChanged();
    } catch (err) {
      onResult({kind: 'error', text: err.message});
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={card.group}>
      <div className={card.groupHead}>
        <h4 className={card.groupTitle}>Invite by email or GitHub</h4>
        <button type="button" className={styles.panelClose} onClick={onClose} aria-label="Close">&times;</button>
      </div>
      <form className={styles.panelForm} onSubmit={submit}>
        <input
          className={styles.panelInput}
          type="text"
          value={invitee}
          onChange={event => setInvitee(event.target.value)}
          placeholder="them@example.com or their GitHub username"
          aria-label="Email address or GitHub username to invite"
          required
          autoFocus
        />
        <RolePicker className={styles.fieldTrigger} value={role} onChange={setRole} label="Role" />
        <button type="submit" className={card.primaryButton} disabled={busy || !invitee.trim()}>
          {busy ? 'Inviting…' : 'Send invite'}
        </button>
      </form>
      <p className={styles.panelHint}>
        They accept by signing in with that GitHub account, or with a GitHub account whose primary email is that address.
      </p>
      {invited && (
        <div className={styles.linkRow}>
          <code className={styles.link}>{linkFor(invited.id)}</code>
          <CopyLink invitationId={invited.id} onResult={onResult} />
        </div>
      )}
    </section>
  );
}
