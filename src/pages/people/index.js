import React, {useCallback, useEffect, useMemo, useState} from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {useLocation} from '@docusaurus/router';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import {loadWorkspaces, workspaceSlugFromPath} from '@site/src/utils/workspaces';
import {openConversation} from '@site/src/components/CommandBar/openConversation';
import pageStyles from '@site/src/css/page.module.css';
import dir from '@site/src/css/directory.module.css';
import RowMenu from '@site/src/components/RowMenu';
import AddPeople, {CopyLink} from './AddPeople';
import styles from './styles.module.css';

/**
 * Everyone in the organization: the directory, and the administration of it.
 *
 * One page rather than two, because they are one question asked at different
 * volumes. Everybody may see who is here, which is what makes a workspace feel
 * inhabited; owners and admins additionally see a role control and a way to
 * remove someone, and a record of every such change already made.
 *
 * The controls are hidden from people who cannot use them, which is courtesy
 * and not security: the server decides, and it decides again for every request
 * whatever this page chose to render.
 */

const ROLES = ['owner', 'editor', 'viewer'];

const ROLE_NOTE = {
  owner: 'Everything, including making other owners.',
  editor: 'Create, edit, and publish workspace content.',
  viewer: 'Read content and participate in comments.',
};

/** The letter in the circle, and a stable colour for it. */
function initialOf(person) {
  return (person.username || person.name || person.email || '?').trim().charAt(0).toUpperCase();
}

/**
 * A hue derived from the account id, so the same person is the same colour on
 * every visit and in every browser without storing a preference for it.
 */
function hueOf(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return hash;
}

function Avatar({person}) {
  return (
    <span
      className={styles.avatar}
      style={{'--avatar-hue': hueOf(person.id)}}
      aria-hidden="true"
    >
      {initialOf(person)}
    </span>
  );
}

/** A date a person reads, without a time nobody asked about. */
function dayOf(value) {
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? '—'
    : at.toLocaleDateString([], {year: 'numeric', month: 'short', day: 'numeric'});
}

/**
 * A date with the time on it, for the audit. Several changes can land in one
 * afternoon, and "which came first" is most of what the log is read for.
 */
function momentOf(value) {
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? '—'
    : at.toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false});
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

/**
 * One audit event as a sentence. Every change to the organization is in this
 * log, channels included, because "what happened to #launch" and "who made ada
 * an admin" are the same question asked about different things.
 */
function sentenceFor(event) {
  const {actorLabel: who, targetLabel: what, detail} = event;
  switch (event.action) {
    case 'member.role': return `${who} changed ${what} from ${detail?.from} to ${detail?.to}`;
    case 'member.remove': return `${who} removed ${what}`;
    case 'member.add': return `${who} added ${what}`;
    case 'member.invite': return `${who} invited ${what} as ${detail?.role}`;
    case 'member.invite-cancel': return `${who} withdrew the invitation to ${what}`;
    case 'member.join': return `${what} accepted ${detail?.invitedBy}'s invitation`;
    case 'member.create': return `${who} created the account ${what}`;
    case 'channel.rename': return `${who} renamed #${detail?.from} to ${what}`;
    case 'channel.archive': return `${who} archived ${what}`;
    case 'channel.unarchive': return `${who} brought ${what} back`;
    case 'channel.delete': {
      const n = detail?.messages ?? 0;
      return `${who} deleted ${what} and its ${n} ${n === 1 ? 'message' : 'messages'}`;
    }
    default: return `${who}: ${event.action} ${what}`;
  }
}

function People() {
  const location = useLocation();
  const workspaceSlug = workspaceSlugFromPath(location.pathname);
  const [workspaceId, setWorkspaceId] = useState(null);
  const [organization, setOrganization] = useState(null);
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [you, setYou] = useState(null);
  const [audit, setAudit] = useState([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState(null);
  const [busyId, setBusyId] = useState(null);
  // Which way of adding somebody is open: 'invite', 'create', or none.
  const [adding, setAdding] = useState(null);

  const load = useCallback(async () => {
    try {
      const {workspaces} = await loadWorkspaces();
      const selected = workspaces.find(workspace => workspace.slug === workspaceSlug);
      if (!selected) {
        const error = new Error('This workspace does not exist, or you are not a member.');
        error.status = 404;
        throw error;
      }
      const root = `/api/workspaces/${encodeURIComponent(selected.id)}`;
      const [org, roster] = await Promise.all([call(root), call(`${root}/members`)]);
      setWorkspaceId(selected.id);
      setOrganization(org.organization);
      setMembers(roster.members);
      setYou(roster.you);
      setStatus('ready');
      // Only a manager may read these, so asking as anyone else would be two
      // guaranteed refusals per visit.
      if (roster.you.canManage) {
        const [{events}, {invitations: pending}] = await Promise.all([
          call(`${root}/audit?limit=10`),
          call(`${root}/invitations`),
        ]);
        setAudit(events);
        setInvitations(pending);
      }
    } catch (err) {
      setStatus('blocked');
      setMessage({kind: 'error', text: BLOCKED[err.status] || err.message});
    }
  }, [workspaceSlug]);

  const workspaceCall = useCallback((suffix, init) => {
    if (!workspaceId) throw new Error('Workspace is still loading');
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
    const sure = window.confirm(
      `Remove ${person.username} from ${organization?.name}?\n\n` +
      'They lose access to every channel here. What they have already said stays.',
    );
    if (!sure) return;
    act(
      person,
      () => workspaceCall(`/members/${person.memberId}`, {method: 'DELETE'}),
      `${person.username} is no longer in ${organization?.name}.`,
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
      setMessage({kind: 'ok', text: `The invitation to ${invitation.email} is withdrawn.`});
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

  if (status === 'loading') return <div className={pageStyles.pageContainer}><p>Loading…</p></div>;

  if (status === 'blocked') {
    return (
      <div className={pageStyles.pageContainer}>
        <h1 className={dir.title}>People</h1>
        <p className={dir.note}>{message?.text}</p>
      </div>
    );
  }

  const canManage = Boolean(you?.canManage);
  const ownerCount = members.filter(person => person.role === 'owner').length;
  const editorCount = members.filter(person => person.role === 'editor').length;
  return (
    <div className={`${pageStyles.pageContainer} ${pageStyles.wide}`}>
      <header className={dir.head}>
        <div>
          <span className={styles.eyebrow}>{organization?.name ?? 'Workspace'}</span>
          <h1 className={dir.title}>People &amp; access</h1>
          <p className={dir.note}>
            Manage membership and permissions for this workspace.
            {!canManage && ` Your role is ${you?.role ?? 'viewer'}.`}
          </p>
        </div>
        <span className={styles.headTools}>
          <input
            className={dir.search}
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Find someone"
            aria-label="Find someone"
          />
          {canManage && (
            <button
              type="button"
              className={dir.cta}
              onClick={() => { setAdding(v => !v); setMessage(null); }}
              aria-expanded={adding}
            >
              Add people
            </button>
          )}
        </span>
      </header>

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

      <section className={styles.overview} aria-label="Workspace membership summary">
        <div className={styles.metric}>
          <span className={styles.metricValue}>{members.length}</span>
          <span className={styles.metricLabel}>Members</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{ownerCount}</span>
          <span className={styles.metricLabel}>{ownerCount === 1 ? 'Owner' : 'Owners'}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{editorCount}</span>
          <span className={styles.metricLabel}>{editorCount === 1 ? 'Editor' : 'Editors'}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{invitations.length}</span>
          <span className={styles.metricLabel}>Pending invites</span>
        </div>
      </section>

      <section className={styles.directorySection}>
        <div className={styles.sectionHeading}>
          <div>
            <h2 className={dir.subtitle}>Members</h2>
            <p className={dir.note}>{shown.length} shown</p>
          </div>
          <div className={styles.roleKey} aria-label="Workspace roles">
            {ROLES.map(role => (
              <span key={role} title={ROLE_NOTE[role]}>
                <i className={`${styles.roleDot} ${styles[`dot_${role}`]}`} />{role}
              </span>
            ))}
          </div>
        </div>
      <ul className={`${dir.list} ${styles.memberList}`}>
        {shown.map((person) => (
          <li key={person.memberId} className={dir.row}>
            <Avatar person={person} />
            <span className={dir.identity}>
              <span className={dir.name}>
                {person.username}
                {person.you && <span className={dir.tag}>you</span>}
              </span>
              <span className={dir.detail}>
                {person.name && person.name !== person.username ? `${person.name} · ` : ''}
                {person.email}
              </span>
            </span>

            <span className={`${styles.role} ${styles[`role_${person.role}`] ?? ''}`} title={ROLE_NOTE[person.role]}>
              {person.role}
            </span>
            <span className={dir.meta}>joined {dayOf(person.joinedAt)}</span>

            {/* What a row is usually clicked for stays on it; what it is
                clicked for once is behind the menu. Neither appears on your own
                row: demoting or removing yourself is leaving, which has its own
                questions rather than a dropdown next to everyone else's. */}
            <span className={dir.actions}>
              {!person.you && (
                <button
                  type="button"
                  className={`${dir.action} ${dir.primary}`}
                  onClick={() => message_(person)}
                >
                  Message
                </button>
              )}
              {canManage && !person.you && (
                <>
                  <select
                    className={dir.select}
                    value={person.role}
                    disabled={busyId === person.memberId}
                    onChange={e => changeRole(person, e.target.value)}
                    aria-label={`Role for ${person.username}`}
                  >
                    {ROLES.map(role => <option key={role} value={role}>{role}</option>)}
                  </select>
                  <RowMenu
                    label={`More for ${person.username}`}
                    items={[{
                      label: 'Remove from the workspace',
                      danger: true,
                      disabled: busyId === person.memberId,
                      onSelect: () => remove(person),
                    }]}
                  />
                </>
              )}
            </span>
          </li>
        ))}
        {shown.length === 0 && <li className={dir.note}>Nobody matches “{query}”.</li>}
      </ul>
      </section>

      {invitations.length > 0 && (
        <section className={styles.invitations}>
          <h2 className={dir.subtitle}>Invited, not here yet</h2>
          <ul className={`${dir.list} ${styles.memberList}`}>
            {invitations.map(invitation => (
              <li key={invitation.id} className={dir.row}>
                <span className={styles.avatar} style={{'--avatar-hue': hueOf(invitation.email)}} aria-hidden="true">
                  {invitation.email.charAt(0).toUpperCase()}
                </span>
                <span className={dir.identity}>
                  <span className={dir.name}>
                    {invitation.email}
                    {invitation.expired && <span className={dir.tag}>expired</span>}
                  </span>
                  <span className={dir.detail}>
                    invited by {invitation.invitedBy} as {invitation.role}
                  </span>
                </span>
                {/* The tag already says expired; this says when. */}
                <span className={dir.meta}>{dayOf(invitation.expiresAt)}</span>
                <span className={dir.actions}>
                  {!invitation.expired && <CopyLink invitationId={invitation.id} onResult={setMessage} />}
                  <RowMenu
                    label={`More for ${invitation.email}`}
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

      {canManage && (
        <section className={styles.audit}>
          <h2 className={dir.subtitle}>Recent changes</h2>
          {audit.length === 0 && <p className={dir.note}>Nothing has changed yet.</p>}
          <ul className={styles.auditList}>
            {audit.map(event => (
              <li key={event.id} className={styles.auditRow}>
                <span className={styles.auditWhen}>{momentOf(event.at)}</span>
                <span>{sentenceFor(event)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default function PeoplePage() {
  return (
    <Layout title="People" description="Everyone in your organization" noFooter>
      <BrowserOnly fallback={<div className={pageStyles.pageContainer}><p>Loading…</p></div>}>
        {() => <People />}
      </BrowserOnly>
    </Layout>
  );
}
