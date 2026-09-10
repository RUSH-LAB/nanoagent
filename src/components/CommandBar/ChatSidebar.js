import React, {useState} from 'react';
import {copyLink} from '@site/src/utils/invite';
import styles from './rail.module.css';

export function channelLabel(channel) {
  if (!channel) return '';
  if (channel.kind !== 'dm') return `#${channel.name}`;
  return channel.peerUsername || channel.peerName || 'Someone';
}

const personLabel = person => person.username || person.name || person.email || 'Someone';

const STATUS_NOTE = {
  loading: 'Loading conversations…',
  'signed-out': 'Sign in to chat',
  'no-organization': 'No workspace yet',
};

function Icon({name}) {
  const common = {width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round'};
  if (name === 'message') return <svg {...common}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /></svg>;
  if (name === 'add-person') return <svg {...common}><path d="M15 21a7 7 0 0 0-14 0M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M16 11h6" /></svg>;
  return null;
}

/** The shared visual identity used by both the sidebar and an open pane. */
export function ConversationIcon({agent = null, channel = null, person = null, label = ''}) {
  if (agent) {
    return (
      <span className={`${styles.agentAvatar} ${styles[`agent_${agent.color || 'violet'}`]}`} aria-hidden="true">
        {agent.name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  if (person || channel?.kind === 'dm') {
    const name = person ? personLabel(person) : (channelLabel(channel) || label);
    return (
      <span className={styles.personAvatar} aria-hidden="true">
        {name.slice(0, 1).toUpperCase()}<i className={styles.onlineDot} />
      </span>
    );
  }
  if (!channel) return <span className={`${styles.convoIcon} ${styles.emptyIcon}`} aria-hidden="true">+</span>;
  return <span className={styles.convoIcon} aria-hidden="true">#</span>;
}

function Unread({count}) {
  if (!count) return null;
  return <span className={styles.unread}>{count > 99 ? '99+' : count}</span>;
}

function Section({title, count, browseLabel, browseText = 'Manage', onBrowse, onAdd, addLabel, children}) {
  return (
    <section className={styles.section}>
      <div className={styles.group}>
        <span className={styles.groupName}>{title}</span>
        <span className={styles.groupCount}>{count}</span>
        <span className={styles.groupTools}>
          {onBrowse && <button type="button" className={styles.manageAction} onClick={onBrowse} aria-label={browseLabel}>{browseText}</button>}
          {onAdd && <button type="button" className={styles.addAction} onClick={onAdd} aria-label={addLabel}>+</button>}
        </span>
      </div>
      {children}
    </section>
  );
}

export default function ChatSidebar({
  chat,
  agents,
  agentsStatus,
  agentsError,
  activeChannelId,
  activeAgentId,
  onSelect,
  onSelectAgent,
  onOpenAgentChat,
  onCreateAgent,
  onEditAgent,
  onEditChannel,
  onEditPerson,
  onBrowsePeople,
  onBrowseChannels,
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [inviting, setInviting] = useState(false);
  const [invitee, setInvitee] = useState('');
  const [failure, setFailure] = useState(null);
  const [notice, setNotice] = useState(null);
  const [addingPersonId, setAddingPersonId] = useState(null);
  const [managingAgents, setManagingAgents] = useState(false);

  const submitChannel = async (event) => {
    event.preventDefault();
    const name = draft.trim();
    if (!name) return;
    try {
      const channelId = await chat.createChannel(name);
      setCreating(false);
      setDraft('');
      setFailure(null);
      onSelect(channelId, `#${name}`);
    } catch (err) { setFailure(err.message); }
  };

  const submitInvite = async (event) => {
    event.preventDefault();
    const email = invitee.trim();
    if (!email) return;
    try {
      const invitation = await chat.invite(email);
      const {copied} = await copyLink(invitation.id);
      setInviting(false);
      setInvitee('');
      setFailure(null);
      setNotice(copied ? `Invite copied for ${email}` : 'Invite ready in People');
    } catch (err) { setNotice(null); setFailure(err.message); }
  };

  const openPerson = async (person) => {
    const existingId = person.you
      ? chat.channels.find(channel => channel.kind === 'dm' && channel.selfDm)?.id
      : person.dmChannelId;
    if (existingId) return onSelect(existingId, personLabel(person));
    try {
      onSelect(await chat.openDm(person.id), personLabel(person));
      setFailure(null);
    } catch (err) { setFailure(err.message); }
  };

  const addToActiveChannel = async (person, channel) => {
    setAddingPersonId(person.id);
    setFailure(null);
    setNotice(null);
    try {
      const result = await chat.addMember(channel.id, person.id);
      setNotice(result.added
        ? `Added ${personLabel(person)} to #${channel.name}`
        : `${personLabel(person)} is already in #${channel.name}`);
    } catch (err) {
      setFailure(err.message);
    } finally {
      setAddingPersonId(null);
    }
  };

  const note = STATUS_NOTE[chat.status] ?? (chat.status === 'error' ? chat.error : null);
  const dmChannels = new Map(chat.channels.filter(channel => channel.kind === 'dm').map(channel => [channel.id, channel]));
  const allPeople = chat.members ?? chat.people;
  const activeChannel = chat.channels.find(channel => (
    channel.id === activeChannelId
    && channel.kind !== 'dm'
    && channel.joined
    && !channel.archivedAt
  )) ?? null;
  const canEditAgents = chat.status === 'ready' && chat.you?.role !== 'viewer';

  return (
    <nav className={styles.sidebar} aria-label="Conversations">
      <div className={styles.scroll}>
        <Section
          title="Agents"
          count={agents.length}
          onBrowse={canEditAgents ? () => setManagingAgents(value => !value) : null}
          browseLabel={managingAgents ? 'Finish managing agents' : 'Manage agents'}
          browseText={managingAgents ? 'Done' : 'Manage'}
          onAdd={canEditAgents ? onCreateAgent : null}
          addLabel="Create an agent"
        >
          {agents.map(agent => {
            return <div key={agent.id} className={styles.agentGroup}>
              <div className={`${styles.agentRow} ${managingAgents ? styles.agentManaging : ''}`}>
                <button type="button" className={`${styles.convo} ${styles.agentConvo} ${activeAgentId === agent.id ? styles.convoActive : ''}`} onClick={() => onSelectAgent(agent)} aria-current={activeAgentId === agent.id} title={agent.description || agent.name}>
                  <ConversationIcon agent={agent} />
                  <span className={styles.convoBody}><span className={styles.convoName}>{agent.name}</span></span>
                </button>
                <span className={styles.agentTools}>
                  <button type="button" className={styles.openAgentChat} onClick={() => onOpenAgentChat(agent)} aria-label={`Open chat with ${agent.name}`} title="Open chat">
                    <Icon name="message" />
                  </button>
                  {canEditAgents && <button type="button" className={styles.editAgent} onClick={() => onEditAgent(agent)} aria-label={`Edit ${agent.name}`}>•••</button>}
                </span>
              </div>
            </div>
          })}
          {agentsStatus === 'loading' && <p className={styles.sidebarNote}>Loading agents…</p>}
          {agentsStatus === 'error' && <p className={styles.sidebarFailure}>{agentsError}</p>}
        </Section>

        <Section title="Channels" count={chat.channels.filter(channel => channel.kind !== 'dm').length} onBrowse={onBrowseChannels} browseLabel="Manage channels" onAdd={() => { setCreating(value => !value); setFailure(null); }} addLabel="New channel">
          {creating && <form className={styles.inlineForm} onSubmit={submitChannel}><span>#</span><input value={draft} onChange={event => setDraft(event.target.value)} placeholder="channel-name" autoFocus aria-label="New channel name" /></form>}
          {chat.channels.filter(channel => channel.kind !== 'dm').map(channel => (
            <div key={channel.id} className={styles.channelRow}>
              <button type="button" className={`${styles.convo} ${styles.channelConvo} ${channel.id === activeChannelId ? styles.convoActive : ''}`} onClick={() => onSelect(channel.id, channelLabel(channel))} aria-current={channel.id === activeChannelId}>
                <ConversationIcon channel={channel} />
                <span className={styles.convoBody}><span className={styles.convoName}>{channel.name}</span></span>
                <Unread count={channel.unread} />
              </button>
              <span className={styles.agentTools}>
                <button type="button" className={styles.openAgentChat} onClick={() => onSelect(channel.id, channelLabel(channel))} aria-label={`Open #${channel.name}`} title="Open channel">
                  <Icon name="message" />
                </button>
                {onEditChannel && (
                  <button type="button" className={styles.editAgent} onClick={() => onEditChannel(channel)} aria-label={`Settings for #${channel.name}`} title="Channel settings">•••</button>
                )}
              </span>
            </div>
          ))}
        </Section>

        <Section title="People" count={allPeople.length} onBrowse={onBrowsePeople} browseLabel="Manage people" onAdd={chat.you?.canManage ? () => { setInviting(value => !value); setFailure(null); } : null} addLabel="Invite someone">
          {inviting && <form className={styles.inlineForm} onSubmit={submitInvite}><span>@</span><input type="email" value={invitee} onChange={event => setInvitee(event.target.value)} placeholder="email" autoFocus aria-label="Email address to invite" /></form>}
          {allPeople.map(person => {
            const selfDm = person.you ? chat.channels.find(channel => channel.kind === 'dm' && channel.selfDm) : null;
            const dm = selfDm || (person.dmChannelId ? dmChannels.get(person.dmChannelId) : null);
            const dmChannelId = dm?.id || person.dmChannelId;
            const label = personLabel(person);
            return (
              <div key={person.id} className={styles.personRow}>
                <button type="button" className={`${styles.convo} ${styles.personConvo} ${activeChannel && !person.you ? styles.personConvoWide : ''} ${dmChannelId === activeChannelId ? styles.convoActive : ''}`} onClick={() => openPerson(person)} aria-current={dmChannelId === activeChannelId}>
                  <ConversationIcon person={person} />
                  <span className={styles.convoBody}><span className={styles.convoName}>{label}</span></span>
                  <Unread count={dm?.unread} />
                </button>
                <span className={styles.personActions}>
                  {!person.you && activeChannel && (
                    <button type="button" onClick={() => addToActiveChannel(person, activeChannel)} disabled={addingPersonId === person.id} aria-label={`Add ${label} to #${activeChannel.name}`} title={`Add to #${activeChannel.name}`}>
                      <Icon name="add-person" />
                    </button>
                  )}
                  <button type="button" onClick={() => openPerson(person)} aria-label={`Message ${label} privately`} title="Private message">
                    <Icon name="message" />
                  </button>
                  {onEditPerson && (
                    <button type="button" className={styles.personSettings} onClick={() => onEditPerson(person)} aria-label={`Settings for ${label}`} title="Person settings">•••</button>
                  )}
                </span>
              </div>
            );
          })}
        </Section>

        {note && <p className={styles.sidebarNote}>{note}</p>}
        {notice && <p className={styles.sidebarNotice}>{notice}</p>}
        {failure && <p className={styles.sidebarFailure}>{failure}</p>}
      </div>
    </nav>
  );
}
