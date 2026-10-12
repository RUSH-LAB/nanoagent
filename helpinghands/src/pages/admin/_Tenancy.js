import React, {useCallback, useEffect, useState} from 'react';
import Avatar from '@site/src/components/Avatar';
import {apiRequest} from '@site/src/utils/api';
import {clientPlatform} from '@site/src/platform/client';
import styles from './styles.module.css';

// Platform administration of tenants (src/server/routes/admin.js): the sign-up
// policy and default limits, every account, every workspace, and the audit log.

const MB = 1024 * 1024;
const usd = value => `$${Number(value).toFixed(2)}`;
const megabytes = value => `${(Number(value) / MB).toFixed(Number(value) < 10 * MB ? 1 : 0)} MB`;
const when = value => (value ? new Date(value).toLocaleString() : '—');

function put(path, body) {
  return apiRequest(path, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
}

function Notice({status}) {
  if (!status) return null;
  return (
    <div className={`${styles.notice} ${status.type === 'error' ? styles.noticeError : styles.noticeSuccess}`}
      role={status.type === 'error' ? 'alert' : 'status'}>{status.message}</div>
  );
}

/** Run an admin write, report its outcome, and reload the section. */
function useAction(reload) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (write, success) => {
    setBusy(true);
    setStatus(null);
    try {
      await write();
      setStatus({type: 'success', message: success});
      await reload();
    } catch (error) {
      setStatus({type: 'error', message: error.message});
    } finally {
      setBusy(false);
    }
  }, [reload]);
  return {status, busy, run};
}

const SIGNUP_LABELS = {
  invite: 'Invitation only (plus the allowlist)',
  allowlist: 'Allowlist only',
  open: 'Anyone',
};

export function PolicyCard() {
  const [policy, setPolicy] = useState(null);
  const [draft, setDraft] = useState(null);
  const load = useCallback(async () => {
    const data = await apiRequest('/api/admin/policy');
    setPolicy(data.policy);
    setDraft({
      ...data.policy,
      signupAllowlist: data.policy.signupAllowlist.join('\n'),
      workspaceStorageMb: Math.round(data.policy.workspaceStorageBytes / MB),
    });
  }, []);
  const {status, busy, run} = useAction(load);
  useEffect(() => { load().catch(() => setPolicy(false)); }, [load]);

  if (policy === false) return null;
  if (!draft) return <section className={styles.card}><p className={styles.empty}>Loading policy…</p></section>;
  const set = field => event => setDraft({...draft, [field]: event.target.value});

  const save = event => {
    event.preventDefault();
    void run(() => put('/api/admin/policy', {
      signupMode: draft.signupMode,
      signupAllowlist: draft.signupAllowlist.split(/[\s,]+/).filter(Boolean),
      maxWorkspacesPerUser: Number(draft.maxWorkspacesPerUser),
      workspaceStorageBytes: Math.round(Number(draft.workspaceStorageMb) * MB),
      workspaceMaxMembers: Number(draft.workspaceMaxMembers),
      workspaceAiDailyUsd: Number(draft.workspaceAiDailyUsd),
      workspaceAiMonthlyUsd: Number(draft.workspaceAiMonthlyUsd),
      memberAiDailyUsd: Number(draft.memberAiDailyUsd),
    }), 'Policy saved.');
  };

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <div><h2>Sign-up and default limits</h2><p>Who may create an account, and what each workspace gets unless you override it.</p></div>
      </div>
      <Notice status={status} />
      <form className={styles.policyForm} onSubmit={save}>
        <label>
          <span>Who can sign up</span>
          <select value={draft.signupMode} onChange={set('signupMode')}>
            {Object.entries(SIGNUP_LABELS).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
          </select>
        </label>
        <label className={styles.wide}>
          <span>Allowlist: addresses or @domains, one per line</span>
          <textarea rows={3} value={draft.signupAllowlist} onChange={set('signupAllowlist')} placeholder="ada@example.com&#10;@example.org" />
        </label>
        <label><span>Workspaces per account</span><input type="number" min={0} value={draft.maxWorkspacesPerUser} onChange={set('maxWorkspacesPerUser')} /></label>
        <label><span>Members per workspace</span><input type="number" min={1} value={draft.workspaceMaxMembers} onChange={set('workspaceMaxMembers')} /></label>
        <label><span>Storage per workspace (MB)</span><input type="number" min={0} value={draft.workspaceStorageMb} onChange={set('workspaceStorageMb')} /></label>
        <label><span>Assistant per workspace, daily ($)</span><input type="number" min={0} step="0.01" value={draft.workspaceAiDailyUsd} onChange={set('workspaceAiDailyUsd')} /></label>
        <label><span>Assistant per workspace, monthly ($)</span><input type="number" min={0} step="0.01" value={draft.workspaceAiMonthlyUsd} onChange={set('workspaceAiMonthlyUsd')} /></label>
        <label><span>Assistant per member, daily ($)</span><input type="number" min={0} step="0.01" value={draft.memberAiDailyUsd} onChange={set('memberAiDailyUsd')} /></label>
        <div className={styles.wide}>
          <button type="submit" className={styles.refresh} disabled={busy}>{busy ? 'Saving…' : 'Save policy'}</button>
          <span className={styles.permissionNote}> Last changed {when(policy.updatedAt)}.</span>
        </div>
      </form>
    </section>
  );
}

export function AccountsCard({myUserId}) {
  const [users, setUsers] = useState(null);
  const [query, setQuery] = useState('');
  const load = useCallback(async () => setUsers((await apiRequest('/api/admin/users')).users), []);
  const {status, busy, run} = useAction(load);
  useEffect(() => { load().catch(error => setUsers({error: error.message})); }, [load]);

  if (!users) return <section className={styles.card}><p className={styles.empty}>Loading accounts…</p></section>;
  if (users.error) return <section className={styles.card}><div className={`${styles.notice} ${styles.noticeError}`}>{users.error}</div></section>;

  const shown = users.filter(user => `${user.name ?? ''} ${user.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  const label = user => user.name || user.email;
  const setRole = (user, role) => run(() => put(`/api/users/${encodeURIComponent(user.id)}/role`, {role}),
    `${label(user)} is now ${role === 'admin' ? 'an administrator' : 'a user'}.`);
  const suspend = user => {
    const reason = clientPlatform.dialogs.prompt(`Suspend ${label(user)}? They are signed out everywhere. Reason (optional):`, '');
    if (reason === null) return;
    void run(() => apiRequest(`/api/admin/users/${encodeURIComponent(user.id)}/ban`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({reason}),
    }), `${label(user)} is suspended.`);
  };
  const restore = user => run(() => apiRequest(`/api/admin/users/${encodeURIComponent(user.id)}/ban`, {method: 'DELETE'}),
    `${label(user)} can sign in again.`);
  const signOut = user => run(() => apiRequest(`/api/admin/users/${encodeURIComponent(user.id)}/sessions`, {method: 'DELETE'}),
    `${label(user)} is signed out everywhere.`);
  const workspaceLimit = user => {
    const answer = clientPlatform.dialogs.prompt(`How many workspaces may ${label(user)} own? Leave empty for the default.`, user.maxWorkspaces ?? '');
    if (answer === null) return;
    void run(() => put(`/api/admin/users/${encodeURIComponent(user.id)}/workspace-limit`, {maxWorkspaces: answer.trim() === '' ? null : Number(answer)}),
      `Workspace limit for ${label(user)} saved.`);
  };
  const remove = user => {
    if (!clientPlatform.dialogs.confirm(`Delete ${label(user)}? Workspaces only they use are deleted too. This cannot be undone.`)) return;
    void run(() => apiRequest(`/api/admin/users/${encodeURIComponent(user.id)}`, {method: 'DELETE'}), `${label(user)} was deleted.`);
  };

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <div><h2>Accounts</h2><p>Every account, its assistant spend over 30 days, and its access.</p></div>
        <input className={styles.search} type="search" value={query} onChange={event => setQuery(event.target.value)}
          placeholder="Search accounts" aria-label="Search accounts" />
      </div>
      <Notice status={status} />
      <div className={styles.userTable}>
        <div className={`${styles.tenancyHead} ${styles.accountGrid}`}>
          <span>Account</span><span>Status</span><span>Spend (30d)</span><span>Last active</span><span>Actions</span>
        </div>
        {shown.length === 0 ? <p className={styles.empty}>No accounts match.</p> : shown.map(user => (
          <div className={`${styles.tenancyRow} ${styles.accountGrid}`} key={user.id}>
            <span className={styles.userIdentity}>
              <Avatar user={user} size={30} />
              <span>
                <strong>{label(user)}{user.id === myUserId && <small> · You</small>}</strong>
                <small className={styles.email}>{user.email}{user.emailVerified ? '' : ' · unverified'}</small>
              </span>
            </span>
            <span>
              {user.bannedAt
                ? <span className={`${styles.roleBadge} ${styles.role_suspended}`} title={user.banReason || ''}>suspended</span>
                : <span className={`${styles.roleBadge} ${user.admin ? styles.role_admin : ''}`}>{user.admin ? 'admin' : 'user'}</span>}
              {user.maxWorkspaces != null && <small className={styles.email}> · {user.maxWorkspaces} workspaces</small>}
            </span>
            <span>{usd(user.ai30dUsd)}</span>
            <span className={styles.email}>{when(user.lastSeenAt)}</span>
            <span className={styles.actions}>
              {user.id === myUserId ? <span className={styles.locked}>Current account</span> : (
                <>
                  <select className={styles.roleSelect} value={user.admin ? 'admin' : 'user'} disabled={busy}
                    onChange={event => setRole(user, event.target.value)} aria-label={`Platform role for ${label(user)}`}>
                    <option value="user">User</option>
                    <option value="admin">Administrator</option>
                  </select>
                  {user.bannedAt
                    ? <button type="button" className={styles.linkButton} disabled={busy} onClick={() => restore(user)}>Restore</button>
                    : <button type="button" className={styles.linkButton} disabled={busy || user.admin} onClick={() => suspend(user)}>Suspend</button>}
                  <button type="button" className={styles.linkButton} disabled={busy || !user.sessions} onClick={() => signOut(user)}>Sign out</button>
                  <button type="button" className={styles.linkButton} disabled={busy} onClick={() => workspaceLimit(user)}>Limit</button>
                  <button type="button" className={`${styles.linkButton} ${styles.bad}`} disabled={busy || user.admin} onClick={() => remove(user)}>Delete</button>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

const LIMIT_FIELDS = [
  ['maxMembers', 'Members', 1],
  ['storageMb', 'Storage (MB)', 1],
  ['aiDailyUsd', 'Assistant daily ($)', 0.01],
  ['aiMonthlyUsd', 'Assistant monthly ($)', 0.01],
  ['memberAiDailyUsd', 'Per member daily ($)', 0.01],
];

function LimitsEditor({workspace, busy, onSave, onReset, onCancel}) {
  const [draft, setDraft] = useState({...workspace.limits, storageMb: Math.round(workspace.limits.storageBytes / MB)});
  const save = event => {
    event.preventDefault();
    const {storageMb, storageBytes: _unused, ...rest} = draft;
    onSave(Object.fromEntries([...Object.entries(rest).map(([key, value]) => [key, Number(value)]),
      ['storageBytes', Math.round(Number(storageMb) * MB)]]));
  };
  return (
    <form className={styles.limitsEditor} onSubmit={save}>
      {LIMIT_FIELDS.map(([field, label, step]) => (
        <label key={field}>
          <span>{label}</span>
          <input type="number" min={0} step={step} value={draft[field]} onChange={event => setDraft({...draft, [field]: event.target.value})} />
        </label>
      ))}
      <div className={styles.actions}>
        <button type="submit" className={styles.refresh} disabled={busy}>Save limits</button>
        {workspace.overridden && <button type="button" className={styles.linkButton} disabled={busy} onClick={onReset}>Use defaults</button>}
        <button type="button" className={styles.linkButton} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function WorkspacesCard() {
  const [workspaces, setWorkspaces] = useState(null);
  const [editing, setEditing] = useState(null);
  const [query, setQuery] = useState('');
  const load = useCallback(async () => setWorkspaces((await apiRequest('/api/admin/workspaces')).workspaces), []);
  const {status, busy, run} = useAction(load);
  useEffect(() => { load().catch(error => setWorkspaces({error: error.message})); }, [load]);

  if (!workspaces) return <section className={styles.card}><p className={styles.empty}>Loading workspaces…</p></section>;
  if (workspaces.error) return <section className={styles.card}><div className={`${styles.notice} ${styles.noticeError}`}>{workspaces.error}</div></section>;

  const shown = workspaces.filter(workspace =>
    `${workspace.name} ${workspace.slug} ${workspace.owner?.email ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const setLimits = (workspace, limits) => run(async () => {
    await put(`/api/admin/workspaces/${encodeURIComponent(workspace.id)}/limits`, {limits});
    setEditing(null);
  }, `Limits for ${workspace.name} saved.`);
  const setStatus = (workspace, next) => {
    if (next === 'archived' && !clientPlatform.dialogs.confirm(`Archive ${workspace.name}? Its members lose access until you restore it.`)) return;
    void run(() => put(`/api/admin/workspaces/${encodeURIComponent(workspace.id)}/status`, {status: next}),
      `${workspace.name} is ${next === 'archived' ? 'archived' : 'restored'}.`);
  };

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <div><h2>Workspaces</h2><p>Every tenant: its owner, what it uses, and its limits.</p></div>
        <input className={styles.search} type="search" value={query} onChange={event => setQuery(event.target.value)}
          placeholder="Search workspaces" aria-label="Search workspaces" />
      </div>
      <Notice status={status} />
      <div className={styles.userTable}>
        <div className={`${styles.tenancyHead} ${styles.workspaceGrid}`}>
          <span>Workspace</span><span>Members</span><span>Storage</span><span>Assistant (month)</span><span>Actions</span>
        </div>
        {shown.length === 0 ? <p className={styles.empty}>No workspaces match.</p> : shown.map(workspace => (
          <React.Fragment key={workspace.id}>
            <div className={`${styles.tenancyRow} ${styles.workspaceGrid}`}>
              <span className={styles.userIdentity}>
                <span>
                  <strong>{workspace.name}{workspace.status === 'archived' && <small> · archived</small>}</strong>
                  <small className={styles.email}>{workspace.slug} · {workspace.owner?.email ?? 'no owner'}</small>
                </span>
              </span>
              <span>{workspace.members} / {workspace.limits.maxMembers}</span>
              <span>{megabytes(workspace.storageBytes)} / {megabytes(workspace.limits.storageBytes)}</span>
              <span className={workspace.aiMonthUsd >= workspace.limits.aiMonthlyUsd ? styles.bad : ''}>
                {usd(workspace.aiMonthUsd)} / {usd(workspace.limits.aiMonthlyUsd)}
              </span>
              <span className={styles.actions}>
                <button type="button" className={styles.linkButton} onClick={() => setEditing(editing === workspace.id ? null : workspace.id)}>
                  {workspace.overridden ? 'Limits*' : 'Limits'}
                </button>
                {workspace.status === 'archived'
                  ? <button type="button" className={styles.linkButton} disabled={busy} onClick={() => setStatus(workspace, 'active')}>Restore</button>
                  : <button type="button" className={styles.linkButton} disabled={busy} onClick={() => setStatus(workspace, 'archived')}>Archive</button>}
              </span>
            </div>
            {editing === workspace.id && (
              <LimitsEditor workspace={workspace} busy={busy}
                onSave={limits => setLimits(workspace, limits)}
                onReset={() => setLimits(workspace, null)}
                onCancel={() => setEditing(null)} />
            )}
          </React.Fragment>
        ))}
      </div>
      <p className={styles.permissionNote}>* overrides the default limits.</p>
    </section>
  );
}

const ACTION_LABELS = {
  'policy.update': 'changed the platform policy',
  'user.ban': 'suspended',
  'user.unban': 'restored',
  'user.sessions-revoke': 'signed out',
  'user.workspace-limit': 'changed the workspace limit of',
  'user.delete': 'deleted',
  'workspace.limits': 'changed the limits of',
  'workspace.archive': 'archived',
  'workspace.restore': 'restored',
  'workspace.delete': 'deleted',
};

export function AuditCard() {
  const [events, setEvents] = useState(null);
  useEffect(() => {
    apiRequest('/api/admin/audit?limit=50')
      .then(data => setEvents(data.events))
      .catch(error => setEvents({error: error.message}));
  }, []);
  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <div><h2>Administration log</h2><p>The last 50 administrator actions, and workspaces their owners removed.</p></div>
      </div>
      {!events ? <p className={styles.empty}>Loading…</p>
        : events.error ? <div className={`${styles.notice} ${styles.noticeError}`}>{events.error}</div>
          : events.length === 0 ? <p className={styles.empty}>Nothing yet.</p> : (
            <ul className={styles.auditList}>
              {events.map(event => (
                <li key={event.id}>
                  <span><strong>{event.actorLabel}</strong> {ACTION_LABELS[event.action] ?? event.action}{event.targetLabel ? <> <strong>{event.targetLabel}</strong></> : null}</span>
                  <time className={styles.email}>{when(event.at)}</time>
                </li>
              ))}
            </ul>
          )}
    </section>
  );
}
