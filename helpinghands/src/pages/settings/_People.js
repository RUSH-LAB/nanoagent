import React, {useCallback, useEffect, useMemo, useState} from 'react';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import {openConversation} from '@site/src/components/CommandBar/openConversation';
import {clientPlatform} from '@site/src/platform/client';
import dir from '@site/src/css/directory.module.css';
import Avatar from '@site/src/components/Avatar';
import RowMenu from '@site/src/components/RowMenu';
import {PaneHeading, Skeleton} from './_parts';
import AddPeople, {CopyLink} from './_AddPeople';
import {inviteeLabel} from '@site/src/utils/invite';
import RolePicker, {ROLE_NOTE, roleClass} from './_RolePicker';
import card from './styles.module.css';
import styles from './people.module.css';

/**
 * Everyone in the workspace: the directory, and the administration of it, as
 * the People pane of the workspace's settings.
 *
 * One pane rather than two, because they are one question asked at different
 * volumes. Everybody may see who is here, which is what makes a workspace feel
 * inhabited; owners and admins additionally see a role control and a way to
 * remove someone.
 *
 * The controls are hidden from people who cannot use them, which is courtesy
 * and not security: the server decides, and it decides again for every request
 * whatever this page chose to render.
 */

/** A date a person reads, without a time nobody asked about. */
function dayOf(value) {
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? '—'
    : at.toLocaleDateString([], {year: 'numeric', month: 'short', day: 'numeric'});
}

async function call(path, init) {
  const res = await apiFetch(`${API_BASE}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code ?? null;
    throw err;
  }
  return data;
}

/** Why the page has nothing to show, in the words it will say. */
const BLOCKED = {
  401: 'Sign in to see who is here.',
  404: 'This workspace does not exist, or you are not a member.',
  409: 'You are not in an organization yet.',
};

export default function People({workspace}) {
  const workspaceId = workspace.id;
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [you, setYou] = useState(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState(null);
  const [busyId, setBusyId] = useState(null);
  // Which way of adding somebody is open: 'invite', 'create', or none.
  const [adding, setAdding] = useState(null);

  const load = useCallback(async () => {
    try {
      const root = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
      const roster = await call(`${root}/members`);
      setMembers(roster.members);
      setYou(roster.you);
      setStatus('ready');
      // Only a manager may read these, so asking as anyone else would be a
      // guaranteed refusal per visit.
      if (roster.you.canManage) {
        const {invitations: pending} = await call(`${root}/invitations`);
        setInvitations(pending);
      }
    } catch (err) {
      setStatus('blocked');
      setMessage({kind: 'error', text: BLOCKED[err.status] || err.message});
    }
  }, [workspaceId]);

  const workspaceCall = useCallback((suffix, init) => {
    return call(`/api/workspaces/${encodeURIComponent(workspaceId)}${suffix}`, init);
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (person, run, describe) => {
    setBusyId(person.memberId);
    setMessage(null);
    try {
      await run();
      setMessage({kind: 'ok', text: describe});
      await load();
    } catch (err) {
      setMessage({kind: 'error', text: err.message});
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const changeRole = (person, role) => act(
    person,
    () => workspaceCall(`/members/${person.memberId}/role`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({role}),
    }),
    `${person.username} is now ${role === 'editor' ? 'an' : 'a'} ${role}.`,
  );

  const remove = (person) => {
    // Removal is not undoable from this page: readmitting someone is an invite,
    // and their channel membership does not come back with them.
    const sure = clientPlatform.dialogs.confirm(
      `Remove ${person.username} from ${workspace.name}?\n\n` +
      'They lose access to every channel here. What they have already said stays.',
    );
    if (!sure) return;
    act(
      person,
      () => workspaceCall(`/members/${person.memberId}`, {method: 'DELETE'}),
      `${person.username} is no longer in ${workspace.name}.`,
    );
  };

  const message_ = (person) => {
    const opened = openConversation({
      channelId: person.dmChannelId ?? undefined,
      userId: person.id,
      label: `@${person.username}`,
    });
    if (!opened) setMessage({kind: 'error', text: 'The command bar is not open on this page.'});
  };

  const withdraw = async (invitation) => {
    setMessage(null);
    try {
      await workspaceCall(`/invitations/${invitation.id}`, {method: 'DELETE'});
      setMessage({kind: 'ok', text: `The invitation to ${inviteeLabel(invitation)} is withdrawn.`});
      await load();
    } catch (err) {
      setMessage({kind: 'error', text: err.message});
    }
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter(m => `${m.username} ${m.name ?? ''} ${m.email ?? ''}`.toLowerCase().includes(q));
  }, [members, query]);

  if (status === 'loading') return <><PaneHeading title="People" /><Skeleton rows={3} /></>;

  if (status === 'blocked') {
    return <><PaneHeading title="People" /><p className={dir.note}>{message?.text}</p></>;
  }

  const canManage = Boolean(you?.canManage);
  return (
    <>
      <PaneHeading
        title="People"
        aside={canManage && (
          <button
            type="button"
            className={card.primaryButton}
            onClick={() => { setAdding(v => !v); setMessage(null); }}
            aria-expanded={Boolean(adding)}
          >
            Add people
          </button>
        )}
      />

      {adding && canManage && (
        <AddPeople
          call={workspaceCall}
          onResult={setMessage}
          onChanged={load}
          onClose={() => setAdding(false)}
        />
      )}

      {message && (
        <p className={message.kind === 'error' ? dir.error : dir.ok} role="status">{message.text}</p>
      )}

      <section className={card.group}>
        <div className={card.groupHead}>
          <h4 className={card.groupTitle}>Members</h4>
          <input
            className={dir.search}
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Find someone"
            aria-label="Find someone"
          />
        </div>
        <div className={`${styles.grid} ${styles.columns}`} aria-hidden="true">
          <span>Name</span><span>Role</span><span>Joined</span><span />
        </div>
        <ul className={styles.rows}>
          {shown.map((person) => (
            <li key={person.memberId} className={`${styles.grid} ${styles.row}`}>
              <span className={styles.person}>
                <Avatar user={person} size={32} />
                <span className={dir.identity}>
                  <span className={dir.name}>
                    {person.username}
                    {person.you && <span className={dir.tag}>you</span>}
                  </span>
                  {person.email && person.email !== person.username && (
                    <span className={dir.detail}>{person.email}</span>
                  )}
                </span>
              </span>

              {/* One control for the role, not a badge beside a menu that says
                  the same thing. Your own role is not yours to change here:
                  demoting yourself is leaving, which needs its own flow. */}
              <span>
                {canManage && !person.you ? (
                  <RolePicker
                    className={`${roleClass(person.role)} ${styles.roleTrigger}`}
                    value={person.role}
                    disabled={busyId === person.memberId}
                    onChange={role => changeRole(person, role)}
                    label={`Role for ${person.username}`}
                  />
                ) : (
                  <span className={roleClass(person.role)} title={ROLE_NOTE[person.role]}>
                    {person.role}
                  </span>
                )}
              </span>

              <span className={styles.when}>{dayOf(person.joinedAt)}</span>

              {/* Messaging stays on every row, including your own: a self-chat
                  is useful as a private notes thread. */}
              <span className={styles.rowActions}>
                <button type="button" className={`${dir.action} ${dir.primary}`} onClick={() => message_(person)}>
                  Message
                </button>
                {canManage && !person.you ? (
                  <RowMenu
                    label={`More for ${person.username}`}
                    items={[{
                      label: 'Remove from the workspace',
                      danger: true,
                      disabled: busyId === person.memberId,
                      onSelect: () => remove(person),
                    }]}
                  />
                ) : canManage && <span className={styles.menuSlot} />}
              </span>
            </li>
          ))}
          {shown.length === 0 && <li className={styles.empty}>Nobody matches “{query}”.</li>}
        </ul>
      </section>

      {invitations.length > 0 && (
        <section className={card.group}>
          <div className={card.groupHead}>
            <h4 className={card.groupTitle}>Invitations</h4>
          </div>
          <ul className={styles.rows}>
            {invitations.map(invitation => (
              <li key={invitation.id} className={`${styles.grid} ${styles.row}`}>
                <span className={styles.person}>
                  <Avatar
                    user={invitation.githubLogin
                      ? {name: invitation.githubLogin, image: `https://github.com/${encodeURIComponent(invitation.githubLogin)}.png?size=64`}
                      : {email: invitation.email}}
                    size={32}
                  />
                  <span className={dir.identity}>
                    <span className={dir.name}>{inviteeLabel(invitation)}</span>
                    <span className={dir.detail}>invited by {invitation.invitedBy}</span>
                  </span>
                </span>
                <span>
                  <span className={roleClass(invitation.role)}>{invitation.role}</span>
                </span>
                <span className={invitation.expired ? styles.expired : styles.when}>
                  {invitation.expired ? 'Expired' : `Expires ${dayOf(invitation.expiresAt)}`}
                </span>
                <span className={styles.rowActions}>
                  {!invitation.expired && <CopyLink invitationId={invitation.id} onResult={setMessage} />}
                  <RowMenu
                    label={`More for ${inviteeLabel(invitation)}`}
                    items={[{
                      label: 'Withdraw the invitation',
                      danger: true,
                      onSelect: () => withdraw(invitation),
                    }]}
                  />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
