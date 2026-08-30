import React from 'react';
import styles from './styles.module.css';

/**
 * One conversation inside a pane: the messages, and the reason there are none.
 *
 * The same scroll box the assistant's transcript uses, so a pane looks the same
 * whichever it is showing and the parent can pin both to their newest line
 * through one ref.
 */

/**
 * Wall-clock time, which is all a line of chat needs.
 *
 * Twenty-four hour whatever the locale says, because this is a fixed column in
 * a monospace window and a trailing AM or PM would push every message over by
 * three characters to say something the neighbouring lines already imply.
 */
function timeOf(iso) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ''
    : at.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hour12: false});
}

export default function ChatTranscript({conversation, label, innerRef}) {
  const {messages, loading, error} = conversation;

  return (
    <div className={styles.transcript} ref={innerRef}>
      {error && <div className={`${styles.entry} ${styles.error}`}><span className={styles.entryText}>{error}</span></div>}

      {messages.length === 0 && !error && (
        <div className={styles.banner}>
          {loading ? 'loading…' : `${label} is empty — say something`}
        </div>
      )}

      {messages.map(message => (
        <div key={message.id} className={styles.message}>
          <span className={styles.messageTime}>{timeOf(message.createdAt)}</span>
          <span className={styles.messageAuthor}>{message.username || message.name}</span>
          {/* A deleted message keeps its place in the thread and loses its body,
              so the replies around it still make sense. */}
          {message.body === null
            ? <span className={`${styles.entryText} ${styles.system}`}>message deleted</span>
            : <span className={styles.entryText}>{message.body}</span>}
        </div>
      ))}
    </div>
  );
}
