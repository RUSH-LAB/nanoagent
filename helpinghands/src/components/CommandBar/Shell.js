import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useHistory} from '@docusaurus/router';
import {toast} from '@site/src/components/Toast/toast';
import {scopeWorkspacePath} from '@site/src/utils/workspaces';
import AgentEditor from './AgentEditor';
import AgentChatsDialog from './AgentChatsDialog';
import AgentChatPicker from './AgentChatPicker';
import AssistantTranscript from './AssistantTranscript';
import ChannelEditor from './ChannelEditor';
import ChannelMembers from './ChannelMembers';
import ChatSidebar, {channelLabel, ConversationIcon} from './ChatSidebar';
import ChatTranscript from './ChatTranscript';
import Completions, {optionId} from './Completions';
import LiveLine from './LiveLine';
import Composer from './Composer';
import TargetPicker from './TargetPicker';
import Markdown from './Markdown';
import PersonEditor from './PersonEditor';
import SelectionCapture from './SelectionCapture';
import {parseCommand, resolveCommand, runCommand} from './commandRuntime';
import {liveItem, newestEntryId} from './liveItem';
import {formatSharedSelection, isSelectionContextShortcut, selectionContextFrom, sourceLocationFromRange} from './selectionContext';
import useAssistant from './useAssistant';
import useAgents from './useAgents';
import useChat from './useChat';
import useCompletion from './useCompletion';
import useGeometry from './useGeometry';
import usePinnedScroll from './usePinnedScroll';
import useSessions, {entriesForTarget} from './useSessions';
import useUnreadTitle from './useUnreadTitle';
import {onOpenConversation} from './openConversation';
import {VERBS} from './verbs';
import shared from './shared.module.css';
import styles from './shell.module.css';

/**
 * The CLI docked to the bottom of every page.
 *
 * A real window: open at its remembered height from page load, resizable by
 * dragging its top edge, minimisable to the single prompt line. Minimised it
 * stays one line, typed into and sent from in place, which says what is going
 * on (liveItem.js) and who it talks to (TargetPicker.js); only its open button
 * makes it a window again. It can be split into up to four sessions side by
 * side, each with its own transcript and its own in-flight request and
 * composer, so one can be waiting on a reply while you type into another.
 *
 * A pane is pointed at something, chosen in the rail on the left: the assistant,
 * a channel, or a direct message. That target is per pane, not per window, so a
 * split can hold a conversation beside the assistant and one prompt serves
 * whichever pane has focus. In an agent chat, `/` offers only the model and
 * harness selectors; anything else is either an agent turn or a message posted
 * to the selected channel.
 *
 * This file is composition and nothing else. Every piece of state lives in one
 * of the hooks beside it, every piece of markup in one of the components, and
 * what is left here is the wiring between them: which hook answers which
 * component, and what a typed line means. Anything in this file that did
 * arithmetic or spoke to the network would belong in a hook instead.
 *
 * One constraint on everything under this component: the CLI is mounted above
 * the router and outside LayoutProvider, so the Docusaurus theme hooks
 * (useColorMode, useScrollController, useNavbarMobileSidebar,
 * useAnnouncementBar) will throw here. Light and dark are decided in CSS.
 */

/**
 * The rows a channel pane has of its own: what the CLI said back.
 *
 * A pane on the assistant shows one thing, and AssistantTranscript shows it. A
 * pane on a channel shows two: the conversation, which belongs to everybody in
 * it, and this, which belongs to nobody but the reader. Local command feedback
 * and refusals are not posted, so they cannot go in the shared transcript and
 * are rendered here instead.
 *
 * It sits under the conversation and outside its scroll box, so the newest
 * thing the CLI said is on screen wherever the reader has scrolled the
 * conversation to, and it collapses to nothing when there is nothing to say,
 * which is almost always. An answer is rendered as markdown for the same reason
 * the assistant's is: it is the one row written by something that speaks it.
 */
function LocalOutput({rows, label, scrollProps}) {
  return (
    <div
      className={styles.paneLocal}
      {...scrollProps}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-label={label ? `${label} command output` : 'Command output'}
    >
      {rows.map((entry) => (entry.kind === 'output' ? (
        // An answer is rewritten in place as it streams, and a live region
        // would narrate it a token at a time. The finished row is announced by
        // the rows around it having stopped moving.
        <div key={entry.id} className={`${shared.entry} ${shared.output}`} aria-live="off">
          <Markdown text={entry.text} />
        </div>
      ) : (
        <div key={entry.id} className={`${shared.entry} ${shared[entry.kind]}`}>
          {entry.kind === 'input' && <span className={shared.entryMark}>&#9656;</span>}
          <span className={shared.entryText}>{entry.text}</span>
        </div>
      )))}
    </div>
  );
}

function WindowControls({railOpen, onRailOpenChange, onCollapse, onSplit, splitDisabled, maxSessions}) {
  return (
    <div className={styles.windowControls} aria-label="Window controls">
      <button type="button" onClick={onCollapse} aria-label="Minimise the command bar" title="Minimise">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      <button type="button" onClick={() => onRailOpenChange(!railOpen)} aria-label="Hide conversations" title="Hide conversations">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="9" y1="4" x2="9" y2="20" /></svg>
      </button>
      <button type="button" onClick={onSplit} disabled={splitDisabled} aria-label="Split into another session" title={splitDisabled ? `Limit is ${maxSessions} sessions` : 'Split (⌘D)'}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="12" y1="4" x2="12" y2="20" /></svg>
      </button>
    </div>
  );
}

/** One pane: its header, whichever transcript it is showing, and its refusals. */
function Pane({
  session, index, count, label, agent, currentChat, agentChats, channel, person, isActive, conversation, youId,
  onFocus, onClose, onLoadOlder, onDeleteMessage, onCancel, onStartChat, onCreateAgent,
  onOpenChat, onManageChats, onManageMembers,
}) {
  const heading = channel && channel.kind !== 'dm' ? channel.name : (label || 'Choose a chat');
  const working = Boolean(session.busy || session.sending);

  // Whichever of these a pane has, a new one arriving is a new line at the
  // bottom, and the busy row is a line too.
  const visibleEntries = useMemo(
    () => entriesForTarget(session.entries, session.target),
    [session.entries, session.target],
  );
  const visibleSession = useMemo(
    () => ({...session, entries: visibleEntries}),
    [session, visibleEntries],
  );
  const pinned = usePinnedScroll([visibleEntries, conversation?.messages, session.busy]);

  // Only a channel pane has output of its own to place: on the assistant these
  // same entries are the transcript. An answer whose first token has not
  // arrived is not a row yet, exactly as AssistantTranscript treats it, and
  // dropping it here is also what lets the box disappear when the pane has
  // nothing to show.
  const onChannel = Boolean(conversation);
  const localRows = useMemo(
    () => (onChannel ? visibleEntries.filter((e) => !(e.pending && !e.text)) : []),
    [onChannel, visibleEntries],
  );
  const localPinned = usePinnedScroll([localRows]);

  return (
    <section
      className={`${styles.pane} ${isActive ? styles.paneActive : ''}`}
      onMouseDown={onFocus}
      aria-label={count > 1 ? `Session ${index + 1}: ${heading}` : heading}
    >
      <header className={styles.paneHead}>
        <ConversationIcon agent={agent} channel={channel} person={person} label={label} />
        {agent ? (
          <AgentChatPicker
            sessionId={session.id}
            agent={agent}
            currentChat={currentChat}
            chats={agentChats}
            onOpen={onOpenChat}
            onNew={onStartChat}
            onManage={onManageChats}
          />
        ) : (
          <span className={styles.paneName}>{heading}</span>
        )}
        {channel?.kind !== 'dm' && channel && (
          <button type="button" className={styles.membersButton} onClick={onManageMembers}>
            Members <span>{channel.memberCount ?? 0}</span>
          </button>
        )}
        <span className={styles.paneStatus}>{working ? 'Working…' : (!conversation && !session.target?.chatId ? (agent ? 'No chat' : 'No agent') : 'Ready')}</span>
        {count > 1 && (
          <button
            type="button"
            className={styles.paneClose}
            onClick={onClose}
            aria-label={`Close session ${index + 1}`}
            title="Close session"
          >
            &times;
          </button>
        )}
      </header>

      {conversation ? (
        <ChatTranscript
          conversation={conversation}
          label={label}
          youId={youId}
          // Keyed on the channel rather than on the label, so a rename does not
          // read as a different conversation and reset the unread anchor.
          channelId={session.target.channelId}
          scrollProps={pinned.scrollProps}
          atBottom={pinned.atBottom}
          onJumpToNewest={() => pinned.scrollToBottom(true)}
          keepAnchor={pinned.keepAnchor}
          onLoadOlder={onLoadOlder}
          onDeleteMessage={onDeleteMessage}
        />
      ) : (
        <AssistantTranscript
          session={visibleSession}
          agent={agent}
          hasChat={Boolean(session.target?.chatId)}
          onStartChat={onStartChat}
          onCreateAgent={onCreateAgent}
          scrollProps={pinned.scrollProps}
          atBottom={pinned.atBottom}
          onJumpToNewest={() => pinned.scrollToBottom(true)}
          onCancel={onCancel}
        />
      )}

      {localRows.length > 0 && (
        <LocalOutput rows={localRows} label={label} scrollProps={localPinned.scrollProps} />
      )}

      {/* A refused message belongs under the conversation it was meant for, not
          in it: nothing was posted. The line itself goes back to the composer,
          where it can be fixed and sent again. */}
      {session.sendError && (
        <div className={`${shared.entry} ${shared.error}`}>
          <span className={shared.entryText}>{session.sendError}</span>
        </div>
      )}
    </section>
  );
}

export default function Shell({workspaceKey = 'unscoped'}) {
  const routerHistory = useHistory();
  const geometry = useGeometry();
  const sessions = useSessions(workspaceKey);
  const agentStore = useAgents();
  const {active} = sessions;

  const [drafts, setDrafts] = useState({});
  // undefined means closed; null means the create form; an object means edit.
  const [agentEditor, setAgentEditor] = useState(undefined);
  const [chatManagerAgentId, setChatManagerAgentId] = useState(null);
  const [channelEditor, setChannelEditor] = useState(null);
  const [personEditor, setPersonEditor] = useState(null);
  const [memberChannel, setMemberChannel] = useState(null);
  const inputRefs = useRef(new Map());

  const inputRefFor = useCallback((sessionId) => {
    if (!inputRefs.current.has(sessionId)) inputRefs.current.set(sessionId, {current: null});
    return inputRefs.current.get(sessionId);
  }, []);

  const draftFor = useCallback((sessionId) => drafts[sessionId] ?? '', [drafts]);
  const setDraftFor = useCallback((sessionId, next) => {
    setDrafts((current) => {
      const value = typeof next === 'function' ? next(current[sessionId] ?? '') : next;
      return {...current, [sessionId]: value};
    });
  }, []);
  const draft = draftFor(active.id);
  const setDraft = useCallback((next) => setDraftFor(active.id, next), [active.id, setDraftFor]);

  // Only the channels on screen are worth polling, and a channel open in two
  // panes is still one conversation.
  const openChannelIds = useMemo(
    () => Array.from(new Set(sessions.sessions.map((s) => s.target?.channelId).filter(Boolean))),
    [sessions.sessions],
  );
  const chat = useChat({openChannelIds, paused: geometry.collapsed});
  const assistant = useAssistant(sessions);
  useUnreadTitle(chat.unreadTotal);

  const commands = VERBS;
  // Runtime selection applies only while a pane has an open AI chat.
  const menuCommands = useMemo(
    () => VERBS.filter((verb) => !verb.when || verb.when({session: active})),
    [active],
  );

  /* ── The window ───────────────────────────────────────────────── */

  // Either way the line keeps the caret: the minimised row and the window's
  // composer are different elements, so it is handed to whichever is drawn.
  const setCollapsed = useCallback((next) => {
    geometry.setCollapsed(next);
    requestAnimationFrame(() => inputRefFor(active.id).current?.focus());
  }, [geometry.setCollapsed, active.id, inputRefFor]);

  const split = useCallback(() => {
    // At the limit nothing happens at all, including to a minimised window.
    if (sessions.split() !== null) setCollapsed(false);
  }, [sessions.split, setCollapsed]);

  // The shortcut inserts the same readable text that Copy as context puts on
  // the clipboard. It remains ordinary editable text, so several selections
  // can live in one draft instead of competing for one attachment slot.
  useEffect(() => {
    const attachSelection = (event) => {
      if (!isSelectionContextShortcut(event)) return;
      const selected = window.getSelection();
      const range = selected?.rangeCount ? selected.getRangeAt(0) : null;
      const context = selectionContextFrom(selected, {
        title: document.title,
        path: window.location.pathname,
        url: window.location.href,
        ...sourceLocationFromRange(range),
      });
      if (!context) return;

      event.preventDefault();
      setDraftFor(active.id, current => formatSharedSelection(current, context));
      requestAnimationFrame(() => inputRefFor(active.id).current?.focus());
    };

    window.addEventListener('keydown', attachSelection);
    return () => window.removeEventListener('keydown', attachSelection);
  }, [active.id, inputRefFor, setDraftFor]);

  /* ── Targets ──────────────────────────────────────────────────── */

  /**
   * Point the focused pane at a human conversation or an existing AI chat. It
   * leaves the window as it is: the minimised line's picker retargets in place,
   * and anything that means to show the conversation opens the window itself.
   */
  const retarget = useCallback((target) => {
    sessions.setTarget(active.id, target);
    requestAnimationFrame(() => inputRefFor(active.id).current?.focus());
  }, [active.id, sessions.setTarget, inputRefFor]);

  const selectChannel = useCallback(
    (channelId, label) => {
      // The Agent turn belongs to the pane being left. Stop it so a hidden
      // response cannot keep the human-chat composer busy in the background.
      if (active.target?.agentId && active.busy) assistant.cancel(active.id);
      retarget({channelId, label});
    },
    [active.id, active.busy, active.target, assistant.cancel, retarget],
  );

  // The people directory is a page, not a part of this component, so it asks
  // rather than reaches in. A person arrives as a userId, which is a dm that
  // may not exist yet; a channel arrives ready to open.
  useEffect(() => onOpenConversation(async ({channelId, userId, label}) => {
    try {
      selectChannel(channelId ?? await chat.openDm(userId), label);
      setCollapsed(false);
    } catch {
      // The directory reports its own failures; the CLI simply does not move.
    }
  }), [chat, selectChannel, setCollapsed]);

  /** A person's direct message, made the first time it is asked for; yours is the one with yourself. */
  const selectPerson = useCallback(async (person) => {
    try {
      const dm = chat.channels.find(channel => channel.kind === 'dm'
        && (person.you ? channel.selfDm : channel.id === person.dmChannelId));
      selectChannel(dm?.id ?? await chat.openDm(person.id), person.username || person.name || 'Someone');
    } catch (err) {
      toast.error(err.message);
    }
  }, [chat, selectChannel]);

  /**
   * The name of what a pane is pointed at. Read from the directory rather than
   * from the pane, so a channel that has since been renamed, or a dm opened
   * before its peer was known, is labelled with what is true now; the label
   * stored on the target is the fallback for the moment before the directory
   * has caught up.
   */
  const labelOf = useCallback((session) => {
    if (!session.target) return null;
    if (session.target.chatId) {
      return sessions.chats.find(chatItem => chatItem.id === session.target.chatId)?.title
        || session.target.label
        || 'Chat';
    }
    if (session.target.agentId) {
      return agentStore.agents.find(agent => agent.id === session.target.agentId)?.name
        || session.target.label
        || 'Agent';
    }
    const channel = chat.channels.find((c) => c.id === session.target.channelId);
    return channel ? channelLabel(channel) : session.target.label;
  }, [chat.channels, agentStore.agents, sessions.chats]);

  const agentOf = useCallback(
    (session) => session.target?.agentId
      ? agentStore.agents.find(agent => agent.id === session.target.agentId) ?? null
      : null,
    [agentStore.agents],
  );

  const chatOf = useCallback(
    (session) => session.target?.chatId
      ? sessions.chats.find(chatItem => chatItem.id === session.target.chatId) ?? null
      : null,
    [sessions.chats],
  );

  const openChat = useCallback((chatToOpen, sessionId = active.id) => {
    const alreadyOpen = sessions.sessions.find(session => session.target?.chatId === chatToOpen.id);
    if (alreadyOpen) {
      sessions.focus(alreadyOpen.id);
      requestAnimationFrame(() => inputRefFor(alreadyOpen.id).current?.focus());
      return;
    }
    sessions.setTarget(sessionId, {
      chatId: chatToOpen.id,
      agentId: chatToOpen.agentId,
      label: chatToOpen.title,
    });
    sessions.focus(sessionId);
    requestAnimationFrame(() => inputRefFor(sessionId).current?.focus());
  }, [active.id, sessions.sessions, sessions.focus, sessions.setTarget, inputRefFor]);

  const selectAgent = useCallback((agent) => {
    const recentChat = sessions.chats.find(chatItem => chatItem.agentId === agent.id);
    if (recentChat) openChat(recentChat);
    else retarget({agentId: agent.id, label: agent.name});
  }, [sessions.chats, openChat, retarget]);

  // Creating a chat is always an explicit click on New chat or on an agent.
  // Selection capture calls openChat instead and can never reach this path.
  const startChat = useCallback((agent = null, sessionId = active.id) => {
    const targetSession = sessions.sessions.find(session => session.id === sessionId) ?? active;
    const selectedAgent = agent || agentOf(targetSession) || agentStore.agents[0];
    if (!selectedAgent) {
      toast.info('Create an agent before starting a chat.');
      return;
    }
    sessions.createChat(sessionId, selectedAgent);
    requestAnimationFrame(() => inputRefFor(sessionId).current?.focus());
  }, [active, agentStore.agents, sessions.sessions, sessions.createChat, inputRefFor, agentOf]);

  // The rail's chat icon behaves like the one beside a person: return to the
  // conversation when one exists, and create the first one only when needed.
  // The explicit New chat control in the pane remains the way to branch into a
  // separate conversation with the same agent.
  const openOrStartAgentChat = useCallback((agent) => {
    const recentChat = sessions.chats.find(chatItem => chatItem.agentId === agent.id);
    if (recentChat) openChat(recentChat);
    else startChat(agent);
  }, [sessions.chats, openChat, startChat]);

  const deleteChat = useCallback((chatId) => {
    sessions.sessions.forEach(session => {
      if (session.target?.chatId === chatId) assistant.cancel(session.id);
    });
    sessions.deleteChat(chatId);
  }, [sessions.sessions, sessions.deleteChat, assistant.cancel]);

  const channelOf = useCallback(
    (session) => session.target?.channelId
      ? chat.channels.find(channel => channel.id === session.target.channelId) ?? null
      : null,
    [chat.channels],
  );

  /* ── Saying and asking ────────────────────────────────────────── */

  /**
   * Post to a pane's channel. A refusal leaves the reason under the pane and
   * hands the line back to the composer, because a message the server would not
   * take is usually one word away from being one it will.
   *
   * A send marks the pane `sending` rather than `busy`, which is the flag an
   * answer from the assistant sets. Both mean the pane is working and both stop
   * a second line being typed over the first, but only one of them can be
   * stopped: there is no controller behind a POST that has already put the
   * message on screen, so a stop button offered here would be a control that
   * does nothing.
   */
  const say = useCallback(async (text, sessionId, target) => {
    const channelId = target.channelId;
    sessions.patch(sessionId, {sending: true, sendError: null});
    try {
      await chat.send(channelId, text);
      sessions.patch(sessionId, {sending: false});
    } catch (err) {
      sessions.patch(sessionId, {sending: false, sendError: err.message});
      setDraftFor(sessionId, (current) => (current === '' ? text : current));
    }
  }, [chat.send, sessions.patch, setDraftFor]);

  /** What a verb is handed: the pane it was typed into, and the ways to answer. */
  const contextFor = useCallback((session) => ({
    session,
    sessions,
    chatItem: chatOf(session),
    agent: agentOf(session),
    ai: agentStore.ai,
    note: (text) => sessions.append(session.id, 'system', text),
    fail: (text) => sessions.append(session.id, 'error', text),
  }), [sessions, chatOf, agentOf, agentStore.ai]);

  const activeCommandContext = useMemo(
    () => contextFor(active),
    [contextFor, active],
  );
  const completion = useCompletion(draft, menuCommands, activeCommandContext);

  /* ── The line ─────────────────────────────────────────────────── */

  const submit = useCallback((session = active) => {
    const sessionDraft = draftFor(session.id);
    const text = sessionDraft.trim();
    if (!text || session.busy || session.sending) return;
    sessions.remember(session.id, text);
    setDraftFor(session.id, '');

    const parsed = parseCommand(text);
    if (!parsed && !session.target?.channelId && (!agentOf(session) || !session.target?.chatId)) {
      sessions.append(session.id, 'error', 'Open or start a chat with this agent first.');
      return;
    }
    if (parsed) {
      // An open option picker owns Enter, including its current first row.
      // Otherwise a deliberately highlighted command wins; plain typing still
      // resolves only exact or unambiguous command names.
      const command = completion.selectingArgument && completion.choice
        ? completion.choice
        : completion.moved
        ? completion.matches[completion.selected]
        : resolveCommand(commands, parsed.verb);
      if (!command) {
        sessions.append(session.id, 'input', text, {command: true});
        sessions.append(session.id, 'error', `unknown command: /${parsed.verb}`);
        return;
      }
      // Echo the chosen option rather than the partial query that found it.
      sessions.append(session.id, 'input', command.commandLine || text, {command: true});
      runCommand(command, command.argument ?? parsed.argLine, contextFor(session));
      return;
    }

    // A command works the same in every pane; a plain line goes wherever the
    // pane is pointed.
    if (session.target?.channelId) say(text, session.id, session.target);
    else {
      const agent = agentOf(session);
      // The chat's /model choice, if it made one.
      assistant.ask(session.id, text, agent, '', chatOf(session)?.modelChoice?.choice ?? null);
    }
  }, [
    active, sessions, commands, draftFor, setDraftFor,
    completion.matches, completion.selected, completion.moved,
    completion.selectingArgument, completion.choice,
    contextFor, say, assistant, agentOf, chatOf,
  ]);

  const runFromMenu = useCallback((command) => {
    if (command.kind === 'argument') {
      const line = command.commandLine;
      setDraft('');
      sessions.remember(active.id, line);
      sessions.append(active.id, 'input', line, {command: true});
      runCommand(command, command.argument, contextFor(active));
      inputRefFor(active.id).current?.focus();
      return;
    }
    setDraft(`/${command.name} `);
    inputRefFor(active.id).current?.focus();
  }, [active, sessions, contextFor, inputRefFor, setDraft]);

  const onVertical = useCallback((delta) => {
    // Down is forward through the completion list and forward through history,
    // which for a shell means back towards the line being composed.
    if (completion.isCommand) {
      completion.move(delta);
      return;
    }
    const line = sessions.recall(active.id, -delta);
    if (line !== null) setDraft(line);
  }, [completion, sessions, active.id]);

  const onTab = useCallback(() => {
    const accepted = completion.isCommand ? completion.accept() : null;
    if (accepted !== null) {
      setDraft(accepted);
      return;
    }
    // No completion to accept, so Tab cycles panes the way a tiling terminal
    // does.
    if (sessions.sessions.length > 1) {
      const index = sessions.sessions.findIndex((s) => s.id === active.id);
      sessions.focusIndex((index + 1) % sessions.sessions.length);
    }
  }, [completion, sessions, active.id]);

  const onEscape = useCallback(() => {
    // First Escape backs out of completion, a second one minimises.
    if (completion.isCommand) setDraft('');
    else if (!geometry.collapsed) setCollapsed(true);
  }, [completion.isCommand, geometry.collapsed, setCollapsed]);

  /* ── The minimised line ───────────────────────────────────────── */

  // How far each pane has been read: the newest entry it held while the window
  // was open. Anything newer arrived while it was shut and is the line's to
  // show. A pane seen for the first time starts read, so a restored transcript
  // is not announced on page load.
  const [seen, setSeen] = useState({});
  useEffect(() => {
    setSeen((previous) => {
      const next = {...previous};
      for (const session of sessions.sessions) {
        if (!geometry.collapsed || next[session.id] === undefined) next[session.id] = newestEntryId(session);
      }
      return sessions.sessions.every(session => next[session.id] === previous[session.id]) ? previous : next;
    });
  }, [sessions.sessions, geometry.collapsed]);

  // Messages put away from the line, by channel, up to the sequence put away.
  // A newer message in the same channel comes back.
  const [dismissed, setDismissed] = useState({});
  const notices = useMemo(
    () => chat.notices.filter(notice => !(dismissed[notice.channel.id] >= notice.seq)),
    [chat.notices, dismissed],
  );

  const live = geometry.collapsed
    ? liveItem({session: active, label: labelOf(active), seenUpTo: seen[active.id] ?? newestEntryId(active), notices})
    : null;
  const othersBusy = geometry.collapsed
    ? sessions.sessions.filter(session => session.id !== active.id && session.busy).length
    : 0;

  // A message opens its conversation; anything else opens the window on the
  // pane it came from.
  const openLive = useCallback((item) => {
    if (item.kind === 'message') selectChannel(item.channel.id, channelLabel(item.channel));
    setCollapsed(false);
  }, [selectChannel, setCollapsed]);

  const dismissLive = useCallback((item) => {
    if (item.kind === 'message') setDismissed(current => ({...current, [item.channel.id]: item.seq}));
    else if (active.sendError) sessions.patch(active.id, {sendError: null});
    else setSeen(current => ({...current, [active.id]: newestEntryId(active)}));
  }, [active, sessions.patch]);

  const activeChannel = channelOf(active);
  const pickerFor = (compact) => (
    <TargetPicker
      compact={compact}
      current={{
        agent: agentOf(active),
        channel: activeChannel,
        person: activeChannel?.kind === 'dm'
          ? (chat.members ?? []).find(member => member.id === activeChannel.peerId) ?? null
          : null,
        label: labelOf(active),
      }}
      agents={agentStore.agents}
      channels={chat.channels}
      // Everyone in the workspace, you included, as the rail lists them.
      people={chat.members ?? []}
      // The line can only talk to an agent in a chat, so picking one opens its chat, or starts it.
      onPickAgent={openOrStartAgentChat}
      onPickChannel={channel => selectChannel(channel.id, channelLabel(channel))}
      onPickPerson={selectPerson}
    />
  );

  /* ── Layout ───────────────────────────────────────────────────── */

  const activeLabel = labelOf(active);
  const activeAgent = agentOf(active);
  const placeholderFor = (session) => {
    const agent = agentOf(session);
    const label = labelOf(session);
    if (agent) return `Ask ${agent.name} anything…`;
    if (label) return `Message ${label}`;
    return session.busy ? 'Waiting for a reply…' : 'Open or start an AI chat';
  };

  // The slash menu draws rows only when something matched and only while the
  // window is open. The composer names those rows by id to a screen reader, so
  // it has to be told the same thing rather than inferring it from the line
  // starting with a slash.
  const listOpen = completion.isCommand && completion.matches.length > 0 && !geometry.collapsed;
  const chatManagerAgent = chatManagerAgentId
    ? agentStore.agents.find(agent => agent.id === chatManagerAgentId) ?? null
    : null;
  const managedChats = chatManagerAgent
    ? sessions.chats.filter(chatItem => chatItem.agentId === chatManagerAgent.id)
    : [];

  return (
    <div
      data-command-bar
      className={`${styles.bar} ${geometry.collapsed ? styles.barCollapsed : ''} ${geometry.dragging ? styles.barDragging : ''}`}
    >
      <SelectionCapture onCopy={() => {
        toast.success('Context copied. Paste it into any conversation.');
      }} />
      {!geometry.collapsed && (
        <>
          <div className={styles.handle} {...geometry.handleProps}>
            <span className={styles.grip} />
          </div>

          <div className={styles.body} style={geometry.bodyStyle}>
            <div className={styles.workspace}>
              {geometry.railOpen && (
                <ChatSidebar
                  chat={chat}
                  agents={agentStore.agents}
                  agentsStatus={agentStore.status}
                  agentsError={agentStore.error}
                  activeChannelId={active.target?.channelId ?? null}
                  activeAgentId={active.target?.agentId ?? null}
                  onSelect={selectChannel}
                  onSelectAgent={selectAgent}
                  onOpenAgentChat={openOrStartAgentChat}
                  onCreateAgent={() => setAgentEditor(null)}
                  onEditAgent={setAgentEditor}
                  onEditChannel={setChannelEditor}
                  onEditPerson={setPersonEditor}
                  onBrowsePeople={() => routerHistory.push(scopeWorkspacePath(
                    '/settings#people',
                    typeof window === 'undefined' ? '' : window.location.pathname,
                  ))}
                  onBrowseChannels={() => routerHistory.push(scopeWorkspacePath(
                    '/channels',
                    typeof window === 'undefined' ? '' : window.location.pathname,
                  ))}
                />
              )}

              <div className={styles.panes}>
                {sessions.sessions.map((session, i) => (
                  <Pane
                    key={session.id}
                    session={session}
                    index={i}
                    count={sessions.sessions.length}
                    label={labelOf(session)}
                    agent={agentOf(session)}
                    currentChat={chatOf(session)}
                    agentChats={sessions.chats.filter(chatItem => chatItem.agentId === session.target?.agentId)}
                    channel={channelOf(session)}
                    // A direct message wears the face of whoever it is with.
                    person={channelOf(session)?.kind === 'dm'
                      ? (chat.members ?? []).find(member => member.id === channelOf(session).peerId) ?? null
                      : null}
                    isActive={session.id === active.id}
                    conversation={session.target?.channelId ? chat.conversation(session.target.channelId) : null}
                    youId={chat.you?.userId ?? null}
                    onFocus={() => sessions.focus(session.id)}
                    // Closing a pane hangs up on whatever it was waiting for.
                    // The answer had nowhere left to go, and the route only
                    // stops the provider when the client disconnects, so
                    // without this the work continues for nobody. Cancelling
                    // after the close is deliberate: the last pane refuses to
                    // close and has to keep its answer.
                    onClose={() => {
                      if (sessions.close(session.id)) {
                        assistant.cancel(session.id);
                        inputRefs.current.delete(session.id);
                        setDrafts((current) => {
                          const next = {...current};
                          delete next[session.id];
                          return next;
                        });
                      }
                    }}
                    onLoadOlder={() => chat.loadOlder(session.target.channelId)}
                    onDeleteMessage={chat.deleteMessage}
                    onCancel={() => assistant.cancel(session.id)}
                    onStartChat={agentStore.agents.length ? () => startChat(null, session.id) : null}
                    onCreateAgent={() => setAgentEditor(null)}
                    onOpenChat={(chatItem) => openChat(chatItem, session.id)}
                    onManageChats={() => setChatManagerAgentId(session.target?.agentId ?? null)}
                    onManageMembers={() => setMemberChannel(channelOf(session))}
                  />
                ))}
              </div>
            </div>

            {completion.isCommand && (
              <Completions
                matches={completion.matches}
                selected={completion.selected}
                query={draft}
                dragging={geometry.dragging}
                onHover={completion.setSelected}
                onRun={runFromMenu}
              />
            )}

            {agentEditor !== undefined && (
              <AgentEditor
                agent={agentEditor}
                onSave={agentStore.save}
                onDelete={async (id) => {
                  await agentStore.remove(id);
                  sessions.removeChatsForAgent(id);
                  sessions.sessions.forEach((session) => {
                    if (session.target?.agentId === id) sessions.setTarget(session.id, null);
                  });
                }}
                onClose={() => setAgentEditor(undefined)}
              />
            )}

            {chatManagerAgent && (
              <AgentChatsDialog
                agent={chatManagerAgent}
                chats={managedChats}
                onOpen={(chatItem) => {
                  openChat(chatItem);
                  setChatManagerAgentId(null);
                }}
                onNew={() => {
                  startChat(chatManagerAgent);
                  setChatManagerAgentId(null);
                }}
                onRename={sessions.renameChat}
                onDelete={deleteChat}
                onClose={() => setChatManagerAgentId(null)}
              />
            )}

            {memberChannel && (
              <ChannelMembers
                channel={memberChannel}
                people={chat.members ?? []}
                youId={chat.you?.userId ?? null}
                chat={chat}
                onClose={() => setMemberChannel(null)}
              />
            )}

            {channelEditor && (
              <ChannelEditor
                channel={channelEditor}
                chat={chat}
                onClose={() => setChannelEditor(null)}
              />
            )}

            {personEditor && (
              <PersonEditor
                person={personEditor}
                chat={chat}
                onClose={() => setPersonEditor(null)}
              />
            )}
          </div>
        </>
      )}

      {geometry.collapsed ? (
        // The open window's columns, so the field is the same width either way:
        // the rail's column holds the open button and who the line talks to.
        <div className={styles.composerDock} ref={geometry.rowRef}>
          {geometry.railOpen && (
            <div className={styles.windowControls}>
              <button type="button" onClick={() => setCollapsed(false)} aria-label="Open the command bar" title="Open">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 15 12 9 18 15" /></svg>
              </button>
              {pickerFor(false)}
            </div>
          )}
          <div className={styles.composerPanes}>
            <div className={styles.composerCell}>
              <Composer
                inputRef={inputRefFor(active.id)}
                inputId={`command-bar-input-${active.id}`}
                instanceId={active.id}
                value={draft}
                onChange={setDraft}
                placeholder={placeholderFor(active)}
                ghost={completion.ghost}
                isCommand={completion.isCommand}
                collapsed
                onCollapsedChange={setCollapsed}
                railOpen={geometry.railOpen}
                onRailOpenChange={geometry.setRailOpen}
                onSplit={split}
                splitDisabled={sessions.sessions.length >= sessions.MAX_SESSIONS}
                maxSessions={sessions.MAX_SESSIONS}
                sessionNumber={sessions.sessions.length > 1 ? sessions.sessions.findIndex((session) => session.id === active.id) + 1 : null}
                targetLabel={activeLabel}
                onSubmit={() => submit(active)}
                onClear={() => sessions.clear(active.id)}
                onTab={onTab}
                onVertical={onVertical}
                onEscape={onEscape}
                people={chat.people}
                channels={chat.channels}
                busy={Boolean(active.busy || active.sending)}
                canSend={Boolean(active.target?.channelId || (activeAgent && active.target?.chatId))}
                onCancel={active.busy ? () => assistant.cancel(active.id) : null}
                onFocusPane={sessions.focusIndex}
                listOpen={false}
                showChrome={!geometry.railOpen}
                lead={geometry.railOpen ? null : pickerFor(true)}
                live={(
                  <LiveLine
                    item={live}
                    othersBusy={othersBusy}
                    onOpen={openLive}
                    onDismiss={dismissLive}
                    onStop={() => assistant.cancel(active.id)}
                  />
                )}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.composerDock} ref={geometry.rowRef}>
          {geometry.railOpen && (
            <WindowControls
              railOpen={geometry.railOpen}
              onRailOpenChange={geometry.setRailOpen}
              onCollapse={() => setCollapsed(true)}
              onSplit={split}
              splitDisabled={sessions.sessions.length >= sessions.MAX_SESSIONS}
              maxSessions={sessions.MAX_SESSIONS}
            />
          )}
          <div className={styles.composerPanes}>
            {sessions.sessions.map((session, index) => {
              const isActive = session.id === active.id;
              const sessionDraft = draftFor(session.id);
              const sessionAgent = agentOf(session);
              return (
                <div
                  key={session.id}
                  className={`${styles.composerCell} ${isActive ? styles.composerCellActive : ''}`}
                  onMouseDown={() => sessions.focus(session.id)}
                >
                  <Composer
                    inputRef={inputRefFor(session.id)}
                    inputId={`command-bar-input-${session.id}`}
                    instanceId={session.id}
                    value={sessionDraft}
                    onChange={(next) => setDraftFor(session.id, next)}
                    placeholder={placeholderFor(session)}
                    ghost={isActive ? completion.ghost : ''}
                    isCommand={isActive ? completion.isCommand : sessionDraft.trimStart().startsWith('/')}
                    collapsed={false}
                    onCollapsedChange={setCollapsed}
                    railOpen={geometry.railOpen}
                    onRailOpenChange={geometry.setRailOpen}
                    onSplit={split}
                    splitDisabled={sessions.sessions.length >= sessions.MAX_SESSIONS}
                    maxSessions={sessions.MAX_SESSIONS}
                    sessionNumber={sessions.sessions.length > 1 ? index + 1 : null}
                    targetLabel={labelOf(session)}
                    onSubmit={() => submit(session)}
                    onClear={() => sessions.clear(session.id)}
                    onTab={onTab}
                    onVertical={onVertical}
                    onEscape={onEscape}
                    people={chat.people}
                    channels={chat.channels}
                    busy={Boolean(session.busy || session.sending)}
                    canSend={Boolean(session.target?.channelId || (sessionAgent && session.target?.chatId))}
                    onCancel={session.busy ? () => assistant.cancel(session.id) : null}
                    onFocusPane={sessions.focusIndex}
                    listOpen={isActive && listOpen}
                    completionId={isActive && listOpen ? optionId(completion.selected) : null}
                    onActivate={() => sessions.focus(session.id)}
                    showChrome={!geometry.railOpen && index === 0}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
