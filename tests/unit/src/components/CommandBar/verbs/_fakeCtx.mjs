/**
 * The context a verb is handed, faked, and a log of everything it did with it.
 *
 * A verb's whole job is to turn an argument line into one write and one
 * sentence, so the only way to test one is to hand it a context and read back
 * what it called and what it said. Nothing here talks to a server: the writes
 * answer with the shapes the real endpoints answer with, which is what lets a
 * test pin the rule that a verb echoes the server rather than the typing.
 *
 * The resolvers below are stand-ins for useChat's, deliberately minimal: they
 * exist to return one row, no row, or null for an ambiguous name, which is the
 * only thing the verbs care about.
 */

export const YOU = Object.freeze({userId: 'u-you', role: 'admin', canManage: true});

export const ALICE = Object.freeze({id: 'u-alice', username: 'alice', name: 'Alice Ng', email: 'alice@example.com'});
export const BOB = Object.freeze({id: 'u-bob', username: 'bob', name: 'Bob Ray', email: 'bob@example.com'});

export const DESIGN = Object.freeze({
  id: 'c-design', kind: 'public', name: 'design', topic: 'pixels',
  createdBy: 'u-you', memberCount: 3, joined: true, archivedAt: null,
});

export const DM = Object.freeze({
  id: 'c-dm', kind: 'dm', name: null, peerId: 'u-alice', peerUsername: 'alice',
  createdBy: 'u-alice', memberCount: 2, joined: true, archivedAt: null,
});

/** A conversation with two of the reader's messages, the newest of them deleted. */
export const MESSAGES = Object.freeze([
  {id: 'm1', seq: 1, userId: 'u-alice', body: 'morning', deletedAt: null},
  {id: 'm2', seq: 2, userId: 'u-you', body: 'the older thing I said', deletedAt: null},
  {id: 'm3', seq: 3, userId: 'u-you', body: 'the newest thing I said', deletedAt: null},
  {id: 'm4', seq: 4, userId: 'u-alice', body: 'noted', deletedAt: null},
  {id: 'm5', seq: 5, userId: 'u-you', body: null, deletedAt: '2026-01-01T00:00:00.000Z'},
]);

const strip = (name) => String(name).replace(/^[#@]/, '').toLowerCase();

/** One match or nothing: two matches are as good as none, which is the point. */
function only(rows) {
  return rows.length === 1 ? rows[0] : null;
}

/**
 * @param options.target   what the pane is pointed at, null for the assistant
 * @param options.writes   per-write answers, a value or a function of its arguments
 */
export function makeCtx(options = {}) {
  const {
    sessionId = 's1',
    target = {channelId: DESIGN.id, label: '#design'},
    channels = [DESIGN, DM],
    people = [ALICE, BOB],
    you = YOU,
    status = 'ready',
    messages = MESSAGES,
    commands = [],
    writes = {},
    splitResult = 's2',
    closeResult = true,
  } = options;

  const log = {notes: [], fails: [], targets: [], calls: [], asked: [], said: [], cancelled: []};

  /** A recorded write that answers with whatever the test asked it to. */
  const write = (name, fallback) => async (...args) => {
    log.calls.push([name, ...args]);
    if (!(name in writes)) return fallback;
    const answer = writes[name];
    return typeof answer === 'function' ? answer(...args) : answer;
  };

  const session = {id: sessionId, target, entries: [], busy: false, sendError: null};

  const ctx = {
    session,
    sessions: {
      MAX_SESSIONS: 4,
      clear: (id) => log.calls.push(['clear', id]),
      split: () => { log.calls.push(['split']); return splitResult; },
      close: (id) => { log.calls.push(['close', id]); return closeResult; },
      setTarget: (id, next) => log.targets.push([id, next]),
      append: (id, kind, text) => log.calls.push(['append', id, kind, text]),
      patch: (id, partial) => log.calls.push(['patch', id, partial]),
    },
    chat: {
      status,
      channels,
      people,
      you,
      conversation: (channelId) => {
        log.calls.push(['conversation', channelId]);
        return {messages, loading: false, loadingOlder: false, hasMore: false, error: null, lastReadSeq: 0};
      },
      findPerson: (name) => only(people.filter((p) => [p.username, p.name, p.email]
        .some((field) => String(field).toLowerCase() === strip(name)))),
      findChannel: (name) => only(channels.filter((c) => String(c.name).toLowerCase() === strip(name))),
      openDm: write('openDm', DM.id),
      createChannel: write('createChannel', 'c-new'),
      invite: write('invite', {id: 'inv-1', email: 'someone@example.com'}),
      join: write('join', {channel: DESIGN, joined: true}),
      leave: write('leave', {left: true}),
      archive: write('archive', {channel: DESIGN, changed: true}),
      update: write('update', {channel: DESIGN}),
      removeChannel: write('removeChannel', {deleted: true}),
      addMember: write('addMember', {added: true}),
      removeMember: write('removeMember', {removed: true}),
      deleteMessage: write('deleteMessage', {deleted: true}),
      send: write('send', {}),
      refresh: write('refresh', undefined),
    },
    assistant: {
      ask: async (id, text) => { log.asked.push([id, text]); },
      cancel: (id) => log.cancelled.push(id),
      busy: () => false,
    },
    commands,
    navigate: (href) => log.calls.push(['navigate', href]),
    say: (text) => log.said.push(text),
    note: (text) => log.notes.push(text),
    fail: (text) => log.fails.push(text),
  };

  return {ctx, log};
}

/** Every call of one write, so a test can assert both that and its arguments. */
export const callsTo = (log, name) => log.calls.filter(([called]) => called === name);

/** Everything a verb said, whether it worked or not. Nothing said is a bug. */
export const spoke = (log) => [...log.notes, ...log.fails];
