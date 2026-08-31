import React, {useState} from 'react';
import {copyLink} from '@site/src/utils/invite';
import styles from './rail.module.css';

/**
 * The CLI's left rail: everything you can be talking to.
 *
 * One list, three kinds of entry. The assistant is first because it is what the
 * prompt does when nothing else is selected. Then the organization's channels,
 * then its people, where clicking someone opens the direct message with them,
 * creating it on the first click and finding it on every one after.
 *
 * Selecting an entry retargets the focused pane, so a split window can hold a
 * channel, a direct message and the assistant side by side, each with its own
 * scrollback. The rail draws the selection of the focused pane only.
 */

/** How a channel is written in the rail and at the prompt. */
export function channelLabel(channel) {
  if (!channel) return '';
  if (channel.kind !== 'dm') return `#${channel.name}`;
  return `@${channel.peerUsername || channel.peerName || 'someone'}`;
}

/**
 * How a person is written before a dm with them exists.
 *
 * The final fallback matters: a row with no username, no name and no email
 * would otherwise read `@undefined` at whoever is looking. verbs.js keeps its
 * own copy of this, spelled the same way, because that module has to stay
 * loadable by `node --test` and this one is JSX. Not exported for the same
 * reason; the two spellings must agree, not import each other.
 */
const personLabel = person => `@${person.username || person.name || person.email || 'someone'}`;

/** Why there is nothing to show, said the way the rail says it. */
const STATUS_NOTE = {
  loading: 'loading…',
  'signed-out': 'sign in to chat',
  'no-organization': 'no organization yet',
};

function Unread({count}) {
  if (!count) return null;
  return <span className={styles.unread}>{count > 99 ? '99+' : count}</span>;
}

export default function ChatSidebar({
  chat, activeChannelId, onSelect, onSelectAssistant, onBrowsePeople, onBrowseChannels,
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [inviting, setInviting] = useState(false);
  const [invitee, setInvitee] = useState('');
  // What the last thing the rail did came to: the reason it was refused, or
  // the one line it has room to report. Shown at the foot of the rail.
  const [failure, setFailure] = useState(null);
  const [notice, setNotice] = useState(null);

  const submitChannel = async (e) => {
    e.preventDefault();
    const name = draft.trim();
    if (!name) return;
    try {
      const channelId = await chat.createChannel(name);
      setCreating(false);
      setDraft('');
      setFailure(null);
      onSelect(channelId, `#${name}`);
    } catch (err) {
      // The form stays open, holding the name that was refused.
      setFailure(err.message);
    }
  };

  /**
   * Invite an address, and put the link on the clipboard.
   *
   * The rail is one column of names wide, which is nowhere to show a URL, so
   * the useful thing to do with a fresh invitation here is copy it. When the
   * browser refuses the clipboard, the directory is where the link can be read
   * instead, and that is what the note says.
   */
  const submitInvite = async (e) => {
    e.preventDefault();
    const email = invitee.trim();
    if (!email) return;
    try {
      const invitation = await chat.invite(email);
      const {copied} = await copyLink(invitation.id);
      setInviting(false);
      setInvitee('');
      setFailure(null);
      setNotice(copied ? `invited ${email}, link copied` : `invited ${email}, link in People`);
    } catch (err) {
      setNotice(null);
      setFailure(err.message);
    }
  };

  const openPerson = async (person) => {
    // The dm is known when one already exists, so the common case selects
    // without a round trip and only a first conversation costs a request.
    if (person.dmChannelId) {
      onSelect(person.dmChannelId, personLabel(person));
      return;
    }
    try {
      onSelect(await chat.openDm(person.id), personLabel(person));
      setFailure(null);
    } catch (err) {
      setFailure(err.message);
    }
  };

  const note = STATUS_NOTE[chat.status] ?? (chat.status === 'error' ? chat.error : null);
  // A dm's unread count lives on the channel, and the rail draws the person.
  const dmChannels = new Map(chat.channels.filter(c => c.kind === 'dm').map(c => [c.id, c]));

  return (
    <nav className={styles.sidebar} aria-label="Conversations">
      <button
        type="button"
        className={`${styles.convo} ${activeChannelId === null ? styles.convoActive : ''}`}
        onClick={onSelectAssistant}
        aria-current={activeChannelId === null}
      >
        <span className={styles.convoMark}>~</span>
        <span className={styles.convoName}>mochi ai</span>
      </button>

      <div className={styles.group}>
        <span className={styles.groupName}>channels</span>
        {/* The rail holds the conversations you are in. Everything else about
            a channel, including the ones you are not in, is the directory. */}
        <button
          type="button"
          className={styles.groupAction}
          onClick={onBrowseChannels}
          aria-label="Open the channel directory"
          title="Browse, rename, and archive channels"
        >
          &rarr;
        </button>
        <button
          type="button"
          className={styles.groupAction}
          onClick={() => { setCreating(v => !v); setFailure(null); }}
          disabled={chat.status !== 'ready'}
          aria-label="New channel"
          title="New channel"
        >
          +
        </button>
      </div>

      {creating && (
        <form className={styles.newChannel} onSubmit={submitChannel}>
          <span className={styles.convoMark}>#</span>
          <input
            className={styles.newChannelInput}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Stops here rather than reaching the prompt's handler, which
              // would read Escape as "minimise the window".
              e.stopPropagation();
              if (e.nativeEvent?.isComposing) return;
              if (e.key === 'Escape') { setCreating(false); setDraft(''); setFailure(null); }
            }}
            placeholder="name"
            autoFocus
            spellCheck={false}
            aria-label="New channel name"
          />
        </form>
      )}

      {chat.channels.filter(c => c.kind !== 'dm').map(channel => (
        <button
          key={channel.id}
          type="button"
          className={`${styles.convo} ${channel.id === activeChannelId ? styles.convoActive : ''}`}
          onClick={() => onSelect(channel.id, channelLabel(channel))}
          aria-current={channel.id === activeChannelId}
          title={channel.topic || undefined}
        >
          {/* One character of mark per kind, so the names stay in a column:
              # anyone here may read it, * members only, @ a person. */}
          <span className={styles.convoMark}>{channel.kind === 'private' ? '*' : '#'}</span>
          <span className={styles.convoName}>{channel.name}</span>
          <Unread count={channel.unread} />
        </button>
      ))}
      {chat.status === 'ready' && !chat.channels.some(c => c.kind !== 'dm') && (
        <p className={styles.sidebarNote}>no channels yet</p>
      )}

      <div className={styles.group}>
        <span className={styles.groupName}>people</span>
        {/* The rail lists who you can talk to; the directory is where you see
            who they are and, if you may, change it. */}
        <button
          type="button"
          className={styles.groupAction}
          onClick={onBrowsePeople}
          aria-label="Open the people directory"
          title="Everyone in the organization"
        >
          &rarr;
        </button>
        {/* The counterpart of the channels +: that one makes somewhere to talk,
            this one makes someone to talk to. Only for those who may invite. */}
        {chat.you?.canManage && (
          <button
            type="button"
            className={styles.groupAction}
            onClick={() => { setInviting(v => !v); setFailure(null); setNotice(null); }}
            disabled={chat.status !== 'ready'}
            aria-label="Invite someone"
            title="Invite someone by email"
          >
            +
          </button>
        )}
      </div>

      {inviting && (
        <form className={styles.newChannel} onSubmit={submitInvite}>
          <span className={styles.convoMark}>@</span>
          <input
            className={styles.newChannelInput}
            type="email"
            value={invitee}
            onChange={e => setInvitee(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.nativeEvent?.isComposing) return;
              if (e.key === 'Escape') { setInviting(false); setInvitee(''); setFailure(null); }
            }}
            placeholder="email"
            autoFocus
            spellCheck={false}
            aria-label="Email address to invite"
          />
        </form>
      )}

      {chat.people.map((person) => {
        const dm = person.dmChannelId ? dmChannels.get(person.dmChannelId) : null;
        return (
          <button
            key={person.id}
            type="button"
            className={`${styles.convo} ${person.dmChannelId === activeChannelId ? styles.convoActive : ''}`}
            onClick={() => openPerson(person)}
            aria-current={person.dmChannelId === activeChannelId}
            title={person.name || undefined}
          >
            <span className={styles.convoMark}>@</span>
            <span className={styles.convoName}>{person.username || person.name}</span>
            <Unread count={dm?.unread} />
          </button>
        );
      })}
      {chat.status === 'ready' && chat.people.length === 0 && (
        <p className={styles.sidebarNote}>nobody else here yet</p>
      )}

      {note && <p className={styles.sidebarNote}>{note}</p>}
      {notice && <p className={styles.sidebarNote}>{notice}</p>}
      {failure && <p className={styles.sidebarFailure}>{failure}</p>}
    </nav>
  );
}
