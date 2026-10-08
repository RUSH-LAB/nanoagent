/**
 * The chat side of the CLI: who you can talk to, what has been said, and every
 * way of changing either.
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
 *
 * Polling a transcript has two hazards, and both are answered here rather than
 * in the components. The first is churn: a poll that stored a fresh array every
 * three seconds would re-render the whole window on a clock even when nothing
 * had been said, so a page identical to the one already held is dropped and the
 * state object is returned unchanged, and a poll that keeps failing says so
 * once rather than once a tick. The second is loss: a poll asks for the newest
 * page, and storing that page would throw away every older page the reader had
 * scrolled back to, so pages are merged by `seq` rather than replacing one
 * another. The one page that cannot be merged is a page that does not touch
 * what is held, which is what a window left shut through a busy hour comes back
 * to; that case is spelled out at `hasGap` below.
 *
 * A word about `read`. Reading a public channel does not join it, and the mark
 * is an UPDATE against a membership row, so an un-joined channel cannot be
 * marked read and answers `{marked: false}`. Recording the mark anyway is how a
 * badge sticks forever while the client believes it has cleared it; nothing is
 * recorded here until the server says it took, and `joined` travels with the
 * conversation so a transcript can offer the join that would fix it.
 *
 * Every failure arrives as an Error carrying the server's `code`, and every
 * decision below is made on that code. The sentence beside it is written for a
 * person and free to be reworded; `status` is the fallback, because a 429 and
 * the `Invalid request` 400 that a malformed body earns carry no code at all.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import API_BASE, {apiFetch} from '@site/src/utils/api';

/* ── Constants ──────────────────────────────────────────────────── */

/** How often an open conversation is re-read, and the directory behind it. */
const MESSAGES_MS = 3000;
const DIRECTORY_MS = 12000;

/** How much history one page holds, matching the server's default. */
const HISTORY = 50;

const JSON_HEADERS = Object.freeze({'Content-Type': 'application/json'});

/**
 * The two failures this hook acts on rather than merely reports. Both are
 * spelled here so that a rename on the server is one edit, and so that nothing
 * below is tempted to match on the prose that comes with them.
 */
const NOT_A_MEMBER = 'not-a-member';
const NO_ORGANIZATION = 'no-organization';

/** No session. It carries no code, which is why this one branch is on status. */
const UNAUTHORIZED = 401;

/**
 * What a conversation looks like before anything has been fetched.
 *
 * `hasMore` and `lastReadSeq` are absent rather than false or null on purpose.
 * A transcript reads `hasMore === false` as a promise that this is the whole
 * history and `lastReadSeq === null` as a reader who was never a member, and
 * neither is something we know yet.
 */
const EMPTY_CONVERSATION = Object.freeze({
  messages: Object.freeze([]),
  loading: true,
  loadingOlder: false,
  error: null,
});

/* ── Talking to the server ──────────────────────────────────────── */

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
  headers: JSON_HEADERS,
  body: JSON.stringify(body ?? {}),
});

const patch = (path, body) => call(path, {
  method: 'PATCH',
  headers: JSON_HEADERS,
  body: JSON.stringify(body ?? {}),
});

const remove = path => call(path, {method: 'DELETE'});

/** Why the directory is empty, in the words the sidebar will show. */
function statusOf(err) {
  if (err.status === UNAUTHORIZED) return 'signed-out';
  if (err.code === NO_ORGANIZATION) return 'no-organization';
  return 'error';
}

/* ── Merging pages ──────────────────────────────────────────────── */

/**
 * Whether two readings of the same sequence say the same thing.
 *
 * A message is not immutable: deleting one blanks its body and keeps its slot,
 * and editing one stamps `editedAt`. Comparing the fields that can move is what
 * lets an unchanged page be dropped without dropping a tombstone with it.
 */
function sameMessage(a, b) {
  return a.id === b.id
    && a.body === b.body
    && a.editedAt === b.editedAt
    && a.deletedAt === b.deletedAt;
}

/** PostgreSQL returns BIGINT values as strings; the browser uses numbers. */
function sequenceOf(message) {
  const sequence = Number(message?.seq);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

/** The lowest server-assigned sequence in a list. */
function oldestSeq(messages) {
  for (const message of messages) {
    const sequence = sequenceOf(message);
    if (sequence !== null) return sequence;
  }
  return null;
}

/** The highest sequence in a page. Pages arrive oldest first. */
function newestSeq(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const sequence = sequenceOf(messages[i]);
    if (sequence !== null) return sequence;
  }
  return null;
}

/**
 * Whether a fetched page begins above everything held, with sequences in
 * between that nothing will ever ask for.
 *
 * A poll asks for the newest page and there is no forward cursor, so a window
 * shut long enough for more than a page to be said comes back to a page whose
 * oldest message is not the one after the newest held. Sequences are handed out
 * one after another and a delete keeps its slot, so a step of more than one is
 * a real hole rather than an artefact of the numbering.
 *
 * `loadOlder` cannot close it: it pages back from the oldest row held, which is
 * on the far side of the hole and walking away from it. The caller therefore
 * drops the stranded history instead of splicing two ranges into one transcript
 * that reads as whole and is missing its middle.
 */
function hasGap(held, page) {
  const newestHeld = newestSeq(held);
  const oldestPage = oldestSeq(page);
  return newestHeld !== null && oldestPage !== null && oldestPage > newestHeld + 1;
}

/**
 * Fold a freshly fetched page into what is already held.
 *
 * Keyed on `seq`, which is the server's own ordering and stable under both
 * paging directions: the newest page and a page from ten minutes ago merge the
 * same way. The fetched reading of a sequence wins, so a message that has
 * become a tombstone becomes one here too. The single exception runs the other
 * way: a tombstone already held is never overwritten by a live body, because
 * the server only ever sets `deletedAt` and never clears it, so a page carrying
 * the body back is a page whose query ran before the delete did.
 *
 * Returns the array that was passed in, unchanged and identical, when the page
 * says nothing new. That identity is what the change detection upstream tests,
 * and it is the difference between a quiet channel costing one request per tick
 * and costing a render of the entire window.
 *
 * Every displayed chat row is now server-confirmed and therefore has a
 * sequence. Sequence-less rows are leftovers from the old optimistic sender;
 * dropping them here also repairs an already-open window after Fast Refresh,
 * instead of making somebody reload the whole page to clear a duplicate.
 */
function mergePage(held, page) {
  const bySeq = new Map();
  let changed = false;
  for (const message of held) {
    const sequence = sequenceOf(message);
    if (sequence === null) {
      changed = true;
      continue;
    }
    const normalized = message.seq === sequence ? message : {...message, seq: sequence};
    if (normalized !== message) changed = true;
    bySeq.set(sequence, normalized);
  }

  for (const message of page) {
    const sequence = sequenceOf(message);
    if (sequence === null) continue;
    const normalized = message.seq === sequence ? message : {...message, seq: sequence};
    const previous = bySeq.get(sequence);
    if (previous && previous.deletedAt != null && normalized.deletedAt == null) continue;
    if (previous && sameMessage(previous, normalized)) continue;
    bySeq.set(sequence, normalized);
    changed = true;
  }

  if (!changed) return held;
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/* ── Finding what was named ─────────────────────────────────────── */

/** A typed name with its sigil, its case and its stray spaces taken off. */
function looseName(text) {
  return String(text ?? '').trim().replace(/^[#@]/, '').trim().toLowerCase();
}

/**
 * The same, in the shape the server stores a channel name in: it lowercases and
 * turns runs of spaces into dashes, so `My Room` has to be able to find
 * `my-room` or half the verbs would answer that no such channel exists.
 */
function channelKey(text) {
  return looseName(text).replace(/\s+/g, '-');
}

/**
 * The one row a name picks out, trying each field in turn.
 *
 * Two matches in a tier is an answer of null rather than the first of them. A
 * resolver that guessed between two people would send somebody else's mail, and
 * the verb that called this says out loud that it found no single match, which
 * is a thing the reader can act on.
 */
function uniqueMatch(rows, tiers) {
  for (const {wanted, read} of tiers) {
    if (!wanted) continue;
    const hits = rows.filter(row => {
      const value = read(row);
      return typeof value === 'string' && value.trim().toLowerCase() === wanted;
    });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  return null;
}

/* ── The hook ───────────────────────────────────────────────────── */

/**
 * @param openChannelIds channels currently shown in a pane; only these are polled
 * @param paused         true while the window is minimised, which stops both clocks
 */
export default function useChat({openChannelIds, paused}) {
  const [directory, setDirectory] = useState({status: 'loading', channels: [], people: [], members: [], you: null, error: null});
  const [conversations, setConversations] = useState({});

  // The newest message each open channel has been marked read up to, and only
  // when the server said the mark took. Kept in a ref rather than in state: it
  // decides whether the next poll needs to write, and it must not itself cause
  // a render or reschedule the poll that set it.
  const markedRef = useRef({});

  // The latest of each, for the code that runs on a timer or long after the
  // render it was created in. Reading state through a ref keeps `loadOlder` and
  // the writes below from being rebuilt on every poll, which would restart the
  // interval that calls them.
  const channelsRef = useRef([]);
  const youRef = useRef(null);
  const conversationsRef = useRef({});
  useEffect(() => { channelsRef.current = directory.channels; }, [directory.channels]);
  useEffect(() => { youRef.current = directory.you; }, [directory.you]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);

  // Channels with a request already out, one set per direction. A slow answer
  // must not have a second request stacked on top of it every three seconds,
  // and a page of history must be asked for once however often the scroll box
  // reaches the top.
  const inFlightRef = useRef(new Set());
  const olderRef = useRef(new Set());

  /**
   * Change one conversation, or leave the map exactly as it was.
   *
   * Returning the previous state object from the updater is how a poll that
   * found nothing new costs nothing: React compares identity and there is no
   * render.
   */
  const patchConversation = useCallback((channelId, change) => {
    setConversations(prev => {
      const held = prev[channelId] ?? EMPTY_CONVERSATION;
      const next = change(held);
      return next === held ? prev : {...prev, [channelId]: next};
    });
  }, []);

  /* ── The directory ──────────────────────────────────────────── */

  const refreshDirectory = useCallback(async () => {
    try {
      const [channels, roster] = await Promise.all([
        call('/api/chat/channels'),
        call('/api/members'),
      ]);
      // The caller's own row carries the name an optimistic message is signed
      // with; `roster.you` is a standing in the organization and has no name in
      // it. Merged rather than kept apart so that every caller still reads
      // `you.canManage` and `you.userId` where it always did.
      const self = roster.members.find(m => m.you);
      setDirectory({
        status: 'ready',
        channels: channels.channels,
        // The full roster powers the People panel. `people` remains the subset
        // that can be addressed by a DM or an @ mention, so existing messaging
        // behavior never offers a conversation with yourself.
        members: roster.members,
        // The roster includes the caller, because it is also what the people
        // directory draws. A rail of who you can talk to does not.
        people: roster.members.filter(m => !m.you),
        you: self ? {...roster.you, username: self.username, name: self.name} : roster.you,
        error: null,
      });
    } catch (err) {
      setDirectory({status: statusOf(err), channels: [], people: [], members: [], you: null, error: err.message});
    }
  }, []);

  /* ── Reading a conversation ─────────────────────────────────── */

  const loadMessages = useCallback(async (channelId) => {
    if (inFlightRef.current.has(channelId)) return;
    inFlightRef.current.add(channelId);
    try {
      const page = await call(`/api/chat/channels/${channelId}/messages?limit=${HISTORY}`);
      const row = channelsRef.current.find(c => c.id === channelId) ?? null;

      patchConversation(channelId, held => {
        // A page that does not touch the history held is answered by keeping
        // the page, which is what opening the channel fresh would have shown.
        // Short and true beats long with an unmarked hole in it, and `hasMore`
        // below then sends the reader's own scroll back through the hole to
        // fetch what was dropped.
        const gap = hasGap(held.messages, page.messages);
        const base = gap ? [] : held.messages;
        const messages = mergePage(base, page.messages);
        // The reader's own mark, taken the first time the directory can say
        // what it is and then left alone. It moves the moment this channel is
        // on screen, so a value that kept up would walk the "new messages"
        // divider off the bottom of the transcript while it was being read.
        const lastReadSeq = (held.lastReadSeq !== undefined || !row)
          ? held.lastReadSeq
          : (row.lastReadSeq ?? null);
        // `hasMore` answers "is there anything before this page", and the page
        // asked for is the newest one. Once the reader has paged further back
        // than it reaches, the last `loadOlder` is the one that knows. Not
        // after a gap, though: the history that had been paged back to is the
        // history just dropped, so the flag it carried says nothing about what
        // is on screen now, and the page's own answer is the honest one.
        const oldestHeld = oldestSeq(held.messages);
        const oldestPage = oldestSeq(page.messages);
        const pagedBack = !gap
          && oldestHeld !== null && oldestPage !== null && oldestHeld < oldestPage;
        // The server computes it as `rows.length === limit`, a heuristic that
        // claims more history than there is whenever the last page fills
        // itself exactly. An empty page is the correction, so it clears the
        // flag whatever came with it.
        const hasMore = pagedBack
          ? held.hasMore
          : (page.messages.length === 0 ? false : Boolean(page.hasMore));
        const joined = row ? row.joined : held.joined;

        if (messages === held.messages
          && held.loading === false
          && held.error === null
          && held.hasMore === hasMore
          && held.lastReadSeq === lastReadSeq
          && held.joined === joined) return held;
        return {...held, messages, loading: false, error: null, hasMore, lastReadSeq, joined};
      });

      // A channel open in a pane is a channel being read, so the read mark
      // follows what has been fetched. Only when that has moved, which makes
      // watching a quiet channel one request per tick rather than two, and only
      // for a channel this reader has actually joined: the mark is an UPDATE
      // against a membership row, and there is none to update otherwise.
      const newest = newestSeq(page.messages) ?? 0;
      // Seeded from the directory the first time round, so that opening a
      // channel already read to the end costs no write at all.
      if (markedRef.current[channelId] === undefined && row) {
        markedRef.current[channelId] = row.lastReadSeq ?? 0;
      }
      if (row?.joined && newest > (markedRef.current[channelId] ?? 0)) {
        const result = await post(`/api/chat/channels/${channelId}/read`);
        // Recorded only when the server says it took. A refused mark that was
        // recorded anyway is a badge that never clears.
        if (result.marked) {
          markedRef.current[channelId] = Math.max(
            markedRef.current[channelId] ?? 0,
            typeof result.lastReadSeq === 'number' ? result.lastReadSeq : newest,
          );
          refreshDirectory();
        }
      }
    } catch (err) {
      // The same failure twice is not news. A fresh object every three seconds
      // would defeat the identity test above and re-render the window on a
      // clock for as long as the network or the session stays broken.
      patchConversation(channelId, held => (
        held.loading === false && held.error === err.message
          ? held
          : {...held, loading: false, error: err.message}
      ));
    } finally {
      inFlightRef.current.delete(channelId);
    }
  }, [patchConversation, refreshDirectory]);

  /**
   * The page before the oldest message on screen.
   *
   * `before` is a sequence and it is exclusive, so paging back is the oldest
   * sequence held and never that sequence minus one, which would be a message
   * that does not exist as often as not.
   */
  const loadOlder = useCallback(async (channelId) => {
    const held = conversationsRef.current[channelId];
    if (!held || held.hasMore === false) return;
    const before = oldestSeq(held.messages);
    if (before === null) return;
    // The flag in state says the same thing, but a scroll can ask twice inside
    // one frame and state has not been re-read by then.
    if (olderRef.current.has(channelId)) return;
    olderRef.current.add(channelId);

    patchConversation(channelId, current => ({...current, loadingOlder: true}));
    try {
      const page = await call(
        `/api/chat/channels/${channelId}/messages?limit=${HISTORY}&before=${before}`,
      );
      patchConversation(channelId, current => ({
        ...current,
        messages: mergePage(current.messages, page.messages),
        loadingOlder: false,
        error: null,
        hasMore: page.messages.length === 0 ? false : Boolean(page.hasMore),
      }));
    } catch (err) {
      patchConversation(channelId, current => ({...current, loadingOlder: false, error: err.message}));
    } finally {
      olderRef.current.delete(channelId);
    }
  }, [patchConversation]);

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
    // Signed out for the same reason the directory clock stops: a restored pane
    // asks for a channel nobody is allowed to read, and asking again in three
    // seconds cannot change that. Signing in flips the flag and restarts this.
    if (ids.length === 0 || paused || signedOut) return undefined;
    const tick = () => { for (const id of ids) loadMessages(id); };
    // Once immediately: opening a channel, or the window, should show the
    // conversation rather than show it in three seconds.
    tick();
    const timer = setInterval(() => { if (!document.hidden) tick(); }, MESSAGES_MS);
    return () => clearInterval(timer);
  }, [openKey, paused, signedOut, loadMessages]);

  // A conversation that has left every pane forgets where reading stopped,
  // while keeping its messages so that coming back to it is instant. The mark
  // is frozen on purpose while a channel is open; unfreezing it here is what
  // stops a divider from yesterday being drawn over a channel read since.
  useEffect(() => {
    const open = new Set(openKey ? openKey.split(',') : []);
    setConversations(prev => {
      let changed = false;
      const next = {};
      for (const [id, held] of Object.entries(prev)) {
        if (!open.has(id) && held.lastReadSeq !== undefined) {
          next[id] = {...held, lastReadSeq: undefined};
          changed = true;
        } else {
          next[id] = held;
        }
      }
      return changed ? next : prev;
    });
  }, [openKey]);

  /* ── Saying something ─────────────────────────────────────────── */

  /**
   * Post to a channel.
   *
   * The server-confirmed row is the only row inserted. This avoids a race where
   * polling sees the stored message while a temporary optimistic copy is still
   * on screen, which made the sender briefly see every message twice.
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
      if (err.code !== NOT_A_MEMBER) throw err;
      try {
        await post(`/api/chat/channels/${channelId}/join`);
        data = await post(path, {body});
      } catch (retried) {
        throw retried;
      }
      refreshDirectory();
    }

    patchConversation(channelId, held => ({
      ...held,
      messages: mergePage(held.messages, [data.message]),
      loading: false,
      error: null,
    }));
    // Posting is reading, on the server too, so record it here rather than
    // letting the next poll notice the gap and write the same mark again.
    markedRef.current[channelId] = Math.max(markedRef.current[channelId] ?? 0, data.message.seq);
    return data.message;
  }, [patchConversation, refreshDirectory]);

  /* ── Changing the directory ───────────────────────────────────── */

  /** The dm with someone, opened if this is the first time. */
  const openDm = useCallback(async (personId) => {
    const {channel} = await post('/api/chat/dm', {userId: personId});
    refreshDirectory();
    return channel.id;
  }, [refreshDirectory]);

  /**
   * Create a channel. `opts` carries the topic and the kind when there is one,
   * and the server decides the name: it lowercases it and turns spaces into
   * dashes, so what comes back is what the channel is called.
   */
  const createChannel = useCallback(async (name, opts) => {
    const {channel} = await post('/api/chat/channels', {name, ...(opts ?? {})});
    refreshDirectory();
    return channel.id;
  }, [refreshDirectory]);

  /**
   * Invite an address into the organization. Returns the invitation, whose id
   * is what the link is built from; the rail is too narrow to show that link,
   * so its caller copies it rather than printing it.
   */
  const invite = useCallback(async (email) => {
    const {invitation} = await post('/api/invitations', {email});
    refreshDirectory();
    return invitation;
  }, [refreshDirectory]);

  const join = useCallback(async (channelId) => {
    const result = await post(`/api/chat/channels/${channelId}/join`);
    refreshDirectory();
    return result;
  }, [refreshDirectory]);

  /**
   * Leave a channel, and forget how far it had been read.
   *
   * The mark lives on the membership row, and leaving deletes that row, so a
   * later rejoin starts from nothing. Holding on to our copy would tell the
   * next poll the mark is already where it needs to be, and the badge would sit
   * there unread until somebody said something new.
   */
  const leave = useCallback(async (channelId) => {
    const result = await post(`/api/chat/channels/${channelId}/leave`);
    delete markedRef.current[channelId];
    refreshDirectory();
    return result;
  }, [refreshDirectory]);

  /** Archive a channel, or bring it back. Two endpoints, one intention. */
  const archive = useCallback(async (channelId, on) => {
    const result = await post(`/api/chat/channels/${channelId}/${on ? 'archive' : 'unarchive'}`);
    refreshDirectory();
    return result;
  }, [refreshDirectory]);

  /**
   * Rename a channel, set its topic, or both. Only the keys given are sent: the
   * server touches exactly the fields in the body, so passing an undefined name
   * along with a topic would be asking to be refused for an empty name.
   */
  const update = useCallback(async (channelId, {name, topic} = {}) => {
    const changes = {};
    if (name !== undefined) changes.name = name;
    if (topic !== undefined) changes.topic = topic;
    const result = await patch(`/api/chat/channels/${channelId}`, changes);
    refreshDirectory();
    return result;
  }, [refreshDirectory]);

  /** Delete a channel and everything in it. Organization managers only. */
  const removeChannel = useCallback(async (channelId) => {
    const result = await remove(`/api/chat/channels/${channelId}`);
    setConversations(prev => {
      if (!(channelId in prev)) return prev;
      const next = {...prev};
      delete next[channelId];
      return next;
    });
    delete markedRef.current[channelId];
    refreshDirectory();
    return result;
  }, [refreshDirectory]);

  /** Change or remove a workspace member from the in-window people manager. */
  const updateWorkspaceMember = useCallback(async (memberId, role) => {
    const result = await post(`/api/members/${encodeURIComponent(memberId)}/role`, {role});
    refreshDirectory();
    return result;
  }, [refreshDirectory]);

  const removeWorkspaceMember = useCallback(async (memberId) => {
    const result = await remove(`/api/members/${encodeURIComponent(memberId)}`);
    refreshDirectory();
    return result;
  }, [refreshDirectory]);

  /** Channel metadata and its current membership, for the in-window manager. */
  const channelDetails = useCallback(
    channelId => call(`/api/chat/channels/${channelId}`),
    [],
  );

  const addMember = useCallback(async (channelId, userId) => {
    const result = await post(`/api/chat/channels/${channelId}/members`, {userId});
    refreshDirectory();
    return result;
  }, [refreshDirectory]);

  const removeMember = useCallback(async (channelId, userId) => {
    const result = await remove(`/api/chat/channels/${channelId}/members/${userId}`);
    // Taking yourself out is leaving under another name, and the read mark has
    // to go with the membership row for the reason spelled out on `leave`.
    if (userId && userId === youRef.current?.userId) delete markedRef.current[channelId];
    refreshDirectory();
    return result;
  }, [refreshDirectory]);

  /**
   * Blank one of your own messages. The row keeps its slot with an empty body,
   * which is what the server does too, so the thread around it still holds.
   * Applied here as well as awaited from the next poll, because three seconds
   * of the message still being there reads as a delete that did not work.
   */
  const deleteMessage = useCallback(async (messageId) => {
    const result = await remove(`/api/chat/messages/${messageId}`);
    const deletedAt = new Date().toISOString();
    setConversations(prev => {
      let changed = false;
      const next = {};
      for (const [id, held] of Object.entries(prev)) {
        const hit = held.messages.some(m => m.id === messageId && m.body !== null);
        if (!hit) {
          next[id] = held;
          continue;
        }
        next[id] = {
          ...held,
          messages: held.messages.map(m => (m.id === messageId ? {...m, body: null, deletedAt} : m)),
        };
        changed = true;
      }
      return changed ? next : prev;
    });
    return result;
  }, []);

  /* ── Resolving what was named ─────────────────────────────────── */

  /**
   * The channel a typed name picks out, by its name and then, for a direct
   * message, by whoever is on the other side of it. A dm has no name of its
   * own, so `#alice` and `alice` both have to reach one.
   */
  const findChannel = useCallback((name) => {
    const loose = looseName(name);
    if (!loose) return null;
    return uniqueMatch(directory.channels, [
      {wanted: channelKey(name), read: c => c.name},
      {wanted: loose, read: c => c.peerUsername},
      {wanted: loose, read: c => c.peerName},
    ]);
  }, [directory.channels]);

  /** The person a typed name picks out: username, then display name, then address. */
  const findPerson = useCallback((name) => {
    const loose = looseName(name);
    if (!loose) return null;
    return uniqueMatch(directory.people, [
      {wanted: loose, read: p => p.username},
      {wanted: loose, read: p => p.name},
      {wanted: loose, read: p => p.email},
    ]);
  }, [directory.people]);

  const conversation = useCallback(
    channelId => conversations[channelId] ?? EMPTY_CONVERSATION,
    [conversations],
  );

  /** Everything unread everywhere, which is what the tab title counts. */
  const unreadTotal = useMemo(
    () => directory.channels.reduce((total, c) => total + (c.unread ?? 0), 0),
    [directory.channels],
  );

  return {
    status: directory.status,
    error: directory.error,
    channels: directory.channels,
    people: directory.people,
    members: directory.members,
    /** The caller's standing in the organization, which decides what the rail offers. */
    you: directory.you,
    unreadTotal,
    conversation,
    loadOlder,
    refresh: refreshDirectory,
    send,
    openDm,
    createChannel,
    invite,
    join,
    leave,
    archive,
    update,
    removeChannel,
    updateWorkspaceMember,
    removeWorkspaceMember,
    channelDetails,
    addMember,
    removeMember,
    deleteMessage,
    findChannel,
    findPerson,
  };
}
