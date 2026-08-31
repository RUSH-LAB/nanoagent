import React, {useState, useEffect, useRef, useMemo, useCallback} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {useHistory} from '@docusaurus/router';
import API_BASE, { apiFetch } from '@site/src/utils/api';
import {fuzzyMatch} from '@site/src/utils/fuzzyMatch';
import {useCommands, commandHaystack} from '@site/src/components/commands';
import ChatSidebar, {channelLabel} from './ChatSidebar';
import ChatTranscript from './ChatTranscript';
import useChat from './useChat';
import {onOpenConversation} from './openConversation';
import styles from './styles.module.css';

const PROMPT = 'mochi';

/* Pane geometry. The height is the user's to set, so it is remembered across
   visits and clamped to something usable on any viewport. */
const HEIGHT_KEY = 'mochi-cli-height';
const COLLAPSED_KEY = 'mochi-cli-collapsed';
const RAIL_KEY = 'mochi-cli-rail';
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 140;
const maxHeight = () => Math.round(window.innerHeight * 0.8);
const clampHeight = (h) => Math.min(Math.max(h, MIN_HEIGHT), maxHeight());

/* Four columns is where a session gets too narrow to read on a laptop. */
const MAX_SESSIONS = 4;

/* How much transcript rides along as context on a chat turn. The endpoint caps
   context at 50k characters; staying well under that keeps turns cheap. */
const CONTEXT_TURNS = 12;
const CONTEXT_CHARS = 8000;

/**
 * The CLI docked to the bottom of every page.
 *
 * A real window: open at its remembered height from page load, resizable by
 * dragging its top edge, minimisable to the single prompt line. It can be split
 * into up to four sessions side by side, each with its own transcript and its
 * own in-flight request, so one can be waiting on a reply while you type into
 * another. The prompt row is shared and always talks to the focused session.
 *
 * A pane is pointed at something, chosen in the rail on the left: the assistant,
 * a channel, or a direct message. That target is per pane, not per window, so a
 * split can hold a conversation beside the assistant and one prompt serves
 * whichever pane has focus. Typing `/` opens completion over the shared registry
 * in src/components/commands.js whatever the target is; anything else is either
 * a chat turn against POST /api/ai/complete, with that session's recent
 * transcript as context, or a message posted to the selected channel.
 */
function CommandBarInner() {
  const routerHistory = useHistory();
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  // `target` is null for the assistant, or {channelId, label} for a
  // conversation. The label is a fallback for the moment between creating a
  // channel and the directory listing it.
  const [sessions, setSessions] = useState([{id: 1, entries: [], busy: false, target: null, sendError: null}]);
  const [activeId, setActiveId] = useState(1);
  const [railOpen, setRailOpen] = useState(true);

  const inputRef = useRef(null);
  const rowRef = useRef(null);
  const heightRef = useRef(DEFAULT_HEIGHT);
  const transcriptRefs = useRef({});
  const nextSessionId = useRef(2);
  const nextEntryId = useRef(0);
  // Shell-style recall, kept per session so switching panes does not shuffle
  // another conversation's history. -1 means "composing a fresh line".
  const sentRef = useRef({1: []});
  const recallRef = useRef({1: -1});

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];

  // Only the channels on screen are worth polling, and a channel open in two
  // panes is still one conversation.
  const openChannelIds = useMemo(
    () => Array.from(new Set(sessions.map((s) => s.target?.channelId).filter(Boolean))),
    [sessions],
  );
  const chat = useChat({openChannelIds, paused: collapsed});
  // Whatever the installed plugins offer. Not a list in this file any more.
  const commands = useCommands();

  const patchSession = useCallback((sessionId, patch) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? {...s, ...patch} : s)));
  }, []);

  const appendTo = useCallback((sessionId, kind, text) => {
    nextEntryId.current += 1;
    const entry = {id: nextEntryId.current, kind, text};
    setSessions((prev) => prev.map((s) => (
      s.id === sessionId ? {...s, entries: [...s.entries, entry]} : s
    )));
  }, []);

  /* ── Geometry ─────────────────────────────────────────────────── */

  // The rest of the layout sizes itself off --site-cli-height, so publishing the
  // window's real footprint there keeps page padding and --site-shell-height
  // correct without either of them knowing this component exists. Deliberately
  // not updated mid-drag: reflowing the whole document per pointermove is not
  // worth it, so the window floats over the page until the pointer is released.
  const publishFootprint = useCallback((isCollapsed, h) => {
    const root = document.documentElement;
    if (isCollapsed) {
      root.style.removeProperty('--site-cli-height');
    } else {
      root.style.setProperty('--site-cli-height', `calc(var(--site-cli-row) + ${h}px)`);
    }
  }, []);

  useEffect(() => {
    let startCollapsed = false;
    let startHeight = DEFAULT_HEIGHT;
    try {
      startCollapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
      // Shown unless it has been closed, so the conversations are there to be
      // found rather than behind a control nobody knows about.
      setRailOpen(localStorage.getItem(RAIL_KEY) !== '0');
      const saved = Number.parseInt(localStorage.getItem(HEIGHT_KEY), 10);
      if (Number.isFinite(saved)) startHeight = clampHeight(saved);
    } catch {
      /* storage unavailable (private mode); the defaults are fine */
    }
    heightRef.current = startHeight;
    setHeight(startHeight);
    setCollapsed(startCollapsed);
    publishFootprint(startCollapsed, startHeight);
    return () => document.documentElement.style.removeProperty('--site-cli-height');
  }, [publishFootprint]);

  // Shrinking the window must not leave the pane taller than the viewport.
  useEffect(() => {
    const onResize = () => {
      const h = clampHeight(heightRef.current);
      heightRef.current = h;
      setHeight(h);
      publishFootprint(collapsed, h);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [collapsed, publishFootprint]);

  const setCollapsedTo = useCallback((next) => {
    setCollapsed(next);
    publishFootprint(next, heightRef.current);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      /* non-fatal: the state just will not persist */
    }
    if (next) {
      // Drop focus: leaving it on the input means the next click raises no focus
      // event, and the window could not be restored by clicking the prompt.
      inputRef.current?.blur();
    } else {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [publishFootprint]);

  const toggleRail = useCallback((next) => {
    setRailOpen(next);
    try {
      localStorage.setItem(RAIL_KEY, next ? '1' : '0');
    } catch {
      /* non-fatal: the choice just will not persist */
    }
  }, []);

  const startDrag = useCallback((e) => {
    e.preventDefault();
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onDrag = useCallback((e) => {
    if (!dragging) return;
    // The window is anchored to the bottom, so its height is whatever sits
    // between the pointer and the top of the prompt row.
    const row = rowRef.current?.offsetHeight ?? 0;
    const h = clampHeight(window.innerHeight - e.clientY - row);
    heightRef.current = h;
    setHeight(h);
  }, [dragging]);

  const endDrag = useCallback((e) => {
    if (!dragging) return;
    setDragging(false);
    // pointercancel releases capture for us, and releasing twice throws.
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    publishFootprint(collapsed, heightRef.current);
    try {
      localStorage.setItem(HEIGHT_KEY, String(heightRef.current));
    } catch {
      /* non-fatal: the height just will not persist */
    }
  }, [dragging, collapsed, publishFootprint]);

  /* ── Sessions ─────────────────────────────────────────────────── */

  // Both of these decide from the rendered `sessions` rather than from inside a
  // setSessions updater: an updater must stay pure, and React double-invokes it
  // in development, which would allocate two ids per split.
  const split = useCallback(() => {
    if (sessions.length >= MAX_SESSIONS) return;
    const id = nextSessionId.current;
    nextSessionId.current += 1;
    sentRef.current[id] = [];
    recallRef.current[id] = -1;
    setSessions((prev) => [...prev, {id, entries: [], busy: false, target: null, sendError: null}]);
    setActiveId(id);
    setCollapsedTo(false);
  }, [sessions.length, setCollapsedTo]);

  const closeSession = useCallback((id) => {
    if (sessions.length === 1) return;
    const index = sessions.findIndex((s) => s.id === id);
    const next = sessions.filter((s) => s.id !== id);
    delete sentRef.current[id];
    delete recallRef.current[id];
    delete transcriptRefs.current[id];
    setSessions(next);
    // Focus the neighbour that slid into the closed pane's place.
    setActiveId((current) => (current === id ? next[Math.min(index, next.length - 1)].id : current));
  }, [sessions]);

  /* ── Command completion ───────────────────────────────────────── */

  const isCommand = query.startsWith('/');

  const matches = useMemo(() => {
    if (!isCommand) return [];
    const q = query.slice(1).trim();
    if (!q) return commands;
    return commands
      .map((cmd) => ({...cmd, ...fuzzyMatch(q, commandHaystack(cmd))}))
      .filter((cmd) => cmd.match)
      .sort((a, b) => b.score - a.score);
  }, [isCommand, query, commands]);

  // Any edit re-ranks the list, so put the cursor back on the best match.
  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Keep every session pinned to its newest line, not just the focused one, and
  // whether that line was typed here or arrived from a poll.
  useEffect(() => {
    for (const s of sessions) {
      const el = transcriptRefs.current[s.id];
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [sessions, chat.conversation]);

  // Every command is somewhere to go. Splitting and clearing were commands too
  // until the registry was cut back: both have a key of their own, one has a
  // button in the row beside the prompt, and the banner names them, so a third
  // way to reach either was a line in a menu rather than a feature.
  const runCommand = useCallback((cmd, sessionId) => {
    appendTo(sessionId, 'input', `/${cmd.name}`);
    appendTo(sessionId, 'system', `opening ${cmd.title}`);
    routerHistory.push(cmd.href);
  }, [appendTo, routerHistory]);

  /* ── Targets ──────────────────────────────────────────────────── */

  /** Point the focused pane at a conversation, or at the assistant with null. */
  const retarget = useCallback((target) => {
    patchSession(active.id, {target, sendError: null});
    if (collapsed) setCollapsedTo(false);
    else inputRef.current?.focus();
  }, [active.id, patchSession, collapsed, setCollapsedTo]);

  const selectChannel = useCallback(
    (channelId, label) => retarget({channelId, label}),
    [retarget],
  );

  const selectAssistant = useCallback(() => retarget(null), [retarget]);

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
    const channel = chat.channels.find((c) => c.id === session.target.channelId);
    return channel ? channelLabel(channel) : session.target.label;
  }, [chat.channels]);

  /* ── Chat ─────────────────────────────────────────────────────── */

  /** Post to the pane's channel. */
  const say = useCallback(async (text, sessionId, channelId) => {
    patchSession(sessionId, {busy: true, sendError: null});
    try {
      await chat.send(channelId, text);
      patchSession(sessionId, {busy: false});
    } catch (err) {
      patchSession(sessionId, {busy: false, sendError: err.message});
    }
  }, [chat, patchSession]);

  const ask = useCallback(async (text, sessionId, priorEntries) => {
    appendTo(sessionId, 'input', text);
    patchSession(sessionId, {busy: true});
    // Prior turns ride as `context` and the new line as `prompt`, which is the
    // shape the endpoint already composes into a single message.
    const context = priorEntries
      .slice(-CONTEXT_TURNS)
      .map((e) => `${e.kind === 'input' ? 'User' : 'Assistant'}: ${e.text}`)
      .join('\n\n')
      .slice(-CONTEXT_CHARS);
    try {
      const res = await apiFetch(`${API_BASE}/api/ai/complete`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(context ? {prompt: text, context} : {prompt: text}),
      });
      const data = await res.json();
      if (!res.ok) {
        appendTo(sessionId, 'error', data.error || `request failed (${res.status})`);
      } else {
        appendTo(sessionId, 'output', data.text || 'no response generated');
      }
    } catch {
      appendTo(sessionId, 'error', 'could not reach the API server');
    } finally {
      patchSession(sessionId, {busy: false});
    }
  }, [appendTo, patchSession]);

  /* ── Input ────────────────────────────────────────────────────── */

  const submit = useCallback(() => {
    const text = query.trim();
    if (!text || active.busy) return;
    const sessionId = active.id;
    sentRef.current[sessionId] = [...(sentRef.current[sessionId] ?? []), text];
    recallRef.current[sessionId] = -1;
    setQuery('');
    if (text.startsWith('/')) {
      const cmd = matches[selected];
      if (cmd) {
        runCommand(cmd, sessionId);
      } else {
        appendTo(sessionId, 'input', text);
        appendTo(sessionId, 'error', `unknown command: ${text.split(/\s+/)[0]}`);
      }
      return;
    }
    // A command works the same in every pane; a plain line goes wherever the
    // pane is pointed.
    if (active.target) {
      say(text, sessionId, active.target.channelId);
      return;
    }
    ask(text, sessionId, active.entries);
  }, [query, active, matches, selected, runCommand, appendTo, ask, say]);

  const stepRecall = useCallback((delta) => {
    const lines = sentRef.current[active.id] ?? [];
    if (!lines.length) return;
    let next = (recallRef.current[active.id] ?? -1) + delta;
    if (next < -1) next = -1;
    if (next >= lines.length) next = lines.length - 1;
    recallRef.current[active.id] = next;
    setQuery(next === -1 ? '' : lines[lines.length - 1 - next]);
  }, [active.id]);

  const handleKeyDown = useCallback((e) => {
    // A keystroke that is driving an input method belongs to the input method.
    // Enter picks a candidate and the arrows move between them, so reading them
    // here would send half a composed word and shuffle the history doing it.
    if (e.nativeEvent?.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'd') {
      e.preventDefault();
      split();
    } else if (mod && e.key === 'l') {
      e.preventDefault();
      setSessions((prev) => prev.map((s) => (s.id === active.id ? {...s, entries: []} : s)));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (isCommand) setSelected((i) => Math.min(i + 1, matches.length - 1));
      else stepRecall(-1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (isCommand) setSelected((i) => Math.max(i - 1, 0));
      else stepRecall(1);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (isCommand && matches[selected]) {
        setQuery(`/${matches[selected].name}`);
      } else if (sessions.length > 1) {
        // No completion to accept, so Tab cycles panes the way a tiling
        // terminal does.
        const i = sessions.findIndex((s) => s.id === active.id);
        setActiveId(sessions[(i + 1) % sessions.length].id);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // First Escape backs out of completion, a second one minimises.
      if (isCommand) setQuery('');
      else if (!collapsed) setCollapsedTo(true);
    }
  }, [isCommand, matches, selected, sessions, active.id, stepRecall, submit, collapsed, setCollapsedTo, split]);

  // Monospace, so the hidden typed prefix reserves the exact width even when
  // the user's casing differs from the command name's.
  const typedName = isCommand ? query.slice(1) : '';
  const completion = typedName && matches[selected]?.name.startsWith(typedName.toLowerCase())
    ? matches[selected].name.slice(typedName.length)
    : '';

  const busyElsewhere = sessions.some((s) => s.id !== active.id && s.busy);

  const activeLabel = labelOf(active);
  const placeholder = activeLabel
    ? `message ${activeLabel}`
    : (active.busy ? 'waiting for a reply…' : 'ask anything, or / for commands');

  return (
    <>
      <div
        className={`${styles.bar} ${collapsed ? styles.barCollapsed : ''} ${dragging ? styles.barDragging : ''}`}
      >
        {!collapsed && (
          <>
            <div
              className={styles.handle}
              onPointerDown={startDrag}
              onPointerMove={onDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize the command bar"
              title="Drag to resize"
            >
              <span className={styles.grip} />
            </div>

            <div className={styles.body} style={{height}}>
              <div className={styles.workspace}>
                {railOpen && (
                  <ChatSidebar
                    chat={chat}
                    activeChannelId={active.target?.channelId ?? null}
                    onSelect={selectChannel}
                    onSelectAssistant={selectAssistant}
                    onBrowsePeople={() => routerHistory.push('/people')}
                    onBrowseChannels={() => routerHistory.push('/channels')}
                  />
                )}

                <div className={styles.panes}>
                  {sessions.map((session, i) => {
                    const isActive = session.id === active.id;
                    const label = labelOf(session);
                    // The header carries the pane's number, its target, or
                    // both, and is worth the line only when it has something
                    // to say: one pane on the assistant needs no caption.
                    const heading = [sessions.length > 1 ? `session ${i + 1}` : null, label]
                      .filter(Boolean)
                      .join(' · ');
                    const setTranscriptRef = (el) => { transcriptRefs.current[session.id] = el; };
                    return (
                      <section
                        key={session.id}
                        className={`${styles.pane} ${isActive ? styles.paneActive : ''}`}
                        onMouseDown={() => setActiveId(session.id)}
                        aria-label={heading || `Session ${i + 1}`}
                      >
                        {heading && (
                          <header className={styles.paneHead}>
                            <span className={styles.paneLabel}>
                              {heading}
                              {session.busy && <span className={styles.paneBusy}> &middot; working</span>}
                            </span>
                            {sessions.length > 1 && (
                              <button
                                type="button"
                                className={styles.paneClose}
                                onClick={() => closeSession(session.id)}
                                aria-label={`Close session ${i + 1}`}
                                title="Close session"
                              >
                                &times;
                              </button>
                            )}
                          </header>
                        )}

                        {session.target ? (
                          <ChatTranscript
                            conversation={chat.conversation(session.target.channelId)}
                            label={label}
                            innerRef={setTranscriptRef}
                          />
                        ) : (
                          <div className={styles.transcript} ref={setTranscriptRef}>
                            {session.entries.length === 0 && (
                              <div className={styles.banner}>
                                mochi cli &mdash; type to chat, <span className={styles.slash}>/</span> for commands,{' '}
                                a conversation on the left to talk to someone,{' '}
                                <kbd className={styles.kbd}>&#8984;D</kbd> to split,{' '}
                                <kbd className={styles.kbd}>&#8984;L</kbd> to clear
                              </div>
                            )}
                            {session.entries.map((entry) => (
                              <div key={entry.id} className={`${styles.entry} ${styles[entry.kind]}`}>
                                {entry.kind === 'input' && <span className={styles.entryMark}>&#9656;</span>}
                                <span className={styles.entryText}>{entry.text}</span>
                              </div>
                            ))}
                            {session.busy && (
                              <div className={`${styles.entry} ${styles.system}`}>
                                <span className={styles.entryText}>thinking&hellip;</span>
                              </div>
                            )}
                          </div>
                        )}

                        {/* A refused message belongs under the conversation it
                            was meant for, not in it: nothing was posted. */}
                        {session.sendError && (
                          <div className={`${styles.entry} ${styles.error}`}>
                            <span className={styles.entryText}>{session.sendError}</span>
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              </div>

              {isCommand && (
                <div className={styles.completions}>
                  {matches.map((cmd, i) => (
                    <button
                      key={cmd.id}
                      type="button"
                      className={`${styles.item} ${i === selected ? styles.itemActive : ''}`}
                      onClick={() => {
                        setQuery('');
                        runCommand(cmd, active.id);
                      }}
                      onMouseEnter={() => setSelected(i)}
                    >
                      <span className={styles.itemIcon}>{cmd.icon}</span>
                      <span className={styles.itemName}>/{cmd.name}</span>
                      <span className={styles.itemDescription}>{cmd.description}</span>
                      <span className={styles.itemCategory}>{cmd.category}</span>
                    </button>
                  ))}
                  {matches.length === 0 && (
                    <div className={styles.empty}>
                      no command matches <span className={styles.emptyQuery}>{query}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        <div className={styles.row} ref={rowRef}>
          <button
            type="button"
            className={styles.chrome}
            onClick={() => setCollapsedTo(!collapsed)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Restore the command bar' : 'Minimise the command bar'}
            title={collapsed ? 'Restore' : 'Minimise'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              {collapsed ? <polyline points="6 15 12 9 18 15" /> : <polyline points="6 9 12 15 18 9" />}
            </svg>
          </button>

          <button
            type="button"
            className={`${styles.chrome} ${railOpen ? styles.chromeOn : ''}`}
            onClick={() => toggleRail(!railOpen)}
            aria-pressed={railOpen}
            aria-label={railOpen ? 'Hide the conversations' : 'Show the conversations'}
            title={railOpen ? 'Hide conversations' : 'Show conversations'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="9" y1="4" x2="9" y2="20" />
            </svg>
          </button>

          <button
            type="button"
            className={styles.chrome}
            onClick={split}
            disabled={sessions.length >= MAX_SESSIONS}
            aria-label="Split into another session"
            title={sessions.length >= MAX_SESSIONS ? `Limit is ${MAX_SESSIONS} sessions` : 'Split (⌘D)'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="12" y1="4" x2="12" y2="20" />
            </svg>
          </button>

          <label className={styles.field} htmlFor="command-bar-input">
            <span className={styles.prompt}>
              {PROMPT}
              {sessions.length > 1 && (
                <span className={styles.promptSession}>
                  :{sessions.findIndex((s) => s.id === active.id) + 1}
                </span>
              )}
              {activeLabel && <span className={styles.promptTarget}>:{activeLabel}</span>}{' '}
              <span className={styles.caret}>&#9656;</span>
            </span>
            <span className={styles.inputWrap}>
              <input
                id="command-bar-input"
                ref={inputRef}
                className={styles.fieldInput}
                type="text"
                value={query}
                placeholder={placeholder}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => collapsed && setCollapsedTo(false)}
                onClick={() => collapsed && setCollapsedTo(false)}
                autoComplete="off"
                spellCheck={false}
                aria-label="Command bar"
              />
              {/* Ghost text sits under the input showing what Tab would add. */}
              {completion && (
                <span className={styles.completion} aria-hidden="true">
                  <span className={styles.completionTyped}>{query}</span>
                  {completion}
                </span>
              )}
            </span>
          </label>

          <span className={styles.hints}>
            {busyElsewhere && <span className={styles.hintBusy}>another session is working</span>}
            {isCommand ? (
              <>
                <kbd className={styles.kbd}>tab</kbd> complete
                <kbd className={styles.kbd}>&crarr;</kbd> go
              </>
            ) : (
              <>
                <kbd className={styles.kbd}>&crarr;</kbd> send
                <kbd className={styles.kbd}>&#8984;D</kbd> split
              </>
            )}
          </span>
        </div>
      </div>
    </>
  );
}

export default function CommandBar() {
  return <BrowserOnly>{() => <CommandBarInner />}</BrowserOnly>;
}
