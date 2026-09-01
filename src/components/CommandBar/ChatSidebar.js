import React, {useState} from 'react';
import {copyLink} from '@site/src/utils/invite';
import styles from './rail.module.css';

export function channelLabel(channel) {
  if (!channel) return '';
  if (channel.kind !== 'dm') return `# ${channel.name}`;
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
  if (name === 'hash') return <svg {...common}><path d="M5 9h14M4 15h14M10 3 8 21M16 3l-2 18" /></svg>;
  if (name === 'message') return <svg {...common}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /></svg>;
  if (name === 'add-person') return <svg {...common}><path d="M15 21a7 7 0 0 0-14 0M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M16 11h6" /></svg>;
  return null;
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
  onCreateAgent,
  onEditAgent,
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
      onSelect(channelId, `# ${name}`);
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
    if (person.dmChannelId) return onSelect(person.dmChannelId, personLabel(person));
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
          {agents.map(agent => (
            <div key={agent.id} className={`${styles.agentRow} ${managingAgents ? styles.agentManaging : ''}`}>
              <button type="button" className={`${styles.convo} ${styles.agentConvo} ${activeAgentId === agent.id ? styles.convoActive : ''}`} onClick={() => onSelectAgent(agent)} aria-current={activeAgentId === agent.id} title={agent.description || agent.name}>
                <span className={`${styles.agentAvatar} ${styles[`agent_${agent.color || 'violet'}`]}`}>{agent.name.slice(0, 1).toUpperCase()}</span>
                <span className={styles.convoBody}><span className={styles.convoName}>{agent.name}</span>{agent.description && <span className={styles.convoMeta}>{agent.description}</span>}</span>
              </button>
              {canEditAgents && <button type="button" className={styles.editAgent} onClick={() => onEditAgent(agent)} aria-label={`Edit ${agent.name}`}>•••</button>}
            </div>
          ))}
          {agentsStatus === 'loading' && <p className={styles.sidebarNote}>Loading agents…</p>}
          {agentsStatus === 'error' && <p className={styles.sidebarFailure}>{agentsError}</p>}
        </Section>

        <Section title="Channels" count={chat.channels.filter(channel => channel.kind !== 'dm').length} onBrowse={onBrowseChannels} browseLabel="Manage channels" onAdd={() => { setCreating(value => !value); setFailure(null); }} addLabel="New channel">
          {creating && <form className={styles.inlineForm} onSubmit={submitChannel}><span>#</span><input value={draft} onChange={event => setDraft(event.target.value)} placeholder="channel-name" autoFocus aria-label="New channel name" /></form>}
          {chat.channels.filter(channel => channel.kind !== 'dm').map(channel => (
            <button key={channel.id} type="button" className={`${styles.convo} ${channel.id === activeChannelId ? styles.convoActive : ''}`} onClick={() => onSelect(channel.id, channelLabel(channel))} aria-current={channel.id === activeChannelId}>
              <span className={styles.convoIcon}><Icon name="hash" /></span>
              <span className={styles.convoBody}><span className={styles.convoName}>{channel.name}</span>{channel.topic && <span className={styles.convoMeta}>{channel.topic}</span>}</span>
              <Unread count={channel.unread} />
            </button>
          ))}
        </Section>

        <Section title="People" count={allPeople.length} onBrowse={onBrowsePeople} browseLabel="Manage people" onAdd={chat.you?.canManage ? () => { setInviting(value => !value); setFailure(null); } : null} addLabel="Invite someone">
          {inviting && <form className={styles.inlineForm} onSubmit={submitInvite}><span>@</span><input type="email" value={invitee} onChange={event => setInvitee(event.target.value)} placeholder="email" autoFocus aria-label="Email address to invite" /></form>}
          {allPeople.map(person => {
            const dm = person.dmChannelId ? dmChannels.get(person.dmChannelId) : null;
            const label = personLabel(person);
            return (
              <div key={person.id} className={styles.personRow}>
                <button type="button" className={`${styles.convo} ${styles.personConvo} ${person.dmChannelId === activeChannelId ? styles.convoActive : ''}`} onClick={() => !person.you && openPerson(person)} disabled={person.you} aria-current={person.dmChannelId === activeChannelId}>
                  <span className={styles.personAvatar}>{label.slice(0, 1).toUpperCase()}<i className={styles.onlineDot} /></span>
                  <span className={styles.convoBody}>
                    <span className={styles.convoName}>{label}{person.you && <span className={styles.youTag}>you</span>}</span>
                    <span className={styles.convoMeta}>{person.role || person.name || 'Workspace member'}</span>
                  </span>
                  <Unread count={dm?.unread} />
                </button>
                {!person.you && (
                  <span className={styles.personActions}>
                    {activeChannel && (
                      <button type="button" onClick={() => addToActiveChannel(person, activeChannel)} disabled={addingPersonId === person.id} aria-label={`Add ${label} to #${activeChannel.name}`} title={`Add to #${activeChannel.name}`}>
                        <Icon name="add-person" />
                      </button>
                    )}
                    <button type="button" onClick={() => openPerson(person)} aria-label={`Message ${label} privately`} title="Private message">
                      <Icon name="message" />
                    </button>
                  </span>
                )}
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
