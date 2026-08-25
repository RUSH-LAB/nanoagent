/**
 * server/routes/discussions.js: discussion channels and their messages.
 *
 * Consolidated from the sixteen per-branch suites that used to cover this
 * module. The five message handlers share one guard prologue (rate limit,
 * channel-id decode, own-key channel lookup), so those arms are driven once per
 * handler from a table rather than restated in a file each.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke, FILES} from './_harness.mjs';

const routes = loadRoute('discussions');
const {DISCUSSIONS_FILE} = FILES;

const msg = (id, over = {}) => ({id, author: 'Ada', text: 'hello', createdAt: '2026-01-01T00:00:00.000Z', ...over});

/** A store with one channel `general` holding the given messages. */
function withChannel(messages = [], channels = {general: {name: 'General', topic: '', linkedPage: null}}) {
  return {[DISCUSSIONS_FILE]: {channels, messages: {general: messages}}};
}

const MESSAGES_PATH = '/api/discussions/general/messages';
// decodeURIComponent throws on a lone percent, which is the only way to reach
// the per-handler `Invalid channel id` guard.
const MALFORMED_PATH = '/api/discussions/%/messages';

// ── Channels ──────────────────────────────────────────────────────────────

describe('GET /api/discussions (list channels)', () => {
  it('projects each channel to {id, ...stored, messageCount}', async () => {
    const store = {[DISCUSSIONS_FILE]: {
      channels: {a: {name: 'A', topic: 't'}, b: {name: 'B', topic: ''}},
      messages: {a: [msg('m1'), msg('m2')]},
    }};
    const r = await invoke(routes, {path: '/api/discussions', ctx: makeCtx({store})});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.channels, [
      {id: 'a', name: 'A', topic: 't', messageCount: 2},
      // b has no entry in the messages map, so it falls back to 0.
      {id: 'b', name: 'B', topic: '', messageCount: 0},
    ]);
  });

  it('treats an absent messages map as empty', async () => {
    const store = {[DISCUSSIONS_FILE]: {channels: {a: {name: 'A'}}}};
    const r = await invoke(routes, {path: '/api/discussions', ctx: makeCtx({store})});
    assert.deepEqual(r.payload.channels, [{id: 'a', name: 'A', messageCount: 0}]);
  });

  it('returns an empty list when the store has no channels', async () => {
    const r = await invoke(routes, {path: '/api/discussions'});
    assert.deepEqual([r.status, r.payload], [200, {channels: []}]);
  });
});

describe('POST /api/discussions (create channel)', () => {
  it('returns 429 without reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/discussions', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'disc-create:127.0.0.1', maxPerMinute: 10}]);
    assert.equal(reads, 0);
  });

  const GUARDS = [
    {name: 'an omitted name', body: {}, status: 400, error: 'Missing or invalid channel name'},
    {name: 'a non-string name', body: {name: 7}, status: 400, error: 'Missing or invalid channel name'},
    {name: 'a name over 100 characters', body: {name: 'n'.repeat(101)}, status: 400, error: 'Channel name too long (max 100 characters)'},
    {name: 'a non-string topic', body: {name: 'ok', topic: 7}, status: 400, error: 'topic must be a string'},
    {name: 'a topic over 500 characters', body: {name: 'ok', topic: 't'.repeat(501)}, status: 400, error: 'Topic must be 500 characters or fewer'},
    {name: 'a non-string linkedPage', body: {name: 'ok', linkedPage: 7}, status: 400, error: 'linkedPage must be a string'},
    {name: 'a linkedPage over 500 characters', body: {name: 'ok', linkedPage: 'p'.repeat(501)}, status: 400, error: 'linkedPage must be 500 characters or fewer'},
    // The slug strips every non-alphanumeric character, so a punctuation-only
    // name reduces to the empty string.
    {name: 'a name that slugifies to empty', body: {name: '!!!'}, status: 400, error: 'Channel name must contain at least one alphanumeric character'},
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/discussions', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('returns 409 when the slug already exists', async () => {
    const ctx = makeCtx({store: withChannel()});
    const r = await invoke(routes, {method: 'POST', path: '/api/discussions', body: {name: 'General'}, ctx});
    assert.deepEqual([r.status, r.payload], [409, {error: 'Channel already exists'}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  it('creates the channel, slugifying the name, and saves once', async () => {
    const ctx = makeCtx();
    const body = {name: 'My New Channel!', topic: 'Chat', linkedPage: '/docs/a'};
    const r = await invoke(routes, {method: 'POST', path: '/api/discussions', body, ctx});
    assert.equal(r.status, 201);
    assert.equal(r.payload.channel.id, 'my-new-channel');
    const {createdAt, ...stable} = r.payload.channel;
    assert.deepEqual(stable, {id: 'my-new-channel', name: 'My New Channel!', topic: 'Chat', linkedPage: '/docs/a', messageCount: 0});
    assert.equal(ctx.calls.saveJSON.length, 1);
    assert.deepEqual(ctx.store[DISCUSSIONS_FILE].messages['my-new-channel'], []);
  });

  it('defaults an omitted topic to an empty string and linkedPage to null', async () => {
    const r = await invoke(routes, {method: 'POST', path: '/api/discussions', body: {name: 'plain'}});
    assert.equal(r.payload.channel.topic, '');
    assert.equal(r.payload.channel.linkedPage, null);
  });
});

describe('DELETE /api/discussions/:channelId (delete channel)', () => {
  it('returns 429 with the disc-del-ch key and limit 10, doing no IO', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/discussions/general', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'disc-del-ch:127.0.0.1', maxPerMinute: 10}]);
    assert.deepEqual(ctx.calls.loadJSON, []);
  });

  it('returns 400 for a malformed channel id before any IO', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'DELETE', path: '/api/discussions/%', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid channel id'}]);
    assert.deepEqual(ctx.calls.loadJSON, []);
  });

  it('deletes the channel and its messages', async () => {
    const ctx = makeCtx({store: withChannel([msg('m1')])});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/discussions/general', ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    const saved = ctx.store[DISCUSSIONS_FILE];
    assert.deepEqual(saved.channels, {});
    assert.deepEqual(saved.messages, {});
  });

  it('returns 400 from the outer catch when loadJSON throws', async () => {
    const ctx = makeCtx({loadJSON() { throw new Error('store unreadable'); }});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/discussions/general', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid request'}]);
  });
});

// ── The shared guard prologue on the five channel-scoped handlers ─────────

describe('channel-scoped guard prologue', () => {
  const HANDLERS = [
    {method: 'GET', path: MESSAGES_PATH, malformed: MALFORMED_PATH, gate: null},
    {method: 'GET', path: '/api/discussions/general/messages/search', malformed: '/api/discussions/%/messages/search', gate: null, query: {q: 'x'}},
    {method: 'POST', path: MESSAGES_PATH, malformed: MALFORMED_PATH, gate: {key: 'disc-msg:127.0.0.1', maxPerMinute: 30}},
    {method: 'PATCH', path: MESSAGES_PATH, malformed: MALFORMED_PATH, gate: {key: 'disc-edit:127.0.0.1', maxPerMinute: 30}},
    {method: 'DELETE', path: MESSAGES_PATH, malformed: MALFORMED_PATH, gate: {key: 'disc-delete:127.0.0.1', maxPerMinute: 20}},
  ];

  for (const {method, path: p, malformed, gate, query} of HANDLERS) {
    if (gate) {
      it(`${method} ${p} returns 429 with key ${gate.key.split(':')[0]} and limit ${gate.maxPerMinute}, doing no IO`, async () => {
        let reads = 0;
        const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
        const r = await invoke(routes, {method, path: p, query, ctx});
        assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
        assert.deepEqual(ctx.calls.rateLimit, [gate]);
        assert.deepEqual(ctx.calls.loadJSON, []);
        assert.equal(reads, 0);
      });
    }

    it(`${method} ${p} returns 400 for a malformed channel id, never throwing`, async () => {
      let reads = 0;
      const ctx = makeCtx({readBody: async () => { reads++; return {}; }});
      const r = await invoke(routes, {method, path: malformed, query, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid channel id'}]);
      assert.deepEqual(ctx.calls.loadJSON, []);
      assert.equal(reads, 0);
    });

    it(`${method} ${p} returns 404 when the channels map is absent`, async () => {
      const ctx = makeCtx({store: {[DISCUSSIONS_FILE]: {}}});
      const r = await invoke(routes, {method, path: p, query, ctx});
      assert.deepEqual([r.status, r.payload], [404, {error: 'Channel not found'}]);
    });

    // A request-controlled channel id such as `__proto__` resolves to a truthy
    // inherited value, so the lookup must be an own-key check.
    for (const key of ['__proto__', 'constructor', 'toString', 'nope']) {
      it(`${method} ${p} returns 404 for the non-own channel ${JSON.stringify(key)}`, async () => {
        const target = p.replace('general', key);
        const ctx = makeCtx({store: withChannel([msg('m1')])});
        const r = await invoke(routes, {method, path: target, query, ctx});
        assert.deepEqual([r.status, r.payload], [404, {error: 'Channel not found'}]);
      });
    }
  }
});

// ── Messages: list ────────────────────────────────────────────────────────

describe('GET /api/discussions/:channelId/messages', () => {
  const THREE = [msg('m1'), msg('m2'), msg('m3')];

  it('returns the messages and total for a real channel', async () => {
    const r = await invoke(routes, {path: MESSAGES_PATH, ctx: makeCtx({store: withChannel(THREE)})});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.messages.map(m => m.id), ['m1', 'm2', 'm3']);
    assert.equal(r.payload.total, 3);
  });

  for (const [label, store] of [
    ['the channel has no message array', {[DISCUSSIONS_FILE]: {channels: {general: {}}, messages: {}}}],
    ['the messages map is absent', {[DISCUSSIONS_FILE]: {channels: {general: {}}}}],
  ]) {
    it(`returns an empty page when ${label}`, async () => {
      const r = await invoke(routes, {path: MESSAGES_PATH, ctx: makeCtx({store})});
      assert.deepEqual([r.status, r.payload], [200, {messages: [], total: 0}]);
    });
  }

  // numericParam guards NaN and caps the upper bound but passes a negative
  // through; slice(0, negative) counts from the END and would silently drop the
  // last |limit| messages while total still reported the full count.
  const PAGINATION = [
    {name: 'absent limit and offset', query: {}, ids: ['m1', 'm2', 'm3']},
    {name: 'a valid limit', query: {limit: '2'}, ids: ['m1', 'm2']},
    {name: 'a valid offset', query: {offset: '1'}, ids: ['m2', 'm3']},
    {name: 'a valid limit and offset', query: {limit: '1', offset: '1'}, ids: ['m2']},
    {name: 'an over-cap limit clamped to 1000', query: {limit: '99999'}, ids: ['m1', 'm2', 'm3']},
    {name: 'a non-numeric limit falling back to the default', query: {limit: 'abc'}, ids: ['m1', 'm2', 'm3']},
    {name: 'a non-numeric offset falling back to 0', query: {offset: 'abc'}, ids: ['m1', 'm2', 'm3']},
    {name: 'limit=-1 clamped to 0', query: {limit: '-1'}, ids: []},
    {name: 'limit=-2 clamped to 0', query: {limit: '-2'}, ids: []},
    {name: 'a negative offset clamped to 0', query: {offset: '-5'}, ids: ['m1', 'm2', 'm3']},
  ];
  for (const {name, query, ids} of PAGINATION) {
    it(`handles ${name}`, async () => {
      const r = await invoke(routes, {path: MESSAGES_PATH, query, ctx: makeCtx({store: withChannel(THREE)})});
      assert.deepEqual(r.payload.messages.map(m => m.id), ids);
      assert.equal(r.payload.total, 3, 'total always reports the full count');
    });
  }
});

describe('numericParam (re-exported by the module)', () => {
  const {numericParam} = routes;
  const CASES = [
    {name: 'null falls back to the default', args: [null, 200, 1000], want: 200},
    {name: 'an empty string falls back to the default', args: ['', 200, 1000], want: 200},
    {name: 'a non-numeric value falls back rather than yielding NaN', args: ['abc', 200, 1000], want: 200},
    {name: 'a valid value passes through', args: ['42', 200, 1000], want: 42},
    {name: 'a value above the cap is clamped', args: ['99999', 200, 1000], want: 1000},
  ];
  for (const {name, args, want} of CASES) {
    it(name, () => assert.equal(numericParam(...args), want));
  }
});

// ── Messages: search ──────────────────────────────────────────────────────

describe('GET /api/discussions/:channelId/messages/search', () => {
  const SEARCH_PATH = '/api/discussions/general/messages/search';
  const CORPUS = [
    msg('m1', {text: 'Hello World', author: 'Ada'}),
    msg('m2', {text: 'other', author: 'Grace Hopper'}),
    msg('m3', {text: undefined, author: 'Ada'}),
    msg('m4', {text: 'has text', author: undefined}),
  ];

  for (const [label, query] of [['an omitted q', {}], ['an empty q', {q: ''}], ['a whitespace-only q', {q: '   '}]]) {
    it(`returns 400 for ${label} without reading the store`, async () => {
      const ctx = makeCtx({loadJSON() { throw new Error('store must not be read'); }});
      const r = await invoke(routes, {path: SEARCH_PATH, query, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Missing query'}]);
    });
  }

  const MATCHES = [
    {name: 'message text', q: 'hello', ids: ['m1']},
    {name: 'author name', q: 'hopper', ids: ['m2']},
    {name: 'text case-insensitively', q: 'HELLO', ids: ['m1']},
    // The `|| ''` fallbacks mean a message missing one field still matches on
    // the other rather than throwing.
    {name: 'author when text is absent', q: 'ada', ids: ['m1', 'm3']},
    {name: 'text when author is absent', q: 'has text', ids: ['m4']},
  ];
  for (const {name, q, ids} of MATCHES) {
    it(`matches on ${name}`, async () => {
      const r = await invoke(routes, {path: SEARCH_PATH, query: {q}, ctx: makeCtx({store: withChannel(CORPUS)})});
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload.results.map(m => m.id), ids);
      assert.equal(r.payload.total, ids.length);
    });
  }

  it('returns an empty result set when nothing matches', async () => {
    const r = await invoke(routes, {path: SEARCH_PATH, query: {q: 'zzz'}, ctx: makeCtx({store: withChannel(CORPUS)})});
    assert.deepEqual([r.status, r.payload], [200, {results: [], total: 0}]);
  });
});

// ── Messages: post, edit, delete ──────────────────────────────────────────

describe('POST /api/discussions/:channelId/messages', () => {
  const GUARDS = [
    {name: 'an omitted text', body: {}, error: 'Missing or invalid message text'},
    {name: 'an empty-string text', body: {text: ''}, error: 'Missing or invalid message text'},
    {name: 'a non-string text', body: {text: 7}, error: 'Missing or invalid message text'},
    {name: 'text over 5000 characters', body: {text: 't'.repeat(5001)}, error: 'Message text must be 5000 characters or fewer'},
    {name: 'a non-string author', body: {text: 'ok', author: 7}, error: 'author must be a string'},
    {name: 'an author over 100 characters', body: {text: 'ok', author: 'a'.repeat(101)}, error: 'Author must be 100 characters or fewer'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx({store: withChannel()});
      const r = await invoke(routes, {method: 'POST', path: MESSAGES_PATH, body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  // The cap is exclusive (`> 5000`), so exactly 5000 must pass.
  it('accepts text of exactly 5000 characters', async () => {
    const ctx = makeCtx({store: withChannel()});
    const r = await invoke(routes, {method: 'POST', path: MESSAGES_PATH, body: {text: 't'.repeat(5000)}, ctx});
    assert.equal(r.status, 201);
    assert.equal(ctx.calls.saveJSON.length, 1);
  });

  it('appends the message and persists it', async () => {
    const ctx = makeCtx({store: withChannel([msg('m1')])});
    const r = await invoke(routes, {method: 'POST', path: MESSAGES_PATH, body: {text: 'new one', author: 'Grace'}, ctx});
    assert.equal(r.status, 201);
    const {id, createdAt, ...stable} = r.payload.message;
    assert.deepEqual(stable, {author: 'Grace', text: 'new one'});
    assert.match(id, /^msg_\d+_[a-z0-9]+$/);
    assert.deepEqual(ctx.store[DISCUSSIONS_FILE].messages.general.map(m => m.id), ['m1', id]);
  });

  for (const [label, extra] of [['omitted', {}], ['an empty string', {author: ''}]]) {
    it(`defaults the author to Anonymous when it is ${label}`, async () => {
      const r = await invoke(routes, {method: 'POST', path: MESSAGES_PATH, body: {text: 'x', ...extra}, ctx: makeCtx({store: withChannel()})});
      assert.equal(r.payload.message.author, 'Anonymous');
    });
  }

  it('lazily creates the channel message array when it is absent', async () => {
    const store = {[DISCUSSIONS_FILE]: {channels: {general: {}}}};
    const ctx = makeCtx({store});
    const r = await invoke(routes, {method: 'POST', path: MESSAGES_PATH, body: {text: 'first'}, ctx});
    assert.equal(r.status, 201);
    assert.equal(ctx.store[DISCUSSIONS_FILE].messages.general.length, 1);
  });
});

describe('PATCH /api/discussions/:channelId/messages', () => {
  const GUARDS = [
    {name: 'an omitted messageId', body: {text: 'x'}, status: 400, error: 'Missing or invalid messageId'},
    {name: 'a non-string messageId', body: {messageId: 7, text: 'x'}, status: 400, error: 'Missing or invalid messageId'},
    {name: 'an omitted text', body: {messageId: 'm1'}, status: 400, error: 'Missing or invalid text'},
    {name: 'a non-string text', body: {messageId: 'm1', text: 7}, status: 400, error: 'Missing or invalid text'},
    {name: 'text over 5000 characters', body: {messageId: 'm1', text: 't'.repeat(5001)}, status: 400, error: 'Message text must be 5000 characters or fewer'},
    {name: 'an unknown message id', body: {messageId: 'nope', text: 'x'}, status: 404, error: 'Message not found'},
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx({store: withChannel([msg('m1')])});
      const r = await invoke(routes, {method: 'PATCH', path: MESSAGES_PATH, body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('returns 404 when the channel has no message array', async () => {
    const store = {[DISCUSSIONS_FILE]: {channels: {general: {}}}};
    const r = await invoke(routes, {method: 'PATCH', path: MESSAGES_PATH, body: {messageId: 'm1', text: 'x'}, ctx: makeCtx({store})});
    assert.deepEqual([r.status, r.payload], [404, {error: 'No messages in channel'}]);
  });

  // The cap is exclusive (`> 5000`), so exactly 5000 must pass.
  it('accepts text of exactly 5000 characters and saves once', async () => {
    const ctx = makeCtx({store: withChannel([msg('m1')])});
    const r = await invoke(routes, {method: 'PATCH', path: MESSAGES_PATH, body: {messageId: 'm1', text: 't'.repeat(5000)}, ctx});
    assert.equal(r.status, 200);
    assert.equal(ctx.calls.saveJSON.length, 1);
  });

  it('updates the text, stamps editedAt, and saves once', async () => {
    const ctx = makeCtx({store: withChannel([msg('m1'), msg('m2')])});
    const r = await invoke(routes, {method: 'PATCH', path: MESSAGES_PATH, body: {messageId: 'm1', text: 'edited'}, ctx});
    assert.deepEqual([r.status, r.payload.success], [200, true]);
    assert.equal(r.payload.message.text, 'edited');
    assert.ok(r.payload.message.editedAt);
    const saved = ctx.store[DISCUSSIONS_FILE].messages.general;
    assert.deepEqual(saved.map(m => m.text), ['edited', 'hello'], 'siblings are untouched');
    assert.equal(ctx.calls.saveJSON.length, 1);
  });
});

describe('DELETE /api/discussions/:channelId/messages', () => {
  // The delete handler checks only truthiness, with no type check, so a truthy
  // non-string id advances to the lookup and reports Message not found.
  const GUARDS = [
    {name: 'an omitted messageId', body: {}, status: 400, error: 'Missing messageId'},
    {name: 'an empty-string messageId', body: {messageId: ''}, status: 400, error: 'Missing messageId'},
    {name: 'the falsy number 0', body: {messageId: 0}, status: 400, error: 'Missing messageId'},
    {name: 'a null messageId', body: {messageId: null}, status: 400, error: 'Missing messageId'},
    {name: 'the truthy non-string 42', body: {messageId: 42}, status: 404, error: 'Message not found'},
    {name: 'an unknown messageId', body: {messageId: 'nope'}, status: 404, error: 'Message not found'},
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx({store: withChannel([msg('m1')])});
      const r = await invoke(routes, {method: 'DELETE', path: MESSAGES_PATH, body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  for (const [label, store] of [
    ['the messages map is absent', {[DISCUSSIONS_FILE]: {channels: {general: {}}}}],
    ['the channel has no message array', {[DISCUSSIONS_FILE]: {channels: {general: {}}, messages: {other: []}}}],
  ]) {
    it(`returns 404 No messages in channel when ${label}`, async () => {
      const r = await invoke(routes, {method: 'DELETE', path: MESSAGES_PATH, body: {messageId: 'm1'}, ctx: makeCtx({store})});
      assert.deepEqual([r.status, r.payload], [404, {error: 'No messages in channel'}]);
    });
  }

  it('removes the matching message, preserves siblings, and saves once', async () => {
    const ctx = makeCtx({store: withChannel([msg('m1'), msg('m2'), msg('m3')])});
    const r = await invoke(routes, {method: 'DELETE', path: MESSAGES_PATH, body: {messageId: 'm2'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(ctx.store[DISCUSSIONS_FILE].messages.general.map(m => m.id), ['m1', 'm3']);
    assert.equal(ctx.calls.saveJSON.length, 1);
  });
});

// ── Route matching ────────────────────────────────────────────────────────

describe('exported route-match regexes', () => {
  const {routeRegexes} = routes;

  it('exports exactly the three named patterns, each one shared stateless instance', () => {
    assert.deepEqual(Object.keys(routeRegexes).sort(), ['CHANNEL_MESSAGES_RE', 'CHANNEL_MESSAGES_SEARCH_RE', 'CHANNEL_RE']);
    for (const [name, re] of Object.entries(routeRegexes)) {
      // No /g and no /y, so .test() never reads or mutates lastIndex.
      assert.equal(re.global, false, name);
      assert.equal(re.sticky, false, name);
      assert.strictEqual(loadRoute('discussions').routeRegexes[name], re, name);
    }
  });

  const MATCHES = [
    ['CHANNEL_MESSAGES_RE', '/api/discussions/general/messages', true],
    ['CHANNEL_MESSAGES_RE', '/api/discussions/general/messages/search', false],
    ['CHANNEL_MESSAGES_RE', '/api/discussions/a/b/messages', false],
    ['CHANNEL_MESSAGES_SEARCH_RE', '/api/discussions/general/messages/search', true],
    ['CHANNEL_MESSAGES_SEARCH_RE', '/api/discussions/general/messages', false],
    ['CHANNEL_RE', '/api/discussions/general', true],
    ['CHANNEL_RE', '/api/discussions/general/messages', false],
  ];
  for (const [name, p, expected] of MATCHES) {
    it(`${name} ${expected ? 'matches' : 'rejects'} ${p}`, () => {
      assert.equal(routeRegexes[name].test(p), expected);
    });
  }

  it('does not dispatch a two-segment channel path to the messages handler', async () => {
    const ctx = makeCtx({store: withChannel([msg('m1')])});
    const r = await invoke(routes, {path: '/api/discussions/general/extra/messages', ctx});
    assert.equal(r.status, undefined, 'no handler replies, so the dispatcher falls through to 404');
  });
});

// Each body-reading handler wraps its work in one try whose catch returns a
// fixed 400. The channel lookup precedes the body read on the message
// handlers, so these drive a real channel.
describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'POST', path: '/api/discussions'},
    {method: 'POST', path: MESSAGES_PATH},
    {method: 'PATCH', path: MESSAGES_PATH},
    {method: 'DELETE', path: MESSAGES_PATH},
  ];
  for (const {method, path: p} of CASES) {
    for (const [label, readBody] of [
      ['readBody rejects', async () => { throw new Error('bad json'); }],
      ['readBody resolves null', async () => null],
    ]) {
      it(`${method} ${p} returns 400 Invalid request when ${label}, without saving`, async () => {
        const ctx = makeCtx({store: withChannel([msg('m1')]), readBody});
        const r = await invoke(routes, {method, path: p, ctx});
        assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid request'}]);
        assert.deepEqual(ctx.calls.saveJSON, []);
      });
    }
  }
});
