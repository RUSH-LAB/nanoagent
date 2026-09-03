import React, {useEffect, useMemo, useState} from 'react';
import {ConversationIcon} from './ChatSidebar';
import styles from './agentChatsDialog.module.css';

const messageCount = chat => chat.entries.filter(entry => entry.kind === 'input' || entry.kind === 'output').length;

export default function AgentChatsDialog({agent, chats, onOpen, onNew, onRename, onDelete, onClose}) {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [title, setTitle] = useState('');
  const [confirmingId, setConfirmingId] = useState(null);

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? chats.filter(chat => chat.title.toLocaleLowerCase().includes(needle))
      : chats;
  }, [chats, query]);

  const beginRename = chat => {
    setEditingId(chat.id);
    setTitle(chat.title);
    setConfirmingId(null);
  };

  const submitRename = event => {
    event.preventDefault();
    if (onRename(editingId, title)) setEditingId(null);
  };

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="agent-chats-title">
        <header className={styles.header}>
          <ConversationIcon agent={agent} />
          <div className={styles.heading}>
            <span>Agent workspace</span>
            <h2 id="agent-chats-title">{agent.name}</h2>
          </div>
          <button type="button" className={styles.newChat} onClick={onNew}>New chat</button>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close chat manager">&times;</button>
        </header>

        <div className={styles.toolbar}>
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search chats"
            aria-label={`Search ${agent.name} chats`}
            autoFocus
          />
          <span>{chats.length} chat{chats.length === 1 ? '' : 's'}</span>
        </div>

        <div className={styles.list}>
          {visible.map(chat => (
            <article key={chat.id} className={styles.row}>
              {editingId === chat.id ? (
                <form className={styles.rename} onSubmit={submitRename}>
                  <input
                    value={title}
                    onChange={event => setTitle(event.target.value)}
                    maxLength={60}
                    aria-label="Chat title"
                    autoFocus
                  />
                  <button type="submit" disabled={!title.trim()}>Save</button>
                  <button type="button" onClick={() => setEditingId(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  <button type="button" className={styles.open} onClick={() => onOpen(chat)}>
                    <strong>{chat.title}</strong>
                    <span>{messageCount(chat)} messages</span>
                  </button>
                  <div className={styles.actions}>
                    <button type="button" onClick={() => beginRename(chat)}>Rename</button>
                    <button
                      type="button"
                      className={confirmingId === chat.id ? styles.confirmDelete : ''}
                      onClick={() => {
                        if (confirmingId === chat.id) onDelete(chat.id);
                        else setConfirmingId(chat.id);
                      }}
                    >
                      {confirmingId === chat.id ? 'Delete?' : 'Delete'}
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
          {!visible.length && (
            <p className={styles.empty}>{chats.length ? 'No chats match this search.' : 'No chats yet.'}</p>
          )}
        </div>
      </section>
    </div>
  );
}
