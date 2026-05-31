import React, {useState, useEffect, useRef, useCallback} from 'react';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';
import API_BASE from '@site/src/utils/api';

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getInitial(name) {
  return (name || '?')[0];
}

function highlightText(text, query) {
  if (!query || !text) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);
  return parts.map((part, i) =>
    regex.test(part)
      ? React.createElement('mark', {key: i, style: {backgroundColor: 'rgba(59, 130, 246, 0.2)', color: 'inherit', padding: '0 1px', borderRadius: '2px'}}, part)
      : part
  );
}

export default function ChannelView({channel}) {
  const [messages, setMessages] = useState([]);
  const [pinnedIds, setPinnedIds] = useState([]);
  const [author, setAuthor] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingMsg, setEditingMsg] = useState(null);
  const [editText, setEditText] = useState('');
  const messagesEndRef = useRef(null);
  const messagesAreaRef = useRef(null);
  const searchInputRef = useRef(null);

  const fetchMessages = useCallback(async () => {
    if (!channel) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/discussions/${encodeURIComponent(channel.id)}/messages`,
      );
      if (!res.ok) throw new Error(`Failed to load messages (${res.status})`);
      const data = await res.json();
      setMessages(data.messages || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [channel]);

  // Sync pinned IDs from the channel prop
  useEffect(() => {
    setPinnedIds(channel?.pinnedMessages || []);
  }, [channel]);

  const pinMessage = async (messageId) => {
    try {
      const res = await fetch(
        `${API_BASE}/api/discussions/${encodeURIComponent(channel.id)}/pin`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({messageId}),
        },
      );
      if (!res.ok) throw new Error('Failed to pin');
      setPinnedIds((prev) => [...prev, messageId]);
    } catch (err) {
      setError(err.message);
    }
  };

  const unpinMessage = async (messageId) => {
    try {
      const res = await fetch(
        `${API_BASE}/api/discussions/${encodeURIComponent(channel.id)}/pin`,
        {
          method: 'DELETE',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({messageId}),
        },
      );
      if (!res.ok) throw new Error('Failed to unpin');
      setPinnedIds((prev) => prev.filter((id) => id !== messageId));
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    fetchMessages();
    // Poll for new messages every 5 seconds
    const interval = setInterval(fetchMessages, 5000);
    return () => clearInterval(interval);
  }, [fetchMessages]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({behavior: 'smooth'});
  }, [messages]);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!text.trim() || sending) return;

    setSending(true);
    setError(null);

    try {
      const res = await fetch(
        `${API_BASE}/api/discussions/${encodeURIComponent(channel.id)}/messages`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            author: author.trim() || 'Anonymous',
            text: text.trim(),
          }),
        },
      );
      if (!res.ok) throw new Error(`Failed to send message (${res.status})`);
      setText('');
      await fetchMessages();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const editMessage = async (messageId) => {
    if (!editText.trim()) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/discussions/${encodeURIComponent(channel.id)}/messages`,
        {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({messageId, text: editText.trim()}),
        },
      );
      if (!res.ok) throw new Error('Failed to edit');
      const data = await res.json();
      setMessages((prev) => prev.map((m) => m.id === messageId ? data.message : m));
      setEditingMsg(null);
      setEditText('');
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteMessage = async (messageId) => {
    if (!window.confirm('Delete this message?')) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/discussions/${encodeURIComponent(channel.id)}/messages`,
        {
          method: 'DELETE',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({messageId}),
        },
      );
      if (!res.ok) throw new Error('Failed to delete');
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  useEffect(() => {
    function handleGlobalKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        if (searchInputRef.current) {
          e.preventDefault();
          searchInputRef.current.focus();
        }
      }
    }
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  if (!channel) return null;

  return (
    <div className={styles.main}>
      {/* Channel header */}
      <div className={styles.channelHeader}>
        <h2 className={styles.channelHeaderName}># {channel.name}</h2>
        {channel.topic && (
          <p className={styles.channelHeaderTopic}>{channel.topic}</p>
        )}
        {channel.linkedPage && (
          <p className={styles.channelHeaderLink}>
            Linked page:{' '}
            <Link to={channel.linkedPage}>{channel.linkedPage}</Link>
          </p>
        )}
      </div>

      {/* Search bar */}
      {messages.length > 0 && (
        <div className={styles.searchBar}>
          <input
            ref={searchInputRef}
            className={styles.searchInput}
            type="text"
            placeholder="Search messages... (Cmd+F)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <span className={styles.searchCount}>
              {messages.filter((msg) =>
                msg.text.toLowerCase().includes(searchQuery.toLowerCase()),
              ).length}{' '}
              of {messages.length} messages
            </span>
          )}
        </div>
      )}

      {/* Pinned messages section */}
      {(() => {
        const pinnedMsgs = messages.filter((m) => pinnedIds.includes(m.id));
        if (pinnedMsgs.length === 0) return null;
        return (
          <div className={styles.pinnedSection}>
            <div className={styles.pinnedHeader}>
              <span className={styles.pinnedIcon}>&#128204;</span>
              <span className={styles.pinnedLabel}>
                {pinnedMsgs.length} pinned message{pinnedMsgs.length > 1 ? 's' : ''}
              </span>
            </div>
            {pinnedMsgs.map((msg) => (
              <div key={msg.id} className={styles.pinnedMessage}>
                <div className={styles.pinnedMessageContent}>
                  <span className={styles.pinnedMessageAuthor}>{msg.author}</span>
                  <span className={styles.pinnedMessageText}>{msg.text}</span>
                </div>
                <button
                  className={styles.unpinBtn}
                  onClick={() => unpinMessage(msg.id)}
                  title="Unpin message"
                  aria-label="Unpin message"
                >
                  &#10005;
                </button>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Messages area */}
      <div className={styles.messagesArea} ref={messagesAreaRef} role="log" aria-label="Message history" aria-live="polite">
        {messages.length === 0 && (
          <div className={styles.emptyMessages}>
            <div className={styles.emptyIcon}>#</div>
            <span>
              This is the start of <strong>#{channel.name}</strong>
            </span>
            <span style={{fontSize: '0.85rem'}}>
              Send a message to begin the conversation.
            </span>
          </div>
        )}
        {(searchQuery
          ? messages.filter((msg) =>
              msg.text.toLowerCase().includes(searchQuery.toLowerCase()),
            )
          : messages
        ).map((msg) => (
          <div key={msg.id} className={styles.messageGroup}>
            <div className={styles.avatar}>{getInitial(msg.author)}</div>
            <div className={styles.messageContent}>
              <div>
                <span className={styles.messageAuthor}>{msg.author}</span>
                <span className={styles.messageTime}>
                  {formatTime(msg.createdAt)}
                </span>
              </div>
              {editingMsg === msg.id ? (
                <div className={styles.editArea}>
                  <input
                    className={styles.editInput}
                    type="text"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') editMessage(msg.id); if (e.key === 'Escape') { setEditingMsg(null); setEditText(''); } }}
                    autoFocus
                  />
                  <div style={{display: 'flex', gap: 4, marginTop: 4}}>
                    <button className={styles.editSaveBtn} onClick={() => editMessage(msg.id)}>Save</button>
                    <button className={styles.editCancelBtn} onClick={() => { setEditingMsg(null); setEditText(''); }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className={styles.messageText}>
                  {searchQuery ? highlightText(msg.text, searchQuery) : msg.text}
                  {msg.editedAt && <span className={styles.editedTag}>(edited)</span>}
                </div>
              )}
            </div>
            <div className={styles.messageActions}>
              <button
                className={styles.pinBtn}
                onClick={() =>
                  pinnedIds.includes(msg.id)
                    ? unpinMessage(msg.id)
                    : pinMessage(msg.id)
                }
                title={pinnedIds.includes(msg.id) ? 'Unpin message' : 'Pin message'}
                aria-label={pinnedIds.includes(msg.id) ? 'Unpin message' : 'Pin message'}
              >
                {pinnedIds.includes(msg.id) ? '\u{1F4CC}' : '\u{1F4CC}'}
              </button>
              <button
                className={styles.pinBtn}
                onClick={() => { setEditingMsg(msg.id); setEditText(msg.text); }}
                title="Edit message"
                aria-label="Edit message"
              >
                &#9998;
              </button>
              <button
                className={styles.deleteMessageBtn}
                onClick={() => deleteMessage(msg.id)}
                title="Delete message"
                aria-label="Delete message"
              >
                &times;
              </button>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className={styles.inputArea}>
        {error && <p className={styles.error}>{error}</p>}
        <form onSubmit={handleSend}>
          <div className={styles.inputRow}>
            <input
              className={styles.authorInput}
              type="text"
              placeholder="Name"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              disabled={sending}
            />
            <textarea
              className={styles.messageInput}
              placeholder={`Message #${channel.name}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={sending}
              rows={1}
              aria-label={`Message input for #${channel.name}`}
            />
            <button
              className={styles.sendBtn}
              type="submit"
              disabled={sending || !text.trim()}
            >
              {sending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
