import React, {useState, useEffect, useCallback} from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

import API_BASE from '@site/src/utils/api';

const ROLE_DESCRIPTIONS = {
  owner: 'Full access — can manage users, edit content, and configure the site.',
  editor: 'Can edit and publish content, but cannot manage user roles.',
  viewer: 'Read-only access. Cannot edit or publish content.',
};

const ROLE_COLORS = {
  owner: {bg: '#fef3c7', color: '#92400e', border: '#fcd34d'},
  editor: {bg: '#dbeafe', color: '#1e40af', border: '#93c5fd'},
  viewer: {bg: '#f3f4f6', color: '#6b7280', border: '#d1d5db'},
};

function RoleBadge({role}) {
  const colors = ROLE_COLORS[role] || ROLE_COLORS.viewer;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '4px',
      fontSize: '0.75rem',
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
      background: colors.bg,
      color: colors.color,
      border: `1px solid ${colors.border}`,
    }}>
      {role}
    </span>
  );
}

function AdminDashboard() {
  const {siteConfig} = useDocusaurusContext();
  const authEnabled = siteConfig.customFields?.authEnabled;
  const isLoaded = true;
  const clerkUser = authEnabled ? {id: 'admin'} : null;
  const [users, setUsers] = useState({});
  const [myRole, setMyRole] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [health, setHealth] = useState(null);
  const [stats, setStats] = useState(null);
  const [contentHealth, setContentHealth] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const userId = clerkUser?.id;

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const [healthRes, statsRes, contentHealthRes] = await Promise.allSettled([
        fetch(`${API_BASE}/api/health`).then(r => r.json()),
        fetch(`${API_BASE}/api/stats`).then(r => r.json()),
        fetch(`${API_BASE}/api/content-health`).then(r => r.json()),
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
    if (!userId) return;
    setLoading(true);
    try {
      const [usersRes, meRes] = await Promise.all([
        fetch(`${API_BASE}/api/users`).then(r => r.json()),
        fetch(`${API_BASE}/api/users/me?userId=${encodeURIComponent(userId)}`).then(r => r.json()),
      ]);
      setUsers(usersRes.users || {});
      setMyRole(meRes.role || 'viewer');
    } catch {
      setError('Failed to load user data. Is the editor server running?');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (isLoaded && userId) {
      loadData();
      loadStatus();
    }
  }, [isLoaded, userId, loadData, loadStatus]);

  const handleRoleChange = useCallback(async (targetUserId, newRole) => {
    setError(null);
    setSuccess(null);
    try {
      const existingUser = users[targetUserId] || {};
      const res = await fetch(`${API_BASE}/api/users/${encodeURIComponent(targetUserId)}/role`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          role: newRole,
          email: existingUser.email,
          name: existingUser.name,
          requesterId: userId,
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
  }, [userId, users, loadData]);

  if (!isLoaded || loading) {
    return (
      <div style={{padding: 40, textAlign: 'center', color: 'var(--ifm-color-emphasis-500)'}}>
        Loading...
      </div>
    );
  }

  if (!clerkUser) {
    return (
      <div style={{padding: 40, textAlign: 'center'}}>
        <p>You need to sign in to access the admin dashboard.</p>
      </div>
    );
  }

  const isOwner = myRole === 'owner';
  const userEntries = Object.entries(users);

  return (
    <div style={{maxWidth: 800, margin: '0 auto', padding: '2rem 1rem'}}>
      <h1 style={{fontSize: '1.8rem', marginBottom: '0.5rem'}}>User Management</h1>
      <p style={{color: 'var(--ifm-color-emphasis-600)', marginBottom: '2rem'}}>
        Manage user roles and permissions. Your role: <RoleBadge role={myRole} />
      </p>

      {error && (
        <div style={{
          padding: '10px 16px',
          background: 'rgba(239, 68, 68, 0.08)',
          color: '#dc2626',
          borderRadius: 8,
          fontSize: '0.9rem',
          marginBottom: '1rem',
          border: '1px solid rgba(239, 68, 68, 0.15)',
        }}>
          {error}
        </div>
      )}

      {success && (
        <div style={{
          padding: '10px 16px',
          background: 'rgba(34, 197, 94, 0.08)',
          color: '#16a34a',
          borderRadius: 8,
          fontSize: '0.9rem',
          marginBottom: '1rem',
          border: '1px solid rgba(34, 197, 94, 0.15)',
        }}>
          {success}
        </div>
      )}

      {/* Role descriptions */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '1rem',
        marginBottom: '2rem',
      }}>
        {Object.entries(ROLE_DESCRIPTIONS).map(([role, desc]) => (
          <div key={role} style={{
            padding: '1rem',
            borderRadius: 8,
            border: '1px solid var(--ifm-color-emphasis-200)',
            background: 'var(--ifm-background-surface-color)',
          }}>
            <div style={{marginBottom: '0.5rem'}}>
              <RoleBadge role={role} />
            </div>
            <p style={{fontSize: '0.85rem', color: 'var(--ifm-color-emphasis-600)', margin: 0}}>
              {desc}
            </p>
          </div>
        ))}
      </div>

      {/* System Status */}
      <div style={{marginBottom: '2rem'}}>
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem'}}>
          <h2 style={{fontSize: '1.3rem', margin: 0}}>System Status</h2>
          <button
            onClick={loadStatus}
            disabled={statusLoading}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid var(--ifm-color-emphasis-300)',
              background: 'var(--ifm-background-surface-color)',
              color: 'var(--ifm-font-color-base)',
              fontSize: '0.82rem',
              fontWeight: 500,
              cursor: statusLoading ? 'not-allowed' : 'pointer',
              opacity: statusLoading ? 0.6 : 1,
            }}
          >
            {statusLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '1rem',
        }}>
          {/* Server Status */}
          <div style={{
            padding: '1rem',
            borderRadius: 8,
            border: '1px solid var(--ifm-color-emphasis-200)',
            background: 'var(--ifm-background-surface-color)',
          }}>
            <div style={{fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--ifm-color-emphasis-500)', marginBottom: '0.4rem'}}>
              Server Status
            </div>
            <div style={{
              fontSize: '1.2rem',
              fontWeight: 700,
              color: health?.status === 'ok' ? '#16a34a' : '#dc2626',
            }}>
              {health ? (health.status === 'ok' ? 'OK' : 'DOWN') : '--'}
            </div>
          </div>
          {/* Uptime */}
          <div style={{
            padding: '1rem',
            borderRadius: 8,
            border: '1px solid var(--ifm-color-emphasis-200)',
            background: 'var(--ifm-background-surface-color)',
          }}>
            <div style={{fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--ifm-color-emphasis-500)', marginBottom: '0.4rem'}}>
              Uptime
            </div>
            <div style={{fontSize: '1.2rem', fontWeight: 700, color: 'var(--ifm-font-color-base)'}}>
              {health?.uptime != null ? (() => {
                const s = Math.floor(health.uptime);
                const h = Math.floor(s / 3600);
                const m = Math.floor((s % 3600) / 60);
                const sec = s % 60;
                return `${h}h ${m}m ${sec}s`;
              })() : '--'}
            </div>
          </div>
          {/* Memory */}
          <div style={{
            padding: '1rem',
            borderRadius: 8,
            border: '1px solid var(--ifm-color-emphasis-200)',
            background: 'var(--ifm-background-surface-color)',
          }}>
            <div style={{fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--ifm-color-emphasis-500)', marginBottom: '0.4rem'}}>
              Memory
            </div>
            <div style={{fontSize: '1.2rem', fontWeight: 700, color: 'var(--ifm-font-color-base)'}}>
              {health?.memory != null ? `${(health.memory / 1024 / 1024).toFixed(1)} MB` : '--'}
            </div>
          </div>
          {/* Total Files */}
          <div style={{
            padding: '1rem',
            borderRadius: 8,
            border: '1px solid var(--ifm-color-emphasis-200)',
            background: 'var(--ifm-background-surface-color)',
          }}>
            <div style={{fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--ifm-color-emphasis-500)', marginBottom: '0.4rem'}}>
              Total Files
            </div>
            <div style={{fontSize: '1.2rem', fontWeight: 700, color: 'var(--ifm-font-color-base)'}}>
              {stats?.totalFiles != null ? stats.totalFiles : '--'}
            </div>
          </div>
          {/* Total Words */}
          <div style={{
            padding: '1rem',
            borderRadius: 8,
            border: '1px solid var(--ifm-color-emphasis-200)',
            background: 'var(--ifm-background-surface-color)',
          }}>
            <div style={{fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--ifm-color-emphasis-500)', marginBottom: '0.4rem'}}>
              Total Words
            </div>
            <div style={{fontSize: '1.2rem', fontWeight: 700, color: 'var(--ifm-font-color-base)'}}>
              {stats?.totalWords != null ? stats.totalWords.toLocaleString() : '--'}
            </div>
          </div>
          {/* References */}
          <div style={{
            padding: '1rem',
            borderRadius: 8,
            border: '1px solid var(--ifm-color-emphasis-200)',
            background: 'var(--ifm-background-surface-color)',
          }}>
            <div style={{fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--ifm-color-emphasis-500)', marginBottom: '0.4rem'}}>
              References
            </div>
            <div style={{fontSize: '1.2rem', fontWeight: 700, color: 'var(--ifm-font-color-base)'}}>
              {stats?.references != null ? stats.references : '--'}
            </div>
          </div>
        </div>
      </div>

      {/* Content Health */}
      {contentHealth && (
        <div style={{
          border: '1px solid var(--ifm-color-emphasis-200)',
          borderRadius: 8,
          padding: '16px 20px',
          marginBottom: '1.5rem',
        }}>
          <h3 style={{margin: '0 0 12px', fontSize: '1rem', fontWeight: 600}}>Content Health</h3>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '12px', marginBottom: '16px'}}>
            <div style={{textAlign: 'center'}}>
              <div style={{fontSize: '1.5rem', fontWeight: 700, color: 'var(--ifm-color-primary)'}}>{contentHealth.totalPages}</div>
              <div style={{fontSize: '0.8rem', color: 'var(--ifm-color-emphasis-600)'}}>Total Pages</div>
            </div>
            <div style={{textAlign: 'center'}}>
              <div style={{fontSize: '1.5rem', fontWeight: 700, color: contentHealth.brokenLinkCount > 0 ? '#ef4444' : '#22c55e'}}>{contentHealth.brokenLinkCount}</div>
              <div style={{fontSize: '0.8rem', color: 'var(--ifm-color-emphasis-600)'}}>Broken Links</div>
            </div>
            <div style={{textAlign: 'center'}}>
              <div style={{fontSize: '1.5rem', fontWeight: 700, color: 'var(--ifm-color-emphasis-700)'}}>{contentHealth.orphanPageCount}</div>
              <div style={{fontSize: '0.8rem', color: 'var(--ifm-color-emphasis-600)'}}>Orphan Pages</div>
            </div>
            <div style={{textAlign: 'center'}}>
              <div style={{fontSize: '1.5rem', fontWeight: 700, color: contentHealth.draftCount > 0 ? '#f59e0b' : 'var(--ifm-color-emphasis-700)'}}>{contentHealth.draftCount}</div>
              <div style={{fontSize: '0.8rem', color: 'var(--ifm-color-emphasis-600)'}}>Drafts</div>
            </div>
          </div>
          {contentHealth.brokenLinks && contentHealth.brokenLinks.length > 0 && (
            <div style={{fontSize: '0.85rem'}}>
              <div style={{fontWeight: 600, marginBottom: 6, color: '#ef4444'}}>Broken Wiki Links:</div>
              {contentHealth.brokenLinks.map((link, i) => (
                <div key={i} style={{padding: '4px 0', color: 'var(--ifm-color-emphasis-600)', fontSize: '0.82rem'}}>
                  <code>{link.source}</code> links to <code>[[{link.target}]]</code>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Users table */}
      <div style={{
        border: '1px solid var(--ifm-color-emphasis-200)',
        borderRadius: 8,
        overflow: 'hidden',
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
      }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 120px 140px',
          padding: '10px 16px',
          background: 'var(--ifm-color-emphasis-100)',
          fontWeight: 600,
          fontSize: '0.82rem',
          color: 'var(--ifm-color-emphasis-700)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          minWidth: '500px',
        }}>
          <span>Name</span>
          <span>Email</span>
          <span>Role</span>
          <span>Actions</span>
        </div>

        {userEntries.length === 0 ? (
          <div style={{padding: '2rem', textAlign: 'center', color: 'var(--ifm-color-emphasis-400)', fontSize: '0.9rem'}}>
            No users registered yet. Users will appear here when their roles are assigned.
          </div>
        ) : (
          userEntries.map(([uid, userData]) => (
            <div
              key={uid}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 120px 140px',
                padding: '12px 16px',
                borderTop: '1px solid var(--ifm-color-emphasis-100)',
                alignItems: 'center',
                fontSize: '0.9rem',
                minWidth: '500px',
              }}
            >
              <span style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {userData.name || uid}
                {uid === userId && (
                  <span style={{
                    marginLeft: 6,
                    fontSize: '0.7rem',
                    color: 'var(--ifm-color-emphasis-400)',
                  }}>(you)</span>
                )}
              </span>
              <span style={{
                color: 'var(--ifm-color-emphasis-600)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: '0.85rem',
              }}>
                {userData.email || '--'}
              </span>
              <span><RoleBadge role={userData.role} /></span>
              <span>
                {isOwner && uid !== userId ? (
                  <select
                    value={userData.role}
                    onChange={(e) => handleRoleChange(uid, e.target.value)}
                    style={{
                      padding: '4px 8px',
                      borderRadius: 4,
                      border: '1px solid var(--ifm-color-emphasis-300)',
                      background: 'var(--ifm-background-color)',
                      color: 'var(--ifm-font-color-base)',
                      fontSize: '0.82rem',
                      cursor: 'pointer',
                    }}
                  >
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                ) : (
                  <span style={{fontSize: '0.8rem', color: 'var(--ifm-color-emphasis-400)'}}>
                    {uid === userId ? '--' : 'No access'}
                  </span>
                )}
              </span>
            </div>
          ))
        )}
      </div>

      {!isOwner && (
        <p style={{
          marginTop: '1.5rem',
          fontSize: '0.85rem',
          color: 'var(--ifm-color-emphasis-500)',
          textAlign: 'center',
        }}>
          Only owners can change user roles. Contact an owner to request role changes.
        </p>
      )}
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
