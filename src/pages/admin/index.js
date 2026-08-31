import React, {useState, useEffect, useCallback} from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';

import API_BASE, { apiFetch } from '@site/src/utils/api';
import pageStyles from '@site/src/css/page.module.css';
import styles from './styles.module.css';

const ROLE_DESCRIPTIONS = {
  admin: 'Internal platform operations. Does not grant workspace access.',
  user: 'No platform privileges; workspace access comes only from membership.',
};

function RoleBadge({role}) {
  return <span className={`${styles.roleBadge} ${styles[`role_${role}`] ?? ''}`}>{role}</span>;
}

function formatUptime(value) {
  if (value == null) return '—';
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function AdminDashboard() {
  const [users, setUsers] = useState({});
  const [myRole, setMyRole] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [health, setHealth] = useState(null);
  const [stats, setStats] = useState(null);
  const [contentHealth, setContentHealth] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [query, setQuery] = useState('');
  // Who the server says we are. The page used to invent this locally, as a
  // hardcoded {id: 'admin'} whenever the auth gate was on, and then post that id
  // back as the requester of a role change. Identity is the server's answer now,
  // and /api/users/me reports the subject of the verified session.
  const [myUserId, setMyUserId] = useState(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const [healthRes, statsRes, contentHealthRes] = await Promise.allSettled([
        apiFetch(`${API_BASE}/api/health`).then(r => r.json()),
        apiFetch(`${API_BASE}/api/stats`).then(r => r.json()),
        apiFetch(`${API_BASE}/api/content-health`).then(r => r.json()),
      ]);
      setHealth(healthRes.status === 'fulfilled' ? healthRes.value : {status: 'down'});
      setStats(statsRes.status === 'fulfilled' ? statsRes.value : null);
      setContentHealth(contentHealthRes.status === 'fulfilled' ? contentHealthRes.value : null);
    } catch {
      setHealth({status: 'down'});
      setStats(null);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, meRes] = await Promise.all([
        apiFetch(`${API_BASE}/api/users`),
        apiFetch(`${API_BASE}/api/users/me`),
      ]);
      const usersBody = await usersRes.json();
      const me = await meRes.json();
      setMyRole(me.role || 'user');
      setMyUserId(me.userId || null);
      // Every account on the server is the site owner's view. Anyone else gets
      // the reason rather than an empty table, which is what reading `.users`
      // off a refusal used to render.
      setUsers(usersRes.ok ? (usersBody.users || {}) : {});
      if (!usersRes.ok) setError(usersBody.error || 'Could not load the account list.');
    } catch {
      setError('Failed to load user data. Is the editor server running?');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    loadStatus();
  }, [loadData, loadStatus]);

  const handleRoleChange = useCallback(async (targetUserId, newRole) => {
    setError(null);
    setSuccess(null);
    try {
      const existingUser = users[targetUserId] || {};
      const res = await apiFetch(`${API_BASE}/api/users/${encodeURIComponent(targetUserId)}/role`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          role: newRole,
          email: existingUser.email,
          name: existingUser.name,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to update role');
      }
      setSuccess(`Role updated to "${newRole}" successfully.`);
      setTimeout(() => setSuccess(null), 3000);
      loadData();
    } catch (err) {
      setError(err.message);
    }
  }, [users, loadData]);

  if (loading) {
    return <div className={styles.loading}>Loading accounts…</div>;
  }

  const isAdmin = myRole === 'admin';
  const userEntries = Object.entries(users);
  const shownUsers = userEntries.filter(([uid, user]) => (
    `${uid} ${user.name ?? ''} ${user.email ?? ''} ${user.role ?? ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  ));
  const adminCount = userEntries.filter(([, user]) => user.role === 'admin').length;

  return (
    <div className={`${pageStyles.pageContainer} ${pageStyles.wide}`}>
      <header className={styles.pageHeader}>
        <div>
          <span className={styles.eyebrow}>Platform administration</span>
          <h1>User management</h1>
          <p>Manage server-wide access separately from organization membership.</p>
        </div>
        <Link className={styles.workspaceLink} to="/people">Open organization members <span aria-hidden="true">→</span></Link>
      </header>

      {error && <div className={`${styles.notice} ${styles.noticeError}`} role="alert">{error}</div>}
      {success && <div className={`${styles.notice} ${styles.noticeSuccess}`} role="status">{success}</div>}

      <section className={styles.summary} aria-label="Platform summary">
        <div><strong>{userEntries.length}</strong><span>Accounts</span></div>
        <div><strong>{adminCount}</strong><span>Administrators</span></div>
        <div><strong className={health?.status === 'ok' ? styles.good : styles.bad}>{health?.status === 'ok' ? 'Online' : 'Check'}</strong><span>Server</span></div>
        <div><strong>{stats?.totalFiles ?? '—'}</strong><span>Documents</span></div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2>Accounts</h2>
            <p>Your platform role is <RoleBadge role={myRole} />. Organization roles are managed from People.</p>
          </div>
          <input
            className={styles.search}
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search accounts"
            aria-label="Search accounts"
          />
        </div>

        <div className={styles.roleGuide}>
          {Object.entries(ROLE_DESCRIPTIONS).map(([role, description]) => (
            <span key={role}><RoleBadge role={role} /> {description}</span>
          ))}
        </div>

        <div className={styles.userTable}>
          <div className={styles.tableHead}>
            <span>User</span><span>Email</span><span>Access</span><span>Change role</span>
          </div>
          {shownUsers.length === 0 ? (
            <p className={styles.empty}>{userEntries.length ? `No accounts match “${query}”.` : 'No accounts yet.'}</p>
          ) : shownUsers.map(([uid, userData]) => (
            <div className={styles.userRow} key={uid}>
              <span className={styles.userIdentity}>
                <i aria-hidden="true">{(userData.name || userData.email || '?').charAt(0).toUpperCase()}</i>
                <span><strong>{userData.name || uid}</strong>{uid === myUserId && <small>You</small>}</span>
              </span>
              <span className={styles.email}>{userData.email || '—'}</span>
              <span><RoleBadge role={userData.role} /></span>
              <span>
                {isAdmin && uid !== myUserId ? (
                  <select className={styles.roleSelect} value={userData.role} onChange={event => handleRoleChange(uid, event.target.value)}>
                    <option value="admin">Administrator</option>
                    <option value="user">User</option>
                  </select>
                ) : <span className={styles.locked}>{uid === myUserId ? 'Current account' : 'Admin only'}</span>}
              </span>
            </div>
          ))}
        </div>
        {!isAdmin && <p className={styles.permissionNote}>Only platform administrators can change platform roles.</p>}
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div><h2>System health</h2><p>Runtime and content diagnostics.</p></div>
          <button className={styles.refresh} type="button" onClick={loadStatus} disabled={statusLoading}>
            {statusLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <div className={styles.healthGrid}>
          <div><span>Status</span><strong className={health?.status === 'ok' ? styles.good : styles.bad}>{health?.status === 'ok' ? 'Healthy' : 'Unavailable'}</strong></div>
          <div><span>Uptime</span><strong>{formatUptime(health?.uptime)}</strong></div>
          <div><span>Memory</span><strong>{health?.memory != null ? `${(health.memory / 1024 / 1024).toFixed(1)} MB` : '—'}</strong></div>
          <div><span>Words</span><strong>{stats?.totalWords?.toLocaleString() ?? '—'}</strong></div>
          <div><span>References</span><strong>{stats?.references ?? '—'}</strong></div>
          <div><span>Broken links</span><strong className={contentHealth?.brokenLinkCount ? styles.bad : styles.good}>{contentHealth?.brokenLinkCount ?? '—'}</strong></div>
        </div>
      </section>
    </div>
  );
}

export default function AdminPage() {
  const ErrorBoundary = require('@site/src/components/ErrorBoundary').default;
  return (
    <Layout title="Admin" description="Manage users, roles, and system status for Mochi Lab" noFooter>
      <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading...</div>}>
        {() => <ErrorBoundary><AdminDashboard /></ErrorBoundary>}
      </BrowserOnly>
    </Layout>
  );
}
