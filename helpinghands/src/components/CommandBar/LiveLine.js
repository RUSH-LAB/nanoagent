import React from 'react';
import {channelLabel} from './ChatSidebar';
import styles from './liveLine.module.css';

/**
 * The minimised bar's live slot: the one thing liveItem.js chose, beside the
 * prompt. Clicking it opens the window on it; the button after it stops an
 * answer that is streaming, or puts away anything else. Panes answering out of
 * sight in a split window are counted after it.
 */
export default function LiveLine({item, othersBusy, onOpen, onDismiss, onStop}) {
  if (!item && !othersBusy) return null;

  // In a direct message the newest unread message is always the other person's.
  const who = item?.kind === 'message'
    ? (item.channel.kind === 'dm' ? channelLabel(item.channel) : `${item.author} · ${channelLabel(item.channel)}`)
    : item?.who;

  return (
    <div
      className={styles.live}
      role="status"
      // A streaming answer rewrites itself a few words at a time, and a live
      // region would read every one of them out.
      aria-live={item?.kind === 'streaming' ? 'off' : 'polite'}
    >
      {item && (
        <>
          <button
            type="button"
            className={`${styles.body} ${styles[item.kind]}`}
            onClick={() => onOpen(item)}
            title={item.kind === 'message' ? `Open ${channelLabel(item.channel)}` : 'Open the command bar'}
          >
            {item.kind === 'streaming' && <span className={styles.pulse} aria-hidden="true" />}
            {who && <span className={styles.who}>{who}</span>}
            <span className={styles.text}>{item.text ?? 'Thinking…'}</span>
            {item.more > 0 && <span className={styles.more}>+{item.more}</span>}
          </button>
          {item.kind === 'streaming' ? (
            <button type="button" className={styles.action} onClick={onStop} aria-label="Stop the answer" title="Stop">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            </button>
          ) : (
            <button type="button" className={styles.action} onClick={() => onDismiss(item)} aria-label="Dismiss" title="Dismiss">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          )}
        </>
      )}
      {othersBusy > 0 && (
        <span className={styles.others} title={`${othersBusy} other ${othersBusy === 1 ? 'pane is' : 'panes are'} answering`}>
          {Array.from({length: othersBusy}, (_, i) => <span key={i} className={styles.dot} aria-hidden="true" />)}
          <span className={styles.srOnly}>{othersBusy} other {othersBusy === 1 ? 'pane' : 'panes'} answering</span>
        </span>
      )}
    </div>
  );
}
