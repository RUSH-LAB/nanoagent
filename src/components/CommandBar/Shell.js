import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useHistory} from '@docusaurus/router';
import {useCommands} from '@site/src/components/commands';
import {scopeWorkspacePath} from '@site/src/utils/workspaces';
import AgentEditor from './AgentEditor';
import AssistantTranscript from './AssistantTranscript';
import ChannelMembers from './ChannelMembers';
import ChatSidebar, {channelLabel, ConversationIcon} from './ChatSidebar';
import ChatTranscript from './ChatTranscript';
import Completions, {optionId} from './Completions';
import Composer from './Composer';
import Markdown from './Markdown';
import {parseCommand, resolveCommand, runCommand} from './commandRuntime';
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
 * dragging its top edge, minimisable to the single prompt line. It can be split
 * into up to four sessions side by side, each with its own transcript and its
 * own in-flight request and composer, so one can be waiting on a reply while
 * you type into another.
 *
 * A pane is pointed at something, chosen in the rail on the left: the assistant,
 * a channel, or a direct message. That target is per pane, not per window, so a
 * split can hold a conversation beside the assistant and one prompt serves
 * whichever pane has focus. Typing `/` opens completion over the CLI's verbs
 * and the shared navigation registry in src/components/commands.js whatever the
 * target is; anything else is either a turn with the assistant or a message
 * posted to the selected channel.
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
 * it, and this, which belongs to nobody but the reader. A `/join` confirmation,
 * a refusal, the "type it again within five seconds" that stands between
 * `/kick` and somebody losing their place in a channel, and a whole answer from
 * `/ai`: none of them was posted, so none of them can go in the transcript, and
 * with nowhere else to go they were previously written into state that this
 * pane never drew.
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
  session, index, count, label, agent, channel, isActive, conversation, youId,
  onFocus, onClose, onLoadOlder, onDeleteMessage, onCancel, onCreateAgent, onManageMembers,
}) {
  const heading = label || 'Choose an agent';
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
        <ConversationIcon agent={agent} channel={channel} label={label} />
        <span className={styles.paneName}>{heading}</span>
        {channel?.kind !== 'dm' && channel && (
          <button type="button" className={styles.membersButton} onClick={onManageMembers}>
            Members <span>{channel.memberCount ?? 0}</span>
          </button>
        )}
        <span className={styles.paneStatus}>{working ? 'Working…' : (!conversation && !agent ? 'No agent' : 'Ready')}</span>
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

  // The verbs are the CLI's own and go first; everything the site and its
  // plugins offer is somewhere to go and follows.
  const navigationCommands = useCommands();
  const commands = useMemo(() => [...VERBS, ...navigationCommands], [navigationCommands]);

  // What the menu offers is the smaller list: a verb's `when` says it makes no
  // sense in this pane, and offering /unarchive on a live channel or /kick to
  // somebody who cannot kick is a row that can only end in a refusal. The full
  // list stays behind it for /help and for dispatch, so a hidden verb typed out
  // in full still reaches its own tailored refusal rather than "unknown
  // command". `when` reads the pane and the chat hook and nothing else, which
  // is what makes it callable here, where the command list is still being made.
  const menuCommands = useMemo(
    () => [...VERBS.filter((v) => !v.when || v.when({session: active, chat})), ...navigationCommands],
    [active, chat, navigationCommands],
  );
  const completion = useCompletion(draft, menuCommands);

  /* ── The window ───────────────────────────────────────────────── */

  const setCollapsed = useCallback((next) => {
    geometry.setCollapsed(next);
    if (next) {
      // Drop focus: leaving it on the input means the next click raises no focus
      // event, and the window could not be restored by clicking the prompt.
      inputRefFor(active.id).current?.blur();
    } else {
      requestAnimationFrame(() => inputRefFor(active.id).current?.focus());
    }
  }, [geometry.setCollapsed, active.id, inputRefFor]);

  const split = useCallback(() => {
    // At the limit nothing happens at all, including to a minimised window.
    if (sessions.split() !== null) setCollapsed(false);
  }, [sessions.split, setCollapsed]);

  /* ── Targets ──────────────────────────────────────────────────── */

  /** Point the focused pane at a human conversation or a configured agent. */
  const retarget = useCallback((target) => {
    sessions.setTarget(active.id, target);
    if (geometry.collapsed) setCollapsed(false);
    else inputRefFor(active.id).current?.focus();
  }, [active.id, sessions.setTarget, geometry.collapsed, setCollapsed, inputRefFor]);

  const selectChannel = useCallback(
    (channelId, label) => {
      // The Agent turn belongs to the pane being left. Stop it so a hidden
      // response cannot keep the human-chat composer busy in the background.
      if (active.target?.agentId && active.busy) assistant.cancel(active.id);
      retarget({channelId, label});
    },
    [active.id, active.busy, active.target, assistant.cancel, retarget],
  );

  const selectAgent = useCallback(
    (agent) => retarget({agentId: agent.id, label: agent.name}),
    [retarget],
  );

  // A fresh session opens on the first available agent. There is deliberately
  // no anonymous assistant target: AI conversations always have a defined role.
  useEffect(() => {
    if (agentStore.status !== 'ready' || agentStore.agents.length === 0) return;
    const first = agentStore.agents[0];
    sessions.sessions.forEach((session) => {
      if (!session.target) sessions.setTarget(session.id, {agentId: first.id, label: first.name});
    });
  }, [agentStore.status, agentStore.agents, sessions.sessions, sessions.setTarget]);

  // The people directory is a page, not a part of this component, so it asks
  // rather than reaches in. A person arrives as a userId, which is a dm that
  // may not exist yet; a channel arrives ready to open.
  useEffect(() => onOpenConversation(async ({channelId, userId, label}) => {
    try {
      selectChannel(channelId ?? await chat.openDm(userId), label);
    } catch {
      // The directory reports its own failures; the CLI simply does not move.
    }
  }), [chat, selectChannel]);

  /**
   * The name of what a pane is pointed at. Read from the directory rather than
   * from the pane, so a channel that has since been renamed, or a dm opened
   * before its peer was known, is labelled with what is true now; the label
   * stored on the target is the fallback for the moment before the directory
   * has caught up.
   */
  const labelOf = useCallback((session) => {
    if (!session.target) return null;
    if (session.target.agentId) {
      return agentStore.agents.find(agent => agent.id === session.target.agentId)?.name
        || session.target.label
        || 'Agent';
    }
    const channel = chat.channels.find((c) => c.id === session.target.channelId);
    return channel ? channelLabel(channel) : session.target.label;
  }, [chat.channels, agentStore.agents]);

  const agentOf = useCallback(
    (session) => session.target?.agentId
      ? agentStore.agents.find(agent => agent.id === session.target.agentId) ?? null
      : null,
    [agentStore.agents],
  );

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
  const say = useCallback(async (text, sessionId, channelId) => {
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
    chat,
    assistant,
    commands,
    navigate: (href) => routerHistory.push(scopeWorkspacePath(
      href,
      typeof window === 'undefined' ? '' : window.location.pathname,
    )),
    say: (text) => (session.target?.channelId ? say(text, session.id, session.target.channelId) : undefined),
    note: (text) => sessions.append(session.id, 'system', text),
    fail: (text) => sessions.append(session.id, 'error', text),
  }), [sessions, chat, assistant, commands, routerHistory, say]);

  /* ── The line ─────────────────────────────────────────────────── */

  const submit = useCallback((session = active) => {
    const sessionDraft = draftFor(session.id);
    const text = sessionDraft.trim();
    if (!text || session.busy || session.sending) return;
    sessions.remember(session.id, text);
    setDraftFor(session.id, '');

    const parsed = parseCommand(text);
    if (!parsed && !session.target?.channelId && !agentOf(session)) {
      sessions.append(session.id, 'error', 'Choose or create an agent before starting an AI chat.');
      return;
    }
    if (parsed) {
      // A terminal echoes the line that was typed, arguments and all.
      sessions.append(session.id, 'input', text);
      // Enter runs the verb that was typed, resolved by its name and then by an
      // unambiguous prefix. The ranked list is fuzzy on purpose and admits a
      // typo: `/tpoic` ranks `split` first, and running the top row would run a
      // command the reader never named. A row they picked themselves, with the
      // arrows or the pointer, is a decision rather than a guess, and that one
      // wins over the typing.
      const command = completion.moved
        ? completion.matches[completion.selected]
        : resolveCommand(commands, parsed.verb);
      if (!command) {
        sessions.append(session.id, 'error', `unknown command: /${parsed.verb}`);
        return;
      }
      runCommand(command, parsed.argLine, contextFor(session));
      return;
    }

    // A command works the same in every pane; a plain line goes wherever the
    // pane is pointed.
    if (session.target?.channelId) say(text, session.id, session.target.channelId);
    else assistant.ask(session.id, text, agentOf(session));
  }, [
    active, sessions, commands, draftFor, setDraftFor,
    completion.matches, completion.selected, completion.moved,
    contextFor, say, assistant, agentOf,
  ]);

  const runFromMenu = useCallback((command) => {
    // A click on a row that takes an argument cannot mean "run it with none".
    // For most of them that is an instant refusal, and for /topic an empty line
    // is meaningful: it clears the channel's topic, which nobody asked for by
    // clicking a menu row. So the click does what Tab does, and hands the line
    // back with the cursor where the argument goes.
    if (command.usage) {
      setDraft(`/${command.name} `);
      inputRefFor(active.id).current?.focus();
      return;
    }
    setDraft('');
    sessions.append(active.id, 'input', `/${command.name}`);
    runCommand(command, '', contextFor(active));
  }, [active, sessions, contextFor, inputRefFor]);

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

  /* ── Layout ───────────────────────────────────────────────────── */

  const activeLabel = labelOf(active);
  const activeAgent = agentOf(active);
  const placeholderFor = (session) => {
    const agent = agentOf(session);
    const label = labelOf(session);
    if (agent) return `Ask ${agent.name} anything…`;
    if (label) return `Message ${label}`;
    return session.busy ? 'Waiting for a reply…' : 'Choose an agent to start chatting';
  };

  // The slash menu draws rows only when something matched and only while the
  // window is open. The composer names those rows by id to a screen reader, so
  // it has to be told the same thing rather than inferring it from the line
  // starting with a slash.
  const listOpen = completion.isCommand && completion.matches.length > 0 && !geometry.collapsed;

  return (
    <div
      className={`${styles.bar} ${geometry.collapsed ? styles.barCollapsed : ''} ${geometry.dragging ? styles.barDragging : ''}`}
    >
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
                  onCreateAgent={() => setAgentEditor(null)}
                  onEditAgent={setAgentEditor}
                  onBrowsePeople={() => routerHistory.push(scopeWorkspacePath(
                    '/people',
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
                    channel={channelOf(session)}
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
                    onCreateAgent={() => setAgentEditor(null)}
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
                  sessions.sessions.forEach((session) => {
                    if (session.target?.agentId === id) sessions.setTarget(session.id, null);
                  });
                }}
                onClose={() => setAgentEditor(undefined)}
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
          </div>
        </>
      )}

      {geometry.collapsed ? (
        <Composer
          inputRef={inputRefFor(active.id)}
          inputId={`command-bar-input-${active.id}`}
          instanceId={active.id}
          rowRef={geometry.rowRef}
          value={draft}
          onChange={setDraft}
          placeholder={placeholderFor(active)}
          ghost={completion.ghost}
          isCommand={completion.isCommand}
          busyElsewhere={sessions.sessions.some((session) => session.id !== active.id && (session.busy || session.sending))}
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
          canSend={Boolean(active.target?.channelId || activeAgent)}
          onCancel={active.busy ? () => assistant.cancel(active.id) : null}
          onFocusPane={sessions.focusIndex}
          listOpen={false}
        />
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
                    busyElsewhere={false}
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
                    canSend={Boolean(session.target?.channelId || sessionAgent)}
                    onCancel={session.busy ? () => assistant.cancel(session.id) : null}
                    onFocusPane={sessions.focusIndex}
                    listOpen={isActive && listOpen}
                    completionId={isActive && listOpen ? optionId(completion.selected) : null}
                    onActivate={() => sessions.focus(session.id)}
                    showChrome={!geometry.railOpen && index === 0}
                    showHints={sessions.sessions.length === 1}
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
