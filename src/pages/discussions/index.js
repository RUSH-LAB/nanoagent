import React, {useState, useEffect, useCallback} from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';

function DiscussionsApp() {
  const ChannelView =
    require('../../components/Discussions/ChannelView').default;
  const styles = require('../../components/Discussions/styles.module.css');
  const LoadingSkeleton =
    require('../../components/LoadingSkeleton').default;

  const API_BASE = require('@site/src/utils/api').default;

  const [channels, setChannels] = useState([]);
  const [activeChannel, setActiveChannel] = useState(null);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTopic, setNewTopic] = useState('');
  const [newLinkedPage, setNewLinkedPage] = useState('');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/discussions`);
      if (!res.ok) throw new Error(`Failed to load channels (${res.status})`);
      const data = await res.json();
      setChannels(data.channels || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  const handleCreateChannel = async (e) => {
    e.preventDefault();
    if (!newName.trim() || creating) return;

    setCreating(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/api/discussions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          name: newName.trim(),
          topic: newTopic.trim(),
          linkedPage: newLinkedPage.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Server error (${res.status})`);
      }
      const data = await res.json();
      setNewName('');
      setNewTopic('');
      setNewLinkedPage('');
      setShowNewChannel(false);
      await fetchChannels();
      setActiveChannel(data.channel);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={styles.wrapper}>
      {/* Sidebar: channel list */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span className={styles.sidebarTitle}>Channels</span>
          <button
            className={styles.newChannelBtn}
            onClick={() => setShowNewChannel(true)}
            type="button"
          >
            + New
          </button>
        </div>

        <ul className={styles.channelList}>
          {channels.map((ch) => (
            <li
              key={ch.id}
              className={`${styles.channelItem} ${
                activeChannel?.id === ch.id ? styles.channelItemActive : ''
              }`}
              onClick={() => setActiveChannel(ch)}
            >
              <div className={styles.channelName}>{ch.name}</div>
              <div className={styles.channelMeta}>
                <span className={styles.channelTopic}>
                  {ch.topic || 'No topic set'}
                </span>
                <span className={styles.channelCount}>
                  {ch.messageCount} msg{ch.messageCount !== 1 ? 's' : ''}
                </span>
              </div>
            </li>
          ))}
          {loading && channels.length === 0 && (
            <>
              {[0, 1, 2].map((i) => (
                <li key={i} style={{ padding: '0.6rem 1rem' }}>
                  <LoadingSkeleton shape="text" width="60%" height={14} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                    <LoadingSkeleton shape="text" width="45%" height={10} />
                    <LoadingSkeleton shape="text" width={32} height={10} />
                  </div>
                </li>
              ))}
            </>
          )}
          {!loading && channels.length === 0 && (
            <li
              style={{
                padding: '1.5rem 1rem',
                textAlign: 'center',
                color: 'var(--ifm-color-emphasis-500)',
                fontSize: '0.85rem',
              }}
            >
              No channels yet. Create one to get started.
            </li>
          )}
        </ul>
      </div>

      {/* Main content: channel view or placeholder */}
      {activeChannel ? (
        <ChannelView channel={activeChannel} />
      ) : (
        <div className={styles.main}>
          <div className={styles.placeholder}>
            Select a channel or create a new one to start discussing.
          </div>
        </div>
      )}

      {/* New channel modal */}
      {showNewChannel && (
        <div
          className={styles.modalOverlay}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowNewChannel(false);
          }}
        >
          <div className={styles.modal}>
            <h3 className={styles.modalTitle}>Create a Channel</h3>
            <form onSubmit={handleCreateChannel}>
              <div className={styles.modalField}>
                <label className={styles.modalLabel}>Channel Name *</label>
                <input
                  className={styles.modalInput}
                  type="text"
                  placeholder="e.g. General, Paper Discussion"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              <div className={styles.modalField}>
                <label className={styles.modalLabel}>Topic</label>
                <input
                  className={styles.modalInput}
                  type="text"
                  placeholder="What is this channel about?"
                  value={newTopic}
                  onChange={(e) => setNewTopic(e.target.value)}
                />
              </div>
              <div className={styles.modalField}>
                <label className={styles.modalLabel}>
                  Linked Page (optional)
                </label>
                <input
                  className={styles.modalInput}
                  type="text"
                  placeholder="/bibliography/some-paper"
                  value={newLinkedPage}
                  onChange={(e) => setNewLinkedPage(e.target.value)}
                />
              </div>
              {error && <p className={styles.error}>{error}</p>}
              <div className={styles.modalActions}>
                <button
                  className={styles.modalCancelBtn}
                  type="button"
                  onClick={() => {
                    setShowNewChannel(false);
                    setError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className={styles.modalSubmitBtn}
                  type="submit"
                  disabled={creating || !newName.trim()}
                >
                  {creating ? 'Creating...' : 'Create Channel'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DiscussionsPage() {
  return (
    <Layout
      title="Discussions"
      description="Discussion channels for the Mochi Lab community"
    >
      <BrowserOnly>{() => <ErrorBoundary><DiscussionsApp /></ErrorBoundary>}</BrowserOnly>
    </Layout>
  );
}
