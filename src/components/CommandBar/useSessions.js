/**
 * Window panes and AI chats are deliberately different things.
 *
 * A pane is only a place on screen: it can point at a human channel or an AI
 * chat and may be closed without deleting either. An AI chat is a durable local
 * conversation with its own id, agent and transcript. This separation is what
 * lets "Add selection to chat" target an existing conversation without
 * manufacturing a new one as a side effect.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

const MAX_SESSIONS = 4;
const SAVE_DEBOUNCE_MS = 400;
const MAX_ENTRIES_PER_CHAT = 100;
const MAX_STORED_CHARS = 128 * 1024;
const SESSIONS_KEY = 'mochi-cli-sessions';
const ENTRY_KINDS = new Set(['input', 'output', 'system', 'error']);

const freshSession = id => ({id, entries: [], busy: false, target: null, sendError: null});

function storageKey(workspaceKey) {
  return workspaceKey && workspaceKey !== 'unscoped'
    ? `${SESSIONS_KEY}:${encodeURIComponent(workspaceKey)}`
    : SESSIONS_KEY;
}

export function targetKey(target) {
  if (target?.channelId != null) return `channel:${target.channelId}`;
  if (target?.chatId != null) return `chat:${target.chatId}`;
  // Read-only compatibility for transcripts saved before chats had identities.
  if (target?.agentId != null) return `agent:${target.agentId}`;
  return null;
}

export function entriesForTarget(entries, target) {
  const key = targetKey(target);
  return entries.filter(entry => (
    typeof entry.targetKey === 'string'
      ? entry.targetKey === key
      : !target?.channelId
  ));
}

function cleanEntry(entry, target = null) {
  if (!Number.isFinite(entry?.id) || !ENTRY_KINDS.has(entry?.kind)) return null;
  return {
    id: entry.id,
    kind: entry.kind,
    text: String(entry.text ?? ''),
    ...(typeof target === 'string'
      ? {targetKey: target}
      : (typeof entry.targetKey === 'string' ? {targetKey: entry.targetKey} : {})),
    ...(entry.command === true ? {command: true} : {}),
    ...(entry.agent && typeof entry.agent === 'object' ? {agent: {
      id: String(entry.agent.id ?? ''),
      name: String(entry.agent.name ?? 'Agent'),
      color: String(entry.agent.color ?? 'violet'),
    }} : {}),
    ...(entry.telemetry && typeof entry.telemetry === 'object'
      ? {telemetry: entry.telemetry}
      : {}),
  };
}

function titleFromEntries(entries, fallback = 'New chat') {
  const first = entries.find(entry => entry.kind === 'input' && !entry.command)?.text;
  return normalizeChatTitle(first) || fallback;
}

export function normalizeChatTitle(title) {
  return String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function cleanChat(chat) {
  if (!chat || typeof chat.id !== 'string' || !chat.id || typeof chat.agentId !== 'string' || !chat.agentId) {
    return null;
  }
  const key = `chat:${chat.id}`;
  const entries = (Array.isArray(chat.entries) ? chat.entries : [])
    .map(entry => cleanEntry(entry, key))
    .filter(Boolean)
    .slice(-MAX_ENTRIES_PER_CHAT);
  return {
    id: chat.id,
    agentId: chat.agentId,
    ...(typeof chat.profileId === 'string' && chat.profileId ? {profileId: chat.profileId} : {}),
    title: String(chat.title || titleFromEntries(entries)).slice(0, 60),
    entries,
    createdAt: String(chat.createdAt || ''),
    updatedAt: String(chat.updatedAt || chat.createdAt || ''),
  };
}

function cleanTarget(target, chatIds) {
  if (target?.channelId != null) return {channelId: target.channelId, label: target.label ?? null};
  if (target?.chatId != null && chatIds.has(String(target.chatId))) {
    return {
      chatId: String(target.chatId),
      agentId: String(target.agentId ?? ''),
      label: target.label ?? null,
    };
  }
  return null;
}

function cleanPane(session, chatIds) {
  if (!Number.isFinite(session?.id)) return null;
  return {
    ...freshSession(session.id),
    target: cleanTarget(session.target, chatIds),
    // Only pane-local feedback lives here. AI entries live on their chat.
    entries: (Array.isArray(session.entries) ? session.entries : [])
      .map(entry => cleanEntry(entry))
      .filter(Boolean)
      .filter(entry => !entry.targetKey?.startsWith('agent:') && !entry.targetKey?.startsWith('chat:')),
  };
}

/** Upgrade the old per-pane/per-agent transcript into independently addressable chats. */
function migrateLegacy(parsed) {
  const rawSessions = Array.isArray(parsed?.sessions) ? parsed.sessions.slice(0, MAX_SESSIONS) : [];
  const chats = [];
  const sessions = rawSessions.filter(session => Number.isFinite(session?.id)).map((session) => {
    const entries = (Array.isArray(session.entries) ? session.entries : [])
      .map(entry => cleanEntry(entry))
      .filter(Boolean);
    const groups = new Map();
    for (const entry of entries) {
      let agentId = entry.targetKey?.startsWith('agent:') ? entry.targetKey.slice(6) : null;
      if (!entry.targetKey && session.target?.agentId != null) agentId = String(session.target.agentId);
      if (!agentId) continue;
      if (!groups.has(agentId)) groups.set(agentId, []);
      groups.get(agentId).push(entry);
    }
    if (session.target?.agentId != null && !groups.has(String(session.target.agentId))) {
      groups.set(String(session.target.agentId), []);
    }

    let selectedChat = null;
    let index = 0;
    for (const [agentId, transcript] of groups) {
      index += 1;
      const id = `legacy-${session.id}-${index}`;
      const key = `chat:${id}`;
      const label = agentId === String(session.target?.agentId) ? session.target?.label : null;
      const chat = {
        id,
        agentId,
        title: titleFromEntries(transcript, label ? `${label} chat` : 'Recovered chat'),
        entries: transcript.map(entry => ({...entry, targetKey: key})).slice(-MAX_ENTRIES_PER_CHAT),
        createdAt: '',
        updatedAt: '',
      };
      chats.push(chat);
      if (agentId === String(session.target?.agentId)) selectedChat = chat;
    }

    return {
      ...freshSession(session.id),
      target: session.target?.channelId != null
        ? {channelId: session.target.channelId, label: session.target.label ?? null}
        : (selectedChat ? {
          chatId: selectedChat.id,
          agentId: selectedChat.agentId,
          label: selectedChat.title,
        } : null),
      entries: entries.filter(entry => !entry.targetKey?.startsWith('agent:') && entry.targetKey != null),
    };
  });
  return {sessions, chats};
}

/** Parse either the current snapshot or the pre-chat format. Exported for migration tests. */
export function restoreSessionState(raw) {
  const parsed = JSON.parse(raw);
  let chats;
  let sessions;
  if (parsed?.version === 2 && Array.isArray(parsed.chats)) {
    chats = parsed.chats.map(cleanChat).filter(Boolean);
    const chatIds = new Set(chats.map(chat => chat.id));
    sessions = (Array.isArray(parsed.sessions) ? parsed.sessions : [])
      .slice(0, MAX_SESSIONS)
      .map(session => cleanPane(session, chatIds))
      .filter(Boolean);
  } else {
    ({sessions, chats} = migrateLegacy(parsed));
  }
  if (!sessions.length) return null;
  const activeId = sessions.some(session => session.id === parsed.activeId)
    ? parsed.activeId
    : sessions[0].id;
  return {sessions, chats, activeId};
}

function serializeSessionState(sessions, chats, activeId) {
  const snapshot = {
    version: 2,
    activeId,
    sessions: sessions.map(session => ({
      id: session.id,
      target: session.target,
      entries: session.entries.filter(entry => !entry.pending && !entry.targetKey?.startsWith('channel:')),
    })),
    chats: chats.map(chat => ({
      ...chat,
      entries: chat.entries.filter(entry => !entry.pending).slice(-MAX_ENTRIES_PER_CHAT),
    })),
  };
  let json = JSON.stringify(snapshot);
  while (json.length > MAX_STORED_CHARS) {
    let oldest = null;
    for (const chat of snapshot.chats) {
      const first = chat.entries[0];
      if (first && (!oldest || first.id < oldest.entries[0].id)) oldest = chat;
    }
    if (!oldest) break;
    oldest.entries.shift();
    json = JSON.stringify(snapshot);
  }
  return json;
}

export default function useSessions(workspaceKey = 'unscoped') {
  const scopedSessionsKey = storageKey(workspaceKey);
  const [paneSessions, setPaneSessions] = useState([freshSession(1)]);
  const [chats, setChats] = useState([]);
  const [activeId, setActiveId] = useState(1);
  const [hydrated, setHydrated] = useState(false);
  const nextSessionId = useRef(2);
  const nextEntryId = useRef(0);
  const nextChatId = useRef(0);
  const sentRef = useRef({1: []});
  const recallRef = useRef({1: -1});

  const sessions = useMemo(() => paneSessions.map(session => {
    const chat = session.target?.chatId
      ? chats.find(candidate => candidate.id === session.target.chatId)
      : null;
    return chat ? {
      ...session,
      target: {...session.target, agentId: chat.agentId, label: chat.title},
      entries: chat.entries,
    } : session;
  }), [paneSessions, chats]);
  const orderedChats = useMemo(
    () => [...chats].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    [chats],
  );
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const active = sessions.find(session => session.id === activeId) ?? sessions[0];

  useEffect(() => {
    try {
      const raw = localStorage.getItem(scopedSessionsKey);
      const restored = raw ? restoreSessionState(raw) : null;
      if (restored) {
        for (const session of restored.sessions) {
          sentRef.current[session.id] = [];
          recallRef.current[session.id] = -1;
          nextSessionId.current = Math.max(nextSessionId.current, session.id + 1);
          for (const entry of session.entries) nextEntryId.current = Math.max(nextEntryId.current, entry.id);
        }
        for (const chat of restored.chats) {
          for (const entry of chat.entries) nextEntryId.current = Math.max(nextEntryId.current, entry.id);
        }
        setPaneSessions(restored.sessions);
        setChats(restored.chats);
        setActiveId(restored.activeId);
      }
    } catch {
      /* unreadable or absent: a fresh window is the right fallback */
    }
    setHydrated(true);
  }, [scopedSessionsKey]);

  useEffect(() => {
    if (!hydrated) return undefined;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(scopedSessionsKey, serializeSessionState(paneSessions, chats, activeId));
      } catch {
        /* quota or private mode: the window simply will not be remembered */
      }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [hydrated, paneSessions, chats, activeId, scopedSessionsKey]);

  const focus = useCallback(id => setActiveId(id), []);
  const focusIndex = useCallback((index) => {
    const target = sessions[index];
    if (target) setActiveId(target.id);
  }, [sessions]);

  const split = useCallback(() => {
    if (paneSessions.length >= MAX_SESSIONS) return null;
    const id = nextSessionId.current;
    nextSessionId.current += 1;
    sentRef.current[id] = [];
    recallRef.current[id] = -1;
    setPaneSessions(previous => [...previous, freshSession(id)]);
    setActiveId(id);
    return id;
  }, [paneSessions.length]);

  const close = useCallback((id) => {
    if (paneSessions.length === 1) return false;
    const index = paneSessions.findIndex(session => session.id === id);
    if (index === -1) return false;
    const next = paneSessions.filter(session => session.id !== id);
    delete sentRef.current[id];
    delete recallRef.current[id];
    setPaneSessions(next);
    setActiveId(current => (current === id ? next[Math.min(index, next.length - 1)].id : current));
    return true;
  }, [paneSessions]);

  const patch = useCallback((id, partial) => {
    setPaneSessions(previous => previous.map(session => (session.id === id ? {...session, ...partial} : session)));
  }, []);

  const append = useCallback((id, kind, text, metadata = {}) => {
    nextEntryId.current += 1;
    const entryId = nextEntryId.current;
    const session = sessionsRef.current.find(candidate => candidate.id === id);
    const key = metadata.targetKey ?? targetKey(session?.target);
    const {titleChat = false, ...entryMetadata} = metadata;
    const entry = {id: entryId, kind, text, targetKey: key, ...entryMetadata};
    const chatId = key?.startsWith('chat:') ? key.slice(5) : null;

    if (chatId) {
      setChats(previous => previous.map(chat => {
        if (chat.id !== chatId) return chat;
        const firstPrompt = titleChat && kind === 'input' && !chat.entries.some(item => item.kind === 'input');
        return {
          ...chat,
          title: firstPrompt ? titleFromEntries([entry]) : chat.title,
          entries: [...chat.entries, entry],
          updatedAt: new Date().toISOString(),
        };
      }));
    } else {
      setPaneSessions(previous => previous.map(candidate => (
        candidate.id === id ? {...candidate, entries: [...candidate.entries, entry]} : candidate
      )));
    }
    return entryId;
  }, []);

  const updateEntry = useCallback((id, entryId, partial) => {
    setChats(previous => previous.map(chat => ({
      ...chat,
      entries: chat.entries.map(entry => (entry.id === entryId ? {...entry, ...partial} : entry)),
    })));
    setPaneSessions(previous => previous.map(session => (
      session.id === id
        ? {...session, entries: session.entries.map(entry => (entry.id === entryId ? {...entry, ...partial} : entry))}
        : session
    )));
  }, []);

  const clear = useCallback((id) => {
    const session = sessionsRef.current.find(candidate => candidate.id === id);
    if (session?.target?.chatId) {
      setChats(previous => previous.map(chat => (
        chat.id === session.target.chatId ? {...chat, entries: [], title: 'New chat'} : chat
      )));
      return;
    }
    setPaneSessions(previous => previous.map(candidate => (candidate.id === id ? {...candidate, entries: []} : candidate)));
  }, []);

  const setTarget = useCallback((id, target) => {
    setPaneSessions(previous => previous.map(session => (
      session.id === id ? {...session, target, sendError: null} : session
    )));
  }, []);

  const createChat = useCallback((sessionId, agent) => {
    if (!agent?.id) return null;
    nextChatId.current += 1;
    const now = new Date().toISOString();
    const chat = {
      id: `chat-${Date.now().toString(36)}-${nextChatId.current.toString(36)}`,
      agentId: agent.id,
      ...(typeof agent.profileId === 'string' && agent.profileId ? {profileId: agent.profileId} : {}),
      title: 'New chat',
      entries: [],
      createdAt: now,
      updatedAt: now,
    };
    setChats(previous => [chat, ...previous]);
    setTarget(sessionId, {chatId: chat.id, agentId: agent.id, label: chat.title});
    setActiveId(sessionId);
    return chat;
  }, [setTarget]);

  const setChatProfile = useCallback((chatId, profileId) => {
    if (typeof profileId !== 'string' || !profileId) return false;
    setChats(previous => previous.map(chat => {
      if (chat.id !== chatId) return chat;
      return {...chat, profileId, updatedAt: new Date().toISOString()};
    }));
    return true;
  }, []);

  const renameChat = useCallback((chatId, title) => {
    const nextTitle = normalizeChatTitle(title);
    if (!nextTitle) return false;
    setChats(previous => previous.map(chat => (
      chat.id === chatId ? {...chat, title: nextTitle, updatedAt: new Date().toISOString()} : chat
    )));
    return true;
  }, []);

  const deleteChat = useCallback((chatId) => {
    setChats(previous => previous.filter(chat => chat.id !== chatId));
    setPaneSessions(previous => previous.map(session => (
      session.target?.chatId === chatId ? {...session, target: null, busy: false, sendError: null} : session
    )));
  }, []);

  const removeChatsForAgent = useCallback((agentId) => {
    const removed = new Set(chats.filter(chat => chat.agentId === agentId).map(chat => chat.id));
    setChats(previous => previous.filter(chat => chat.agentId !== agentId));
    setPaneSessions(previous => previous.map(session => (
      removed.has(session.target?.chatId) ? {...session, target: null} : session
    )));
  }, [chats]);

  const remember = useCallback((id, line) => {
    sentRef.current[id] = [...(sentRef.current[id] ?? []), line];
    recallRef.current[id] = -1;
  }, []);

  const recall = useCallback((id, delta) => {
    const lines = sentRef.current[id] ?? [];
    if (!lines.length) return null;
    let next = (recallRef.current[id] ?? -1) + delta;
    if (next < -1) next = -1;
    if (next >= lines.length) next = lines.length - 1;
    recallRef.current[id] = next;
    return next === -1 ? '' : lines[lines.length - 1 - next];
  }, []);

  return {
    sessions,
    chats: orderedChats,
    active,
    activeId,
    focus,
    focusIndex,
    split,
    close,
    MAX_SESSIONS,
    patch,
    append,
    updateEntry,
    clear,
    setTarget,
    createChat,
    setChatProfile,
    renameChat,
    deleteChat,
    removeChatsForAgent,
    remember,
    recall,
  };
}
