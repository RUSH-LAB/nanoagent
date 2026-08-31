/**
 * The panes: what each one is pointed at, what has been said in it, and which
 * one the shared prompt is talking to.
 *
 * A session is the CLI's unit of work. It owns a target (the assistant, or a
 * conversation), a transcript, an in-flight flag and its own shell-style
 * history, so a split window can be waiting on an answer in one column while a
 * line is typed into another. Everything that mutates a pane goes through this
 * hook, which is what keeps the reducer-like invariants in one place: ids are
 * allocated outside the state updater, a closed pane hands focus to the
 * neighbour that slid into its place, and no caller ever rebuilds the array
 * itself.
 *
 * The assistant's side of a transcript is written to localStorage so a reload
 * does not throw the conversation away. A channel's messages are not: the
 * server has them, and a stale copy that disagrees with the next poll would be
 * worse than an empty pane. Storage is best effort throughout, matching the
 * rest of the CLI: a browser that refuses it loses the memory, not the window.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

/* Four columns is where a session gets too narrow to read on a laptop. Not
   exported: every reader takes it off the hook's return value, so the pane
   limit a caller enforces is always the one this hook is enforcing. */
const MAX_SESSIONS = 4;

/* Signing out clears this key too, from signOutAndForget in src/utils/authClient.js:
   a transcript is the previous reader's writing and must not outlive them on a
   shared browser. The string is written out in both places on purpose, so a
   grep for it finds the clearing as well as the writing. */
const SESSIONS_KEY = 'mochi-cli-sessions';

/* Written a beat after the last change rather than on every keystroke: a
   streaming answer patches its entry dozens of times a second, and serializing
   the whole window that often is the one way this hook could cost anything. */
const SAVE_DEBOUNCE_MS = 400;

/* What a restored window is allowed to weigh. The per-session cap keeps one
   long conversation from crowding out the others; the total is the real budget,
   since a 5 MB localStorage is shared with the editor, the whiteboard and the
   flashcards. Oldest first, because the end of a transcript is the part that
   still means something. */
const MAX_ENTRIES_PER_SESSION = 100;
const MAX_STORED_CHARS = 128 * 1024;

const ENTRY_KINDS = new Set(['input', 'output', 'system', 'error']);

const freshSession = (id) => ({id, entries: [], busy: false, target: null, sendError: null});

/**
 * The part of a window worth remembering, trimmed to fit.
 *
 * `busy` and `sendError` are deliberately absent: both describe a request that
 * died with the page, and restoring either would show a pane waiting forever
 * for an answer nobody asked for.
 *
 * An answer still being written is dropped for the same reason. Saving it would
 * store half an answer as a whole one, since the pending flag is not read back:
 * the row would return as a finished reply that stops mid sentence, or as a
 * blank one when nothing had arrived yet. The question above it is kept, so a
 * restored pane shows a line that was asked and never answered, which is what
 * happened.
 */
function serialize(sessions, activeId) {
  const snapshot = sessions.map((session) => ({
    id: session.id,
    target: session.target,
    // A conversation is the server's to remember. The in-flight row goes before
    // the cap, or the cap could be spent on a row that is then dropped.
    entries: session.target
      ? []
      : session.entries.filter((entry) => !entry.pending).slice(-MAX_ENTRIES_PER_SESSION),
  }));
  let json = JSON.stringify({activeId, sessions: snapshot});
  while (json.length > MAX_STORED_CHARS) {
    // Entry ids come from one counter across every pane, so the smallest id in
    // the window is the oldest line in it whichever pane holds it.
    let oldest = null;
    for (const session of snapshot) {
      const first = session.entries[0];
      if (first && (oldest === null || first.id < oldest.entries[0].id)) oldest = session;
    }
    if (!oldest) break;
    oldest.entries.shift();
    json = JSON.stringify({activeId, sessions: snapshot});
  }
  return json;
}

/** Read back what serialize wrote, distrusting every field of it. */
function deserialize(raw) {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed?.sessions) ? parsed.sessions.slice(0, MAX_SESSIONS) : [];
  const sessions = list
    .filter((session) => Number.isFinite(session?.id))
    .map((session) => ({
      ...freshSession(session.id),
      target: session.target?.channelId != null
        ? {channelId: session.target.channelId, label: session.target.label ?? null}
        : null,
      entries: (Array.isArray(session.entries) ? session.entries : [])
        .filter((entry) => Number.isFinite(entry?.id) && ENTRY_KINDS.has(entry?.kind))
        .map((entry) => ({id: entry.id, kind: entry.kind, text: String(entry.text ?? '')})),
    }));
  if (!sessions.length) return null;
  const activeId = sessions.some((s) => s.id === parsed?.activeId) ? parsed.activeId : sessions[0].id;
  return {sessions, activeId};
}

export default function useSessions() {
  // `target` is null for the assistant, or {channelId, label} for a
  // conversation. The label is a fallback for the moment between creating a
  // channel and the directory listing it.
  const [sessions, setSessions] = useState([freshSession(1)]);
  const [activeId, setActiveId] = useState(1);
  const [hydrated, setHydrated] = useState(false);

  const nextSessionId = useRef(2);
  const nextEntryId = useRef(0);
  // Shell-style recall, kept per session so switching panes does not shuffle
  // another conversation's history. -1 means "composing a fresh line".
  const sentRef = useRef({1: []});
  const recallRef = useRef({1: -1});

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];

  /* ── Persistence ──────────────────────────────────────────────── */

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      const restored = raw ? deserialize(raw) : null;
      if (restored) {
        for (const session of restored.sessions) {
          sentRef.current[session.id] = [];
          recallRef.current[session.id] = -1;
          for (const entry of session.entries) {
            nextEntryId.current = Math.max(nextEntryId.current, entry.id);
          }
          nextSessionId.current = Math.max(nextSessionId.current, session.id + 1);
        }
        setSessions(restored.sessions);
        setActiveId(restored.activeId);
      }
    } catch {
      /* unreadable or absent: a fresh window is the right fallback */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    // Writing before the restore has run would overwrite the saved window with
    // the empty one this hook starts from.
    if (!hydrated) return undefined;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(SESSIONS_KEY, serialize(sessions, activeId));
      } catch {
        /* quota or private mode: the window simply will not be remembered */
      }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [hydrated, sessions, activeId]);

  /* ── Focus ────────────────────────────────────────────────────── */

  const focus = useCallback((id) => setActiveId(id), []);

  /** Zero-based, so ⌘1 is index 0. Out of range is a no-op, not a throw. */
  const focusIndex = useCallback((i) => {
    const target = sessions[i];
    if (target) setActiveId(target.id);
  }, [sessions]);

  /* ── Opening and closing ──────────────────────────────────────── */

  // Both of these decide from the rendered `sessions` rather than from inside a
  // setSessions updater: an updater must stay pure, and React double-invokes it
  // in development, which would allocate two ids per split.
  const split = useCallback(() => {
    if (sessions.length >= MAX_SESSIONS) return null;
    const id = nextSessionId.current;
    nextSessionId.current += 1;
    sentRef.current[id] = [];
    recallRef.current[id] = -1;
    setSessions((prev) => [...prev, freshSession(id)]);
    setActiveId(id);
    return id;
  }, [sessions.length]);

  const close = useCallback((id) => {
    if (sessions.length === 1) return false;
    const index = sessions.findIndex((s) => s.id === id);
    if (index === -1) return false;
    const next = sessions.filter((s) => s.id !== id);
    delete sentRef.current[id];
    delete recallRef.current[id];
    setSessions(next);
    // Focus the neighbour that slid into the closed pane's place.
    setActiveId((current) => (current === id ? next[Math.min(index, next.length - 1)].id : current));
    return true;
  }, [sessions]);

  /* ── Writing into a pane ──────────────────────────────────────── */

  const patch = useCallback((id, partial) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? {...s, ...partial} : s)));
  }, []);

  /** Append a line and hand back its id, which is how it is edited later. */
  const append = useCallback((id, kind, text) => {
    nextEntryId.current += 1;
    const entry = {id: nextEntryId.current, kind, text};
    setSessions((prev) => prev.map((s) => (
      s.id === id ? {...s, entries: [...s.entries, entry]} : s
    )));
    return entry.id;
  }, []);

  /** Rewrite a line in place, which is how a streamed answer grows. */
  const updateEntry = useCallback((id, entryId, partial) => {
    setSessions((prev) => prev.map((s) => (
      s.id === id
        ? {...s, entries: s.entries.map((e) => (e.id === entryId ? {...e, ...partial} : e))}
        : s
    )));
  }, []);

  const clear = useCallback((id) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? {...s, entries: []} : s)));
  }, []);

  /** Point a pane somewhere else. A refusal belonged to the old target. */
  const setTarget = useCallback((id, target) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? {...s, target, sendError: null} : s)));
  }, []);

  /* ── Shell history ────────────────────────────────────────────── */

  const remember = useCallback((id, line) => {
    sentRef.current[id] = [...(sentRef.current[id] ?? []), line];
    recallRef.current[id] = -1;
  }, []);

  /**
   * Step through a pane's history: +1 is further back, -1 is back towards the
   * fresh line. Returns the line to put in the composer, or null when there is
   * nothing to recall, which leaves whatever is being typed alone.
   */
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
    remember,
    recall,
  };
}
