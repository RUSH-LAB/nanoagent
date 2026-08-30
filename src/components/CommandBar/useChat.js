/**
 * The chat side of the CLI: who you can talk to, what has been said, and
 * saying something.
 *
 * All of it is polled. The server has no realtime transport yet, so a
 * conversation is a GET on a clock; the shape of this hook is the part that
 * will not change when that is replaced, because every caller sees the same
 * `channels`, `people` and `conversation(id)` either way.
 *
 * Two clocks rather than one. A conversation moves while you watch it, so it is
 * re-read every few seconds; the directory of channels and people changes far
 * more slowly and is re-read a quarter as often. Polling only covers channels
 * that are open in a pane, so an idle window with the CLI minimised makes one
 * request every twelve seconds and no more.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import API_BASE, {apiFetch} from '@site/src/utils/api';

const MESSAGES_MS = 3000;
const DIRECTORY_MS = 12000;

/** How much history a conversation opens with, matching the server's default. */
const HISTORY = 50;

/**
 * One API call, with the failure turned into a thrown Error carrying the
 * server's `code`. Callers branch on the code and never on the sentence, which
 * is written for a person to read and free to be reworded.
 */
async function call(path, init) {
  const res = await apiFetch(`${API_BASE}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code ?? null;
    throw err;
  }
  return data;
}

const post = (path, body) => call(path, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(body ?? {}),
});

/** Why the directory is empty, in the words the sidebar will show. */
function statusOf(err) {
  if (err.status === 401) return 'signed-out';
  if (err.code === 'no-organization') return 'no-organization';
  return 'error';
}

const EMPTY_CONVERSATION = Object.freeze({messages: [], loading: true, error: null});

/**
 * @param openChannelIds channels currently shown in a pane; only these are polled
 * @param paused         true while the window is minimised, which stops both clocks
 */
export default function useChat({openChannelIds, paused}) {
  const [directory, setDirectory] = useState({status: 'loading', channels: [], people: [], you: null, error: null});
  const [conversations, setConversations] = useState({});

  // The newest message each open channel has been marked read up to. Kept in a
  // ref rather than in state: it decides whether the next poll needs to write,
  // and it must not itself cause a render or reschedule the poll that set it.
  const markedRef = useRef({});

  const refreshDirectory = useCallback(async () => {
    try {
      const [channels, roster] = await Promise.all([
        call('/api/chat/channels'),
        call('/api/org/members'),
      ]);
      setDirectory({
        status: 'ready',
        channels: channels.channels,
        // The roster includes the caller, because it is also what the people
        // directory draws. A rail of who you can talk to does not.
        people: roster.members.filter(m => !m.you),
        you: roster.you,
        error: null,
      });
    } catch (err) {
      setDirectory({status: statusOf(err), channels: [], people: [], you: null, error: err.message});
    }
  }, []);

  const loadMessages = useCallback(async (channelId) => {
    try {
      const {messages} = await call(`/api/chat/channels/${channelId}/messages?limit=${HISTORY}`);
      setConversations(prev => ({...prev, [channelId]: {messages, loading: false, error: null}}));
      // A channel open in a pane is a channel being read, so the read mark
      // follows what has been fetched. Only when that has moved, which makes
      // watching a quiet channel one request per tick rather than two.
      const newest = messages.length ? messages[messages.length - 1].seq : 0;
      if (newest > (markedRef.current[channelId] ?? 0)) {
        markedRef.current[channelId] = newest;
        await post(`/api/chat/channels/${channelId}/read`);
        refreshDirectory();
      }
    } catch (err) {
      setConversations(prev => ({
        ...prev,
        [channelId]: {messages: prev[channelId]?.messages ?? [], loading: false, error: err.message},
      }));
    }
  }, [refreshDirectory]);

  /* ── The two clocks ───────────────────────────────────────────── */

  // Read once whenever the window opens, then on the slow clock. A minimised
  // CLI shows no rail and so asks for nothing, and a visitor with no session
  // is told once rather than every twelve seconds: nothing will change for them
  // until they sign in, and opening the window asks again.
  const signedOut = directory.status === 'signed-out';

  useEffect(() => {
    if (paused) return undefined;
    refreshDirectory();
    if (signedOut) return undefined;
    const timer = setInterval(() => { if (!document.hidden) refreshDirectory(); }, DIRECTORY_MS);
    return () => clearInterval(timer);
  }, [paused, signedOut, refreshDirectory]);

  // Joined rather than passed as an array so that re-rendering with the same
  // channels open does not tear down and restart the interval.
  const openKey = openChannelIds.join(',');

  useEffect(() => {
    const ids = openKey ? openKey.split(',') : [];
    if (ids.length === 0 || paused) return undefined;
    const tick = () => { for (const id of ids) loadMessages(id); };
    // Once immediately: opening a channel, or the window, should show the
    // conversation rather than show it in three seconds.
    tick();
    const timer = setInterval(() => { if (!document.hidden) tick(); }, MESSAGES_MS);
    return () => clearInterval(timer);
  }, [openKey, paused, loadMessages]);

  /* ── Writes ───────────────────────────────────────────────────── */

  /**
   * Post to a channel, appending what the server stored rather than what was
   * typed, so the line on screen is the line everyone else will read.
   *
   * Reading a public channel does not join it, so the first thing you say in
   * one is also the moment you join it. That retry lives here rather than on
   * the click: opening a channel to see what is in it should not sign you up.
   */
  const send = useCallback(async (channelId, body) => {
    const path = `/api/chat/channels/${channelId}/messages`;
    let data;
    try {
      data = await post(path, {body});
    } catch (err) {
      if (err.code !== 'not-a-member') throw err;
      await post(`/api/chat/channels/${channelId}/join`);
      data = await post(path, {body});
      refreshDirectory();
    }
    setConversations(prev => ({
      ...prev,
      [channelId]: {
        messages: [...(prev[channelId]?.messages ?? []), data.message],
        loading: false,
        error: null,
      },
    }));
    // Posting is reading, on the server too, so record it here rather than
    // letting the next poll notice the gap and write the same mark again.
    markedRef.current[channelId] = Math.max(markedRef.current[channelId] ?? 0, data.message.seq);
    return data.message;
  }, [refreshDirectory]);

  /** The dm with someone, opened if this is the first time. */
  const openDm = useCallback(async (personId) => {
    const {channel} = await post('/api/chat/dm', {userId: personId});
    refreshDirectory();
    return channel.id;
  }, [refreshDirectory]);

  const createChannel = useCallback(async (name) => {
    const {channel} = await post('/api/chat/channels', {name});
    refreshDirectory();
    return channel.id;
  }, [refreshDirectory]);

  /**
   * Invite an address into the organization. Returns the invitation, whose id
   * is what the link is built from; the rail is too narrow to show that link,
   * so its caller copies it rather than printing it.
   */
  const invite = useCallback(async (email) => {
    const {invitation} = await post('/api/org/invitations', {email});
    refreshDirectory();
    return invitation;
  }, [refreshDirectory]);

  const conversation = useCallback(
    channelId => conversations[channelId] ?? EMPTY_CONVERSATION,
    [conversations],
  );

  return {
    status: directory.status,
    error: directory.error,
    channels: directory.channels,
    people: directory.people,
    /** The caller's standing in the organization, which decides what the rail offers. */
    you: directory.you,
    conversation,
    refresh: refreshDirectory,
    send,
    openDm,
    createChannel,
    invite,
  };
}
