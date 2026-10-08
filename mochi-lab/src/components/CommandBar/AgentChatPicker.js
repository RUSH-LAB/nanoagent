import React, {useEffect, useRef, useState} from 'react';
import styles from './agentChatPicker.module.css';

const messageCount = chat => chat.entries.filter(
  entry => entry.kind === 'input' || entry.kind === 'output',
).length;

/** Choose one of an agent's conversations from inside the pane it replaces. */
export default function AgentChatPicker({sessionId, agent, currentChat, chats, onOpen, onNew, onManage}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const dialogId = `agent-chat-picker-${sessionId}`;

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const choose = chat => {
    setOpen(false);
    onOpen(chat);
  };

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.identity}
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-controls={dialogId}
        aria-haspopup="dialog"
        title={`Switch ${agent.name} chat`}
      >
        <span className={styles.agentName}>{agent.name}</span>
        <span className={styles.chatName}>{currentChat?.title || 'Choose a chat'}</span>
        <svg className={styles.chevron} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points={open ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
        </svg>
      </button>

      {open && (
        <div className={styles.menu} id={dialogId} role="dialog" aria-label={`${agent.name} chats`}>
          <div className={styles.head}>
            <span>Chats with {agent.name}</span>
            <button type="button" onClick={() => { setOpen(false); onNew(); }}>New chat</button>
          </div>
          <div className={styles.list}>
            {chats.map(chat => {
              const selected = chat.id === currentChat?.id;
              const count = messageCount(chat);
              return (
                <button
                  key={chat.id}
                  type="button"
                  className={`${styles.row} ${selected ? styles.rowActive : ''}`}
                  onClick={() => choose(chat)}
                  aria-current={selected ? 'true' : undefined}
                >
                  <span className={styles.title}>{chat.title}</span>
                  <span className={styles.meta}>{count} message{count === 1 ? '' : 's'}</span>
                  {selected && <span className={styles.check} aria-hidden="true">&#10003;</span>}
                </button>
              );
            })}
            {!chats.length && <p className={styles.empty}>No previous chats yet.</p>}
          </div>
          {chats.length > 0 && (
            <button type="button" className={styles.manage} onClick={() => { setOpen(false); onManage(); }}>
              Rename or delete chats
            </button>
          )}
        </div>
      )}
    </div>
  );
}
