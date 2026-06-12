import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

// discussions.js is CommonJS; load it the way the other server route tests do.
// This suite guards the hoist of the three route-match regex literals to
// module-scope consts (CHANNEL_MESSAGES_RE / CHANNEL_MESSAGES_SEARCH_RE /
// CHANNEL_RE), exported via routeRegexes. It proves the shared instances are
// stateless (no /g, no /y), referentially stable, dispatch the same handlers, and
// that the source allocates each literal once instead of rebuilding it per request.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');
const { routeRegexes } = discussionsRoutes;

// Invoke a discussions route handler with a minimal mocked ctx and capture the
// response handed to `json(res, status, payload)`. Mirrors the harness in
// next-discussions-channel-hasown-guard.test.mjs (rateLimit/readBody/saveJSON are
// stubbed so the write handlers run without real I/O).
async function invoke({ method = 'GET', pathname, search = '', ctx = {} }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    rateLimit: () => true,
    readBody: async () => ({}),
    saveJSON: () => {},
    ...ctx,
  };
  await discussionsRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

// Fresh store per test (the DELETE handler mutates it through loadJSON's shared ref).
function makeData() {
  return {
    channels: { general: { name: 'General', topic: 'Chat' } },
    messages: {
      general: [
        { id: 'm0', author: 'alice', text: 'hi world' },
        { id: 'm1', author: 'bob', text: 'second message' },
      ],
    },
  };
}

describe('exported route-match regexes — stateless, stable, correctly scoped', () => {
  it('exports routeRegexes with exactly the three named patterns', () => {
    assert.ok(routeRegexes && typeof routeRegexes === 'object');
    assert.deepEqual(
      Object.keys(routeRegexes).sort(),
      ['CHANNEL_MESSAGES_RE', 'CHANNEL_MESSAGES_SEARCH_RE', 'CHANNEL_RE'],
    );
  });

  for (const name of ['CHANNEL_MESSAGES_RE', 'CHANNEL_MESSAGES_SEARCH_RE', 'CHANNEL_RE']) {
    it(`${name} is a stateless RegExp (global === false, sticky === false)`, () => {
      const re = routeRegexes[name];
      assert.ok(re instanceof RegExp, `${name} is a RegExp`);
      assert.equal(re.global, false, `${name} has no /g flag`);
      assert.equal(re.sticky, false, `${name} has no /y flag`);
    });
  }

  it('each regex is one shared instance, referentially stable across two module accesses', () => {
    const again = require('../server/routes/discussions.js').routeRegexes;
    assert.equal(again.CHANNEL_MESSAGES_RE, routeRegexes.CHANNEL_MESSAGES_RE);
    assert.equal(again.CHANNEL_MESSAGES_SEARCH_RE, routeRegexes.CHANNEL_MESSAGES_SEARCH_RE);
    assert.equal(again.CHANNEL_RE, routeRegexes.CHANNEL_RE);
  });

  it('CHANNEL_MESSAGES_RE matches a channel messages path, not search or an extra segment', () => {
    assert.ok(routeRegexes.CHANNEL_MESSAGES_RE.test('/api/discussions/general/messages'));
    // Ends in `messages$`, so the search sub-path must fall through to the search regex.
    assert.ok(!routeRegexes.CHANNEL_MESSAGES_RE.test('/api/discussions/general/messages/search'));
    // `[^/]+` spans a single segment, so a two-segment id must NOT match.
    assert.ok(!routeRegexes.CHANNEL_MESSAGES_RE.test('/api/discussions/general/extra/messages'));
  });

  it('CHANNEL_MESSAGES_SEARCH_RE matches the search sub-path only', () => {
    assert.ok(routeRegexes.CHANNEL_MESSAGES_SEARCH_RE.test('/api/discussions/general/messages/search'));
    assert.ok(!routeRegexes.CHANNEL_MESSAGES_SEARCH_RE.test('/api/discussions/general/messages'));
  });

  it('CHANNEL_RE matches a single-segment channel path, not a messages path', () => {
    assert.ok(routeRegexes.CHANNEL_RE.test('/api/discussions/general'));
    assert.ok(!routeRegexes.CHANNEL_RE.test('/api/discussions/general/messages'));
  });
});

describe('handler dispatch is unchanged after the hoist', () => {
  it('GET /api/discussions/general/messages returns the channel messages', async () => {
    const data = makeData();
    const r = await invoke({
      pathname: '/api/discussions/general/messages',
      ctx: { loadJSON: () => data, DISCUSSIONS_FILE: '/tmp/disc-regex-hoist.json' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      messages: [
        { id: 'm0', author: 'alice', text: 'hi world' },
        { id: 'm1', author: 'bob', text: 'second message' },
      ],
      total: 2,
    });
  });

  it('GET /api/discussions/general/messages/search?q=hi returns the matching message', async () => {
    const data = makeData();
    const r = await invoke({
      pathname: '/api/discussions/general/messages/search',
      search: '?q=hi',
      ctx: { loadJSON: () => data, DISCUSSIONS_FILE: '/tmp/disc-regex-hoist.json' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      results: [{ id: 'm0', author: 'alice', text: 'hi world' }],
      total: 1,
    });
  });

  it('DELETE /api/discussions/general removes the channel', async () => {
    const data = makeData();
    const r = await invoke({
      method: 'DELETE',
      pathname: '/api/discussions/general',
      ctx: { loadJSON: () => data, DISCUSSIONS_FILE: '/tmp/disc-regex-hoist.json' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { success: true });
    assert.ok(!('general' in data.channels), 'channel was deleted from the store');
  });

  it('GET /api/discussions/general/extra/messages does not match the messages handler (404 channel)', async () => {
    // The two-segment path fails CHANNEL_MESSAGES_RE, then falls through to
    // CHANNEL_RE's DELETE-only guard (wrong method) and ends unmatched, so the
    // captured response stays null (no handler claimed it).
    const data = makeData();
    const r = await invoke({
      pathname: '/api/discussions/general/extra/messages',
      ctx: { loadJSON: () => data, DISCUSSIONS_FILE: '/tmp/disc-regex-hoist.json' },
    });
    assert.equal(r, null, 'no discussions handler matched the extra-segment path');
  });
});

describe('source structure — route regexes hoisted once, inline literals dropped', () => {
  const SRC = fs.readFileSync(new URL('../server/routes/discussions.js', import.meta.url), 'utf-8');
  const count = (hay, needle) => hay.split(needle).length - 1;

  it('declares each route regex exactly once at module scope, with the exact literals', () => {
    assert.equal(count(SRC, 'const CHANNEL_MESSAGES_RE ='), 1);
    assert.equal(count(SRC, 'const CHANNEL_MESSAGES_SEARCH_RE ='), 1);
    assert.equal(count(SRC, 'const CHANNEL_RE ='), 1);
    assert.ok(SRC.includes(String.raw`const CHANNEL_MESSAGES_RE = /^\/api\/discussions\/[^/]+\/messages$/;`));
    assert.ok(SRC.includes(String.raw`const CHANNEL_MESSAGES_SEARCH_RE = /^\/api\/discussions\/[^/]+\/messages\/search$/;`));
    assert.ok(SRC.includes(String.raw`const CHANNEL_RE = /^\/api\/discussions\/[^/]+$/;`));
  });

  it('exports the three via module.exports.routeRegexes', () => {
    assert.ok(SRC.includes('module.exports.routeRegexes = { CHANNEL_MESSAGES_RE, CHANNEL_MESSAGES_SEARCH_RE, CHANNEL_RE };'));
  });

  it('no longer allocates any discussions route-match literal inline, and dedupes the messages pattern', () => {
    // No inline `pathname.match(/^\/api\/discussions...)` literal remains (verify.sh gate).
    assert.equal(count(SRC, 'pathname.match(/^\\/api\\/discussions'), 0);
    // The /messages literal survives only in its const def (was 4 inline copies).
    assert.equal(count(SRC, String.raw`/^\/api\/discussions\/[^/]+\/messages$/`), 1);
    // CHANNEL_MESSAGES_RE is referenced by its def plus the four message handlers.
    assert.ok(count(SRC, 'CHANNEL_MESSAGES_RE') >= 5);
  });
});
