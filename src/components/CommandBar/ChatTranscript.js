import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import shared from './shared.module.css';
import styles from './transcript.module.css';

/**
 * One conversation inside a pane: the messages, and everything a reader needs
 * to make sense of them.
 *
 * A flat list of lines is not a conversation. Without a day rule, a message
 * from last Tuesday sits against one from a minute ago and both read as now.
 * Without author grouping, a person saying four things in a row looks like
 * four people. Without a mark for where reading stopped, coming back to a busy
 * channel means guessing. Without a way back through history, the channel
 * began fifty messages ago. Each of those is one small structure over the same
 * list, and together they are the difference between a log and a chat client.
 *
 * The unread divider is the one piece of state this file freezes. It is worked
 * out once, the first time the conversation reports where the reader stopped,
 * and then held: opening a channel marks it read within a tick or two, so a
 * divider recomputed on every render would slide down the transcript and out
 * of it while the reader was still looking at it. A frozen mark is the only
 * one that answers the question it was asked.
 *
 * The scroll box is a live region. New lines are announced as they arrive,
 * additions only, so a screen reader is never made to sit through the history
 * again because one message landed. The region goes quiet while a whole page
 * of it lands, though: opening a conversation, retargeting the pane and paging
 * backwards all insert history the reader asked for, and reading it out as if
 * it had just been said is the same noise from the other direction.
 *
 * The pane owns the scrolling and hands it down: whether the reader is at the
 * bottom is a property of the pane, not of the conversation, and the same
 * decision has to hold for an assistant pane too. Paging backwards is the same
 * ownership from the other end, which is why `keepAnchor` arrives as a prop
 * rather than being reinvented here.
 */

/* ── Constants ──────────────────────────────────────────────────── */

/** Two messages from one author closer together than this read as one turn. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** How near the top of the box counts as asking for the previous page. */
const NEAR_TOP_PX = 80;

/** How long the delete button stays armed before it forgets it was pressed. */
const CONFIRM_MS = 3000;

/* ── Time ───────────────────────────────────────────────────────── */

/**
 * Wall-clock time, which is all a line of chat needs.
 *
 * Twenty-four hour whatever the locale says, because this is a fixed column in
 * a monospace window and a trailing AM or PM would push every message over by
 * three characters to say something the neighbouring lines already imply.
 */
function timeOf(at) {
  return at.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hour12: false});
}

/** A calendar day in local time. Two messages share a day when these match. */
function dayKeyOf(at) {
  return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
}

/**
 * What the day rule says. The two recent days are named rather than dated,
 * because "Today" is what the reader would have called it, and everything
 * older gets a date with the year only when it is not this one.
 */
function dayLabelOf(at, now) {
  if (dayKeyOf(at) === dayKeyOf(now)) return 'Today';
  // Stepped by date rather than by 24 hours, so the day either side of a
  // daylight-saving change is still one day away.
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKeyOf(at) === dayKeyOf(yesterday)) return 'Yesterday';
  return at.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : {year: 'numeric'}),
  });
}

/** The highest sequence in a page, ignoring the optimistic rows that have none. */
function newestSeqOf(messages) {
  let newest = 0;
  for (const message of messages) {
    if (typeof message.seq === 'number' && message.seq > newest) newest = message.seq;
  }
  return newest;
}

/* ── Rows ───────────────────────────────────────────────────────── */

/**
 * A day rule: a centred label with a hairline running out to both margins.
 *
 * The label is repeated as an accessible name because `separator` is one of
 * ARIA's children-presentational roles: the span inside is pruned from the
 * accessibility tree, and a separator takes its name from the author or has
 * none at all. Without this the rule reads as an anonymous divider and the day
 * is lost, since a message row carries only its time.
 */
function DayRule({label}) {
  return (
    <div className={styles.separator} role="separator" aria-label={label}>
      <span className={styles.separatorLabel}>{label}</span>
    </div>
  );
}

/**
 * One message. The author column is kept but emptied when this message
 * continues a run, so the text of a run still starts on one vertical line.
 */
function Message({message, at, grouped, mine, confirming, onDelete}) {
  const author = message.username || message.name || 'unknown';
  return (
    <div className={`${shared.entry} ${styles.messageRow} ${message.pending ? styles.messagePending : ''}`}>
      <span className={styles.messageTime}>{at ? timeOf(at) : ''}</span>
      <span className={styles.messageAuthor} title={author}>{grouped ? '' : author}</span>

      {/* A deleted message keeps its place in the thread and loses its body,
          so the replies around it still make sense. */}
      {message.body === null
        ? <span className={`${shared.entryText} ${shared.system}`}>message deleted</span>
        : <span className={shared.entryText}>{message.body}</span>}

      {/* Deleting is irreversible and the target is one character wide, so the
          button asks once. It is in the flow of the row rather than layered
          over it, so reaching it by keyboard reveals it the same way hovering
          does. */}
      {mine && (
        <button
          type="button"
          className={`${styles.messageDelete} ${confirming ? styles.messageDeleteArmed : ''}`}
          onClick={onDelete}
          aria-label={confirming ? 'Press again to delete this message' : 'Delete this message'}
          title={confirming ? 'Press again to delete' : 'Delete'}
        >
          {confirming ? 'sure?' : '×'}
        </button>
      )}
    </div>
  );
}

/* ── The transcript ─────────────────────────────────────────────── */

export default function ChatTranscript({
  conversation,
  label,
  youId = null,
  channelId = null,
  scrollProps,
  atBottom = true,
  onJumpToNewest,
  keepAnchor,
  onLoadOlder,
  onDeleteMessage,
}) {
  const {
    messages,
    loading,
    loadingOlder = false,
    // Deliberately left undefined when the conversation does not say. Absent
    // is not the same as false here: false is a promise that this is the whole
    // history, and claiming that falsely is a lie the reader cannot check.
    hasMore,
    error,
    lastReadSeq,
  } = conversation;

  // A pane keeps this component mounted when it is pointed somewhere else, so
  // everything below that is per conversation rather than per pane has to be
  // reset against this key. The id when the pane knows it, the label when it
  // does not: both identify a conversation, the id just survives a rename.
  const conversationKey = channelId ?? label;

  /* ── Where reading stopped ────────────────────────────────────── */

  // Frozen on the first render that knows the answer, and never recomputed:
  // the read mark advances the moment this conversation is on screen, so a
  // live divider would walk away from the reader. `undefined` means the
  // conversation has not said yet, `null` means there is nothing to draw.
  const anchor = useRef({key: null, seq: undefined});
  if (anchor.current.key !== conversationKey) anchor.current = {key: conversationKey, seq: undefined};
  if (anchor.current.seq === undefined && lastReadSeq !== undefined) {
    // A null lastReadSeq is a channel the reader never joined, which is not
    // the same as a member who has read nothing: there is no "where you left
    // off" for a room you were never in, so that one gets no divider at all,
    // while a member with a zero mark gets one above the whole history.
    anchor.current.seq = typeof lastReadSeq === 'number' ? lastReadSeq : null;
  }
  const unreadAfter = anchor.current.seq ?? null;

  /* ── How much is below the fold ───────────────────────────────── */

  // Counted as what has arrived since the reader last had the bottom in view,
  // rather than measured against the box. Measuring would mean an offset per
  // row and would still be wrong for the row that is half visible, and the
  // reader's real question is how much they have missed.
  const [seenSeq, setSeenSeq] = useState(0);
  const newestSeq = useMemo(() => newestSeqOf(messages), [messages]);

  useEffect(() => { setSeenSeq(0); }, [conversationKey]);
  // The key is a dependency here as well as above, and has to be: two
  // conversations can have the same newest sequence, and without it switching
  // between them would reset the count and then not seed it again, because
  // from this effect's point of view nothing had changed.
  useEffect(() => {
    if (atBottom) setSeenSeq((prev) => (newestSeq > prev ? newestSeq : prev));
  }, [conversationKey, atBottom, newestSeq]);

  const below = useMemo(
    () => (seenSeq > 0 ? messages.filter((m) => (m.seq ?? 0) > seenSeq).length : 0),
    [messages, seenSeq],
  );

  /* ── Paging backwards ─────────────────────────────────────────── */

  // A scroll event fires per frame, so the request in flight is remembered
  // here rather than being left to `loadingOlder`, which only turns true once
  // the hook has re-rendered.
  const paging = useRef(false);

  const onScroll = useCallback((event) => {
    // The pane's own handler decides whether the transcript is still pinned,
    // and it has to keep running: this one is layered over it, not instead
    // of it.
    scrollProps?.onScroll?.(event);
    if (!onLoadOlder || !hasMore || loadingOlder || paging.current) return;
    if (event.currentTarget.scrollTop > NEAR_TOP_PX) return;
    paging.current = true;
    const hold = keepAnchor ? keepAnchor(() => onLoadOlder()) : onLoadOlder();
    Promise.resolve(hold).catch(() => {}).then(() => { paging.current = false; });
  }, [scrollProps, onLoadOlder, hasMore, loadingOlder, keepAnchor]);

  /* ── What is worth announcing ─────────────────────────────────── */

  // The box is a live region, but a page of history arriving is not news: on
  // open, and again on every retarget, the whole conversation is inserted into
  // an already-registered region and a screen reader would read all of it. So
  // the region is live only for a conversation that has settled, and a bulk
  // insertion happens while it is off.
  //
  // Off has to be decided during the render that causes the insertion, which is
  // why this is derived here rather than in an effect; on has to wait for a
  // later commit, which is why that half is an effect. `liveKey` names the
  // conversation the permission was granted for, so a swap cannot inherit it.
  //
  // Settled deliberately does not ask for a message. An empty channel is
  // finished loading, and the first thing anybody says in it is the one line
  // most worth hearing about.
  const settled = !loading && !loadingOlder;
  const [liveKey, setLiveKey] = useState(null);
  if (liveKey !== null && (liveKey !== conversationKey || !settled)) setLiveKey(null);
  useEffect(() => {
    if (settled) setLiveKey(conversationKey);
  }, [settled, conversationKey]);
  // `null` is the off state, so it never counts as a match even in the corner
  // where a pane has neither an id nor a label to key on.
  const announce = liveKey !== null && liveKey === conversationKey;

  /* ── Deleting ─────────────────────────────────────────────────── */

  const [armed, setArmed] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const disarm = useRef(null);

  useEffect(() => () => clearTimeout(disarm.current), []);

  // A refusal belongs to the conversation it happened in, not to the pane that
  // showed it, so pointing the pane elsewhere clears it.
  useEffect(() => { setDeleteError(null); }, [conversationKey]);

  const requestDelete = useCallback((messageId) => {
    clearTimeout(disarm.current);
    if (armed !== messageId) {
      setArmed(messageId);
      disarm.current = setTimeout(() => setArmed(null), CONFIRM_MS);
      return;
    }
    setArmed(null);
    setDeleteError(null);
    Promise.resolve(onDeleteMessage?.(messageId)).catch((err) => {
      // The row stays where it is, so the reason has to be said out loud or
      // the button simply looks broken. It is drawn under the scroll box, not
      // in it: see the row itself for why.
      setDeleteError(err?.message || 'could not delete that message');
    });
  }, [armed, onDeleteMessage]);

  /* ── Assembly ─────────────────────────────────────────────────── */

  const now = new Date();
  const rows = [];
  let previous = null;
  let previousAt = null;
  let dividerDrawn = false;

  for (const message of messages) {
    const parsed = new Date(message.createdAt);
    const at = Number.isNaN(parsed.getTime()) ? null : parsed;

    // A message with an unreadable timestamp gets no rule of its own: an
    // "Invalid Date" heading would say less than saying nothing.
    const dayChanged = Boolean(at) && (!previousAt || dayKeyOf(at) !== dayKeyOf(previousAt));
    if (dayChanged) rows.push(<DayRule key={`day-${message.id}`} label={dayLabelOf(at, now)} />);

    const startsUnread = !dividerDrawn
      && unreadAfter !== null
      && typeof message.seq === 'number'
      && message.seq > unreadAfter
      // Your own message is never news to you, so the divider steps over it
      // and lands on the first thing somebody else said.
      && message.userId !== youId;
    if (startsUnread) {
      dividerDrawn = true;
      rows.push(
        // Named for the same reason as the day rule: the 'new' caption is
        // pruned along with every other child of a separator.
        <div key={`new-${message.id}`} className={styles.unread} role="separator" aria-label="new messages">
          <span className={styles.unreadLabel}>new</span>
        </div>,
      );
    }

    const grouped = Boolean(
      previous
        && !dayChanged
        && !startsUnread
        && previous.userId === message.userId
        && at && previousAt
        && at.getTime() - previousAt.getTime() < GROUP_WINDOW_MS,
    );

    rows.push(
      <Message
        key={message.id}
        message={message}
        at={at}
        grouped={grouped}
        mine={Boolean(youId) && message.userId === youId && message.body !== null && !message.pending}
        confirming={armed === message.id}
        onDelete={() => requestDelete(message.id)}
      />,
    );

    previous = message;
    previousAt = at;
  }

  return (
    <div className={shared.viewport}>
      <div
        className={shared.transcript}
        {...scrollProps}
        onScroll={onScroll}
        role="log"
        aria-live={announce ? 'polite' : 'off'}
        aria-relevant="additions"
        aria-label={`${label} messages`}
      >
        {error && (
          <div className={`${shared.entry} ${shared.error}`}>
            <span className={shared.entryText}>{error}</span>
          </div>
        )}

        {/* The head of the box is where history reports on itself: still
            arriving, or all of it already here. */}
        {messages.length > 0 && loadingOlder && (
          <div className={shared.banner}>loading earlier messages&hellip;</div>
        )}
        {messages.length > 0 && !loadingOlder && hasMore === false && (
          <div className={shared.banner}>This is the beginning of {label}</div>
        )}

        {messages.length === 0 && !error && (
          <div className={shared.banner}>
            {loading ? 'loading…' : `${label} is empty — say something`}
          </div>
        )}

        {rows}
      </div>

      {/* Under the box rather than in it. Appended to the scrolled content the
          refusal lands below the fold at any scroll offset, including at the
          bottom, because nothing scrolls for it: the pane's scroll effect
          watches messages, not this. Out here it is pinned to the pane the way
          a refused send is (Shell), so the button that looks broken and the
          reason it gave are on screen together. role="alert" because leaving
          the live region above would otherwise have made it silent as well as
          unseen. */}
      {deleteError && (
        <div className={`${shared.entry} ${shared.error} ${styles.deleteError}`} role="alert">
          <span className={shared.entryText}>{deleteError}</span>
        </div>
      )}

      {/* Offered only to a reader who has scrolled away, because for everyone
          else the newest message is already the one they are looking at. The
          control is the shared one: an assistant pane beside this one draws the
          same pill in the same corner, and a reader looking at a split window
          should not have to learn it twice. Only the caption is this pane's
          own, because only a conversation can say how much was missed. */}
      {!atBottom && messages.length > 0 && onJumpToNewest && (
        <button
          type="button"
          className={shared.jump}
          onClick={onJumpToNewest}
          aria-label={below > 0 ? `Jump to ${below} newer messages` : 'Jump to the newest message'}
        >
          {below > 0 ? `${below} new` : 'newest'} <span aria-hidden="true">&darr;</span>
        </button>
      )}
    </div>
  );
}
