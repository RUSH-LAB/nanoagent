import React, {useState} from 'react';
import {linkFor, copyLink} from '@site/src/utils/invite';
import dir from '@site/src/css/directory.module.css';
import styles from './styles.module.css';

/**
 * The two ways somebody gets into the organization.
 *
 * **Invite** is the real one: an offer to an email address, which becomes a
 * link because there is no mail server here to carry it. The link is not a key
 * to the workspace; accepting it needs an account with the invited address, so
 * a link that goes astray is an offer to somebody who cannot take it.
 *
 * **Create an account** is the local one. Whoever does it chooses the password,
 * so they can sign in as the account afterwards, which is why the server allows
 * only owners and why this says so plainly. On a laptop the reason to add
 * somebody is usually to have a second person to test with, and the alternative
 * to this is a script.
 */

const ROLES = ['member', 'admin', 'owner'];

/**
 * Copy a link, and say so. A refused clipboard shows the link instead: one
 * nobody can read is worse than an ugly one they can select.
 */
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

export default function AddPeople({call, canCreateAccounts, onResult, onChanged, onClose}) {
  const [mode, setMode] = useState('invite');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [account, setAccount] = useState({username: '', password: '', name: ''});
  const [busy, setBusy] = useState(false);
  // The invitation just made, so its link is to hand without hunting for it in
  // the list below.
  const [invited, setInvited] = useState(null);

  const run = async (work) => {
    setBusy(true);
    try {
      await work();
      await onChanged();
    } catch (err) {
      onResult({kind: 'error', text: err.message});
    } finally {
      setBusy(false);
    }
  };

  const submitInvite = e => {
    e.preventDefault();
    run(async () => {
      const {invitation} = await call('/api/org/invitations', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({email, role}),
      });
      setInvited(invitation);
      setEmail('');
      onResult({kind: 'ok', text: `${invitation.email} is invited. Send them the link.`});
    });
  };

  const submitAccount = e => {
    e.preventDefault();
    run(async () => {
      const {user} = await call('/api/org/members', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({...account, role}),
      });
      setAccount({username: '', password: '', name: ''});
      onResult({kind: 'ok', text: `${user.username} can sign in now, with the password you set.`});
    });
  };

  const roleSelect = (
    <select className={dir.select} value={role} onChange={e => setRole(e.target.value)} aria-label="Role">
      {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
    </select>
  );

  return (
    <section className={styles.panel}>
      <div className={styles.panelTabs}>
        <button
          type="button"
          className={`${styles.tab} ${mode === 'invite' ? styles.tabOn : ''}`}
          onClick={() => setMode('invite')}
        >
          Invite by email
        </button>
        {canCreateAccounts && (
          <button
            type="button"
            className={`${styles.tab} ${mode === 'create' ? styles.tabOn : ''}`}
            onClick={() => setMode('create')}
          >
            Create an account
          </button>
        )}
        <button type="button" className={styles.panelClose} onClick={onClose} aria-label="Close">&times;</button>
      </div>

      {mode === 'invite' ? (
        <>
          <form className={styles.panelForm} onSubmit={submitInvite}>
            <input
              className={styles.panelInput}
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="them@example.com"
              aria-label="Email address to invite"
              required
              autoFocus
            />
            {roleSelect}
            <button type="submit" className={`${dir.action} ${dir.primary}`} disabled={busy || !email.trim()}>Invite</button>
          </form>
          <p className={dir.note}>
            No mail is sent from here, so pass the link on yourself. They will need an
            account with that address to accept it.
          </p>
          {invited && (
            <p className={styles.linkRow}>
              <code className={styles.link}>{linkFor(invited.id)}</code>
              <CopyLink invitationId={invited.id} onResult={onResult} />
            </p>
          )}
        </>
      ) : (
        <>
          <form className={styles.panelForm} onSubmit={submitAccount}>
            <input
              className={styles.panelInput}
              value={account.username}
              onChange={e => setAccount(a => ({...a, username: e.target.value}))}
              placeholder="username"
              aria-label="Username"
              required
              autoFocus
            />
            <input
              className={styles.panelInput}
              type="password"
              value={account.password}
              onChange={e => setAccount(a => ({...a, password: e.target.value}))}
              placeholder="password, 8 or more"
              aria-label="Password"
              required
            />
            <input
              className={styles.panelInput}
              value={account.name}
              onChange={e => setAccount(a => ({...a, name: e.target.value}))}
              placeholder="display name (optional)"
              aria-label="Display name"
            />
            {roleSelect}
            <button type="submit" className={`${dir.action} ${dir.primary}`} disabled={busy}>Create</button>
          </form>
          <p className={dir.note}>
            You are choosing their password, so you will know it. For someone real,
            invite them instead and let them set their own.
          </p>
        </>
      )}
    </section>
  );
}
