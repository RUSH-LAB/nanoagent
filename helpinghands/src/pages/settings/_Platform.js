import React, {useCallback, useEffect, useState} from 'react';
import Avatar from '@site/src/components/Avatar';
import RowMenu from '@site/src/components/RowMenu';
import {apiRequest} from '@site/src/utils/api';
import {clientPlatform} from '@site/src/platform/client';
import dir from '@site/src/css/directory.module.css';
import {PaneHeading, Skeleton} from './_parts';
import card from './styles.module.css';
import people from './people.module.css';
import styles from './platform.module.css';

/**
 * The Platform group of Settings, for platform administrators only
 * (src/server/routes/admin.js): the server's health, sign-up and the limits
 * every workspace gets, every account, every workspace, and the log of what
 * administrators did. The server refuses anyone else, whatever this renders.
 */

const MB = 1024 * 1024;
const usd = value => `$${Number(value).toFixed(2)}`;
const megabytes = value => `${(Number(value) / MB).toFixed(Number(value) < 10 * MB ? 1 : 0)} MB`;
const when = value => (value ? new Date(value).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'}) : '—');
const uptime = seconds => `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;

function put(path, body) {
  return apiRequest(path, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
}

/** What the last write said, beside the pane's title. */
function Status({status}) {
  if (!status) return null;
  return <span className={status.type === 'error' ? card.error : card.saved} role={status.type === 'error' ? 'alert' : 'status'}>{status.message}</span>;
}

/** Run an admin write, report its outcome, and reload the pane. */
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

/** Load a pane's data with `load`: null while loading, {error} when it failed. */
function useLoaded(load) {
  const [data, setData] = useState(null);
  const reload = useCallback(async () => setData(await load()), [load]);
  useEffect(() => { reload().catch(error => setData({error: error.message})); }, [reload]);
  return [data, reload];
}

function Health() {
  const [health, reload] = useLoaded(useCallback(() => apiRequest('/api/health'), []));
  const ok = health?.status === 'ok';
  return (
    <>
      <PaneHeading title="Server" aside={<button type="button" className={card.secondaryButton} onClick={() => reload().catch(() => {})}>Refresh</button>} />
      {!health ? <Skeleton rows={3} /> : (
        <section className={card.group}>
          <div className={card.row}>
            <p className={card.rowLabel}><strong>Status</strong></p>
            <span className={`${card.rowValue} ${ok ? card.saved : card.error}`}>{ok ? 'Healthy' : health.error ?? 'Unavailable'}</span>
          </div>
          <div className={card.row}>
            <p className={card.rowLabel}><strong>Up for</strong></p>
            <span className={card.rowValue}>{health.uptime != null ? uptime(health.uptime) : '—'}</span>
          </div>
          <div className={card.row}>
            <p className={card.rowLabel}><strong>Memory</strong></p>
            <span className={card.rowValue}>{health.memory != null ? megabytes(health.memory) : '—'}</span>
          </div>
        </section>
      )}
    </>
  );
}

const SIGNUP_LABELS = {
  invite: 'Invitation only, and the allowlist',
  allowlist: 'The allowlist only',
  open: 'Anyone',
};

// The policy's numbers: field, label, what it limits, step, and how it is shown (MB for bytes).
const POLICY_NUMBERS = [
  ['workspaceMaxMembers', 'Members per workspace', 'Invitations past it are refused.', 1],
  ['workspaceStorageMb', 'Storage per workspace', 'In MB, for every file in it.', 1],
  ['maxWorkspacesPerUser', 'Workspaces per account', 'How many one account may own.', 1],
  ['workspaceAiDailyUsd', 'Assistant per workspace, a day', 'In dollars, for runs on Mochi.', 0.01],
  ['workspaceAiMonthlyUsd', 'Assistant per workspace, a month', 'In dollars, for runs on Mochi.', 0.01],
  ['memberAiDailyUsd', 'Assistant per member, a day', 'In dollars, for runs on Mochi.', 0.01],
];

function Limits() {
  const load = useCallback(async () => {
    const {policy} = await apiRequest('/api/admin/policy');
    return {...policy, signupAllowlist: policy.signupAllowlist.join('\n'), workspaceStorageMb: Math.round(policy.workspaceStorageBytes / MB)};
  }, []);
  const [policy, reload] = useLoaded(load);
  const [draft, setDraft] = useState(null);
  useEffect(() => { if (policy && !policy.error) setDraft(policy); }, [policy]);
  const {status, busy, run} = useAction(reload);

  const heading = <PaneHeading title="Sign-up and limits" aside={<Status status={status} />} />;
  if (policy?.error) return <>{heading}<p className={card.error}>{policy.error}</p></>;
  if (!draft) return <>{heading}<Skeleton rows={4} /></>;
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
    }), 'Saved.');
  };

  return (
    <>
      {heading}
      <form className={card.group} onSubmit={save}>
        <label className={card.row}>
          <span className={card.rowLabel}><strong>Who may sign up</strong><span>Everyone signs in with GitHub.</span></span>
          <select className={card.input} value={draft.signupMode} onChange={set('signupMode')}>
            {Object.entries(SIGNUP_LABELS).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
          </select>
        </label>
        <label className={card.row}>
          <span className={card.rowLabel}><strong>Allowlist</strong><span>Addresses or @domains, one a line.</span></span>
          <textarea className={`${card.input} ${styles.allowlist}`} rows={3} value={draft.signupAllowlist}
            onChange={set('signupAllowlist')} placeholder={'ada@example.com\n@example.org'} />
        </label>
        {POLICY_NUMBERS.map(([field, label, note, step]) => (
          <label className={card.row} key={field}>
            <span className={card.rowLabel}><strong>{label}</strong><span>{note}</span></span>
            <input className={`${card.input} ${styles.number}`} type="number" min={0} step={step} value={draft[field]} onChange={set(field)} />
          </label>
        ))}
        <div className={card.groupFooter}>
          <span className={card.muted}>Changed {when(policy.updatedAt)}. A workspace's own limits override these.</span>
          <button type="submit" className={card.primaryButton} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </>
  );
}

function Accounts({myUserId}) {
  const [users, reload] = useLoaded(useCallback(async () => (await apiRequest('/api/admin/users')).users, []));
  const [query, setQuery] = useState('');
  const {status, busy, run} = useAction(reload);

  const heading = <PaneHeading title="Accounts" aside={<Status status={status} />} />;
  if (users?.error) return <>{heading}<p className={card.error}>{users.error}</p></>;
  if (!users) return <>{heading}<Skeleton rows={4} /></>;

  const shown = users.filter(user => `${user.name ?? ''} ${user.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  const label = user => user.name || user.email;
  const path = (user, action = '') => `/api/admin/users/${encodeURIComponent(user.id)}${action}`;
  const setRole = (user, role) => run(() => put(`/api/users/${encodeURIComponent(user.id)}/role`, {role}),
    `${label(user)} is now ${role === 'admin' ? 'an administrator' : 'a member only'}.`);
  const suspend = user => {
    const reason = clientPlatform.dialogs.prompt(`Suspend ${label(user)}? They are signed out everywhere. Reason (optional):`, '');
    if (reason === null) return;
    void run(() => apiRequest(path(user, '/ban'), {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({reason}),
    }), `${label(user)} is suspended.`);
  };
  const workspaceLimit = user => {
    const answer = clientPlatform.dialogs.prompt(`How many workspaces may ${label(user)} own? Leave empty for the default.`, user.maxWorkspaces ?? '');
    if (answer === null) return;
    void run(() => put(path(user, '/workspace-limit'), {maxWorkspaces: answer.trim() === '' ? null : Number(answer)}),
      `${label(user)}'s workspace limit is saved.`);
  };
  const remove = user => {
    if (!clientPlatform.dialogs.confirm(`Delete ${label(user)}? Workspaces only they use are deleted too. This cannot be undone.`)) return;
    void run(() => apiRequest(path(user), {method: 'DELETE'}), `${label(user)} is deleted.`);
  };

  return (
    <>
      {heading}
      <section className={card.group}>
        <div className={card.groupHead}>
          <h4 className={card.groupTitle}>{users.length} {users.length === 1 ? 'account' : 'accounts'}</h4>
          <input className={dir.search} type="search" value={query} onChange={event => setQuery(event.target.value)}
            placeholder="Find an account" aria-label="Find an account" />
        </div>
        <div className={`${styles.accounts} ${people.columns}`} aria-hidden="true">
          <span>Name</span><span>Role</span><span>Spend, 30 days</span><span>Last active</span><span />
        </div>
        {shown.length === 0 ? <p className={people.empty}>No account matches.</p> : (
          <ul className={people.rows}>
            {shown.map(user => (
              <li key={user.id} className={`${styles.accounts} ${people.row}`}>
                <span className={people.person}>
                  <Avatar user={user} size={32} />
                  <span className={dir.identity}>
                    <span className={dir.name}>{label(user)}{user.id === myUserId && <span className={dir.tag}>you</span>}</span>
                    <span className={dir.detail}>{user.email}</span>
                  </span>
                </span>
                <span>
                  {user.bannedAt
                    ? <span className={`${people.role} ${styles.suspended}`} title={user.banReason || ''}>suspended</span>
                    : <span className={`${people.role} ${user.admin ? styles.admin : ''}`}>{user.admin ? 'admin' : 'member'}</span>}
                </span>
                <span className={people.when}>{usd(user.ai30dUsd)}</span>
                <span className={people.when}>{when(user.lastSeenAt)}</span>
                <span className={people.rowActions}>
                  {user.id === myUserId ? <span className={people.menuSlot} /> : (
                    <RowMenu label={`More for ${label(user)}`} items={[
                      {label: user.admin ? 'Remove as administrator' : 'Make administrator', disabled: busy, onSelect: () => setRole(user, user.admin ? 'user' : 'admin')},
                      user.bannedAt
                        ? {label: 'Restore', disabled: busy, onSelect: () => run(() => apiRequest(path(user, '/ban'), {method: 'DELETE'}), `${label(user)} can sign in again.`)}
                        : {label: 'Suspend…', disabled: busy || user.admin, onSelect: () => suspend(user)},
                      {label: 'Sign out everywhere', disabled: busy || !user.sessions, onSelect: () => run(() => apiRequest(path(user, '/sessions'), {method: 'DELETE'}), `${label(user)} is signed out everywhere.`)},
                      {label: user.maxWorkspaces != null ? `Workspace limit (${user.maxWorkspaces})…` : 'Workspace limit…', disabled: busy, onSelect: () => workspaceLimit(user)},
                      {label: 'Delete account…', danger: true, disabled: busy || user.admin, onSelect: () => remove(user)},
                    ]} />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

const LIMIT_FIELDS = [
  ['maxMembers', 'Members', 1],
  ['storageMb', 'Storage (MB)', 1],
  ['aiDailyUsd', 'Assistant a day ($)', 0.01],
  ['aiMonthlyUsd', 'Assistant a month ($)', 0.01],
  ['memberAiDailyUsd', 'Per member a day ($)', 0.01],
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
    <li>
      <form className={styles.limitsEditor} onSubmit={save}>
        {LIMIT_FIELDS.map(([field, label, step]) => (
          <label key={field}>
            <span>{label}</span>
            <input className={card.input} type="number" min={0} step={step} value={draft[field]}
              onChange={event => setDraft({...draft, [field]: event.target.value})} />
          </label>
        ))}
        <div className={styles.editorActions}>
          {workspace.overridden && <button type="button" className={card.secondaryButton} disabled={busy} onClick={onReset}>Use the defaults</button>}
          <button type="button" className={card.secondaryButton} onClick={onCancel}>Cancel</button>
          <button type="submit" className={card.primaryButton} disabled={busy}>Save limits</button>
        </div>
      </form>
    </li>
  );
}

/** `used` of `limit`, as text and a bar that turns red when it is full. */
function Usage({used, limit, format = String}) {
  const share = limit > 0 ? Math.min(used / limit, 1) : 1;
  return (
    <span className={styles.usage}>
      <span className={people.when}>{format(used)} / {format(limit)}</span>
      <span className={styles.bar}><span className={share >= 1 ? styles.full : ''} style={{width: `${share * 100}%`}} /></span>
    </span>
  );
}

function Workspaces() {
  const [workspaces, reload] = useLoaded(useCallback(async () => (await apiRequest('/api/admin/workspaces')).workspaces, []));
  const [editing, setEditing] = useState(null);
  const [query, setQuery] = useState('');
  const {status, busy, run} = useAction(reload);

  const heading = <PaneHeading title="Workspaces" aside={<Status status={status} />} />;
  if (workspaces?.error) return <>{heading}<p className={card.error}>{workspaces.error}</p></>;
  if (!workspaces) return <>{heading}<Skeleton rows={3} /></>;

  const shown = workspaces.filter(workspace =>
    `${workspace.name} ${workspace.slug} ${workspace.owner?.email ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const setLimits = (workspace, limits) => run(async () => {
    await put(`/api/admin/workspaces/${encodeURIComponent(workspace.id)}/limits`, {limits});
    setEditing(null);
  }, `${workspace.name}'s limits are saved.`);
  const setStatus = (workspace, next) => {
    if (next === 'archived' && !clientPlatform.dialogs.confirm(`Archive ${workspace.name}? Its members lose access until you restore it.`)) return;
    void run(() => put(`/api/admin/workspaces/${encodeURIComponent(workspace.id)}/status`, {status: next}),
      `${workspace.name} is ${next === 'archived' ? 'archived' : 'restored'}.`);
  };

  return (
    <>
      {heading}
      <section className={card.group}>
        <div className={card.groupHead}>
          <h4 className={card.groupTitle}>{workspaces.length} {workspaces.length === 1 ? 'workspace' : 'workspaces'}</h4>
          <input className={dir.search} type="search" value={query} onChange={event => setQuery(event.target.value)}
            placeholder="Find a workspace" aria-label="Find a workspace" />
        </div>
        <div className={`${styles.workspaces} ${people.columns}`} aria-hidden="true">
          <span>Workspace</span><span>Members</span><span>Storage</span><span>Assistant, month</span><span />
        </div>
        {shown.length === 0 ? <p className={people.empty}>No workspace matches.</p> : (
          <ul className={people.rows}>
            {shown.map(workspace => (
              <React.Fragment key={workspace.id}>
                <li className={`${styles.workspaces} ${people.row}`}>
                  <span className={dir.identity}>
                    <span className={dir.name}>
                      {workspace.name}
                      {workspace.status === 'archived' && <span className={dir.tag}>archived</span>}
                      {workspace.overridden && <span className={dir.tag} title="Its own limits, not the defaults">own limits</span>}
                    </span>
                    <span className={dir.detail}>{workspace.slug} · {workspace.owner?.email ?? 'no owner'}</span>
                  </span>
                  <Usage used={workspace.members} limit={workspace.limits.maxMembers} />
                  <Usage used={workspace.storageBytes} limit={workspace.limits.storageBytes} format={megabytes} />
                  <Usage used={workspace.aiMonthUsd} limit={workspace.limits.aiMonthlyUsd} format={usd} />
                  <span className={people.rowActions}>
                    <RowMenu label={`More for ${workspace.name}`} items={[
                      {label: 'Edit limits', onSelect: () => setEditing(editing === workspace.id ? null : workspace.id)},
                      workspace.status === 'archived'
                        ? {label: 'Restore', disabled: busy, onSelect: () => setStatus(workspace, 'active')}
                        : {label: 'Archive…', danger: true, disabled: busy, onSelect: () => setStatus(workspace, 'archived')},
                    ]} />
                  </span>
                </li>
                {editing === workspace.id && (
                  <LimitsEditor workspace={workspace} busy={busy}
                    onSave={limits => setLimits(workspace, limits)}
                    onReset={() => setLimits(workspace, null)}
                    onCancel={() => setEditing(null)} />
                )}
              </React.Fragment>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

const ACTION_LABELS = {
  'policy.update': 'changed sign-up and limits',
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

function Log() {
  const [events] = useLoaded(useCallback(async () => (await apiRequest('/api/admin/audit?limit=50')).events, []));
  return (
    <>
      <PaneHeading title="Log" aside={<span className={card.muted}>The last 50 administrator actions</span>} />
      {!events ? <Skeleton rows={3} />
        : events.error ? <p className={card.error}>{events.error}</p>
          : (
            <section className={card.group}>
              {events.length === 0 ? <p className={people.empty}>Nothing yet.</p> : events.map(event => (
                <div className={card.row} key={event.id}>
                  <p className={card.rowLabel}>
                    <span className={styles.event}>
                      <strong>{event.actorLabel}</strong> {ACTION_LABELS[event.action] ?? event.action}
                      {event.targetLabel ? <> <strong>{event.targetLabel}</strong></> : null}
                    </span>
                  </p>
                  <time className={people.when}>{when(event.at)}</time>
                </div>
              ))}
            </section>
          )}
    </>
  );
}

/** The sections of the Platform group, by the ids the sidebar links to. */
export const PLATFORM_PANES = [
  {id: 'server', label: 'Server'},
  {id: 'limits', label: 'Sign-up and limits'},
  {id: 'accounts', label: 'Accounts'},
  {id: 'workspaces', label: 'Workspaces'},
  {id: 'log', label: 'Log'},
];

export default function Platform({myUserId}) {
  return (
    <>
      <section id="server" className={card.pane}><Health /></section>
      <section id="limits" className={card.pane}><Limits /></section>
      <section id="accounts" className={card.pane}><Accounts myUserId={myUserId} /></section>
      <section id="workspaces" className={card.pane}><Workspaces /></section>
      <section id="log" className={card.pane}><Log /></section>
    </>
  );
}
