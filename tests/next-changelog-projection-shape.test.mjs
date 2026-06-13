import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Characterization test for the pure projection behind GET /api/changelog in
// server/routes/misc-tools.js. The handler reads two stubbable loadJSON sources
// (comments keyed by page, discussion messages keyed by channel), projects each
// into a flat event, sorts the merged list descending by timestamp, and returns
// {events: events.slice(0, limit), total: events.length}. It touches no clock,
// no randomness, no network, and no filesystem scan, so its exact output shape,
// field set, text truncation, and sort order pin down to one deepStrictEqual
// golden per case. The source stays untouched; this file only observes.

// misc-tools.js is CommonJS; load it the way the sibling server route tests do.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../server/routes/misc-tools.js');

// File tokens the changelog handler reads through loadJSON. The mocked loadJSON
// dispatches on these so comments and discussions come from separate fixtures.
const COMMENTS_FILE = '/tmp/next-changelog-comments.json';
const DISCUSSIONS_FILE = '/tmp/next-changelog-discussions.json';

// Drive GET /api/changelog with a mocked ctx and capture the response the
// handler hands to json(res, status, payload). No ?limit= is sent, so
// numericParam(null, 50, 200) yields the default 50; every fixture below holds
// far fewer than 50 events, so slice(0, 50) is a no-op and never truncates the
// golden. numericParam is required at the module top from ../server-utils, so it
// is NOT a ctx field and is never stubbed here. The limit clamp itself is pinned
// by next-misc-tools-limit-guards and next-misc-tools-negative-limit-clamp, so
// this file owns only the projection shape and sort.
async function getChangelog(ctx) {
  const pathname = '/api/changelog';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    ...ctx,
  };
  await miscToolsRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

// A ctx whose loadJSON returns the comments fixture for COMMENTS_FILE and the
// discussions fixture for DISCUSSIONS_FILE.
function changelogCtx(comments, discData) {
  return {
    loadJSON: file => {
      if (file === COMMENTS_FILE) return comments;
      if (file === DISCUSSIONS_FILE) return discData;
      return {};
    },
    COMMENTS_FILE,
    DISCUSSIONS_FILE,
  };
}

describe('GET /api/changelog projection shape and sort', () => {
  it('merges comment and message events into one descending feed, pinning both event shapes and the 100-char text truncation', async () => {
    // Two comment pages and two discussion channels, with distinct timestamps
    // chosen so the descending order alternates message, comment, message,
    // comment. One comment and one message carry text longer than 100 characters
    // so the slice(0, 100) truncation is pinned for both event shapes.
    const longCommentText = 'C'.repeat(100) + 'OVERFLOW_comment_tail_that_must_be_dropped';
    const longMessageText = 'M'.repeat(100) + 'OVERFLOW_message_tail_that_must_be_dropped';
    const comments = {
      'content/alpha.md': [
        { author: 'alice', text: longCommentText, createdAt: '2026-03-03T10:00:00Z' },
      ],
      'content/beta.md': [
        { author: 'bob', text: 'nice post', createdAt: '2026-03-01T10:00:00Z' },
      ],
    };
    const discData = {
      messages: {
        general: [
          { author: 'mallory', text: longMessageText, createdAt: '2026-03-04T10:00:00Z' },
        ],
        random: [
          { author: 'rick', text: 'see you', createdAt: '2026-03-02T10:00:00Z' },
        ],
      },
    };
    const r = await getChangelog(changelogCtx(comments, discData));
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, {
      events: [
        { type: 'message', channel: 'general', author: 'mallory', text: 'M'.repeat(100), timestamp: '2026-03-04T10:00:00Z' },
        { type: 'comment', page: 'content/alpha.md', author: 'alice', text: 'C'.repeat(100), timestamp: '2026-03-03T10:00:00Z' },
        { type: 'message', channel: 'random', author: 'rick', text: 'see you', timestamp: '2026-03-02T10:00:00Z' },
        { type: 'comment', page: 'content/beta.md', author: 'bob', text: 'nice post', timestamp: '2026-03-01T10:00:00Z' },
      ],
      total: 4,
    });
  });

  it('skips comment pages and discussion channels whose value is not an array', async () => {
    // content/notarray.md maps to a plain object and the "broken" channel maps to
    // a string; both fail Array.isArray and contribute nothing. Only the two real
    // array entries become events.
    const comments = {
      'content/valid.md': [
        { author: 'carol', text: 'real comment', createdAt: '2026-02-02T00:00:00Z' },
      ],
      'content/notarray.md': { not: 'an array' },
    };
    const discData = {
      messages: {
        general: [
          { author: 'dave', text: 'real message', createdAt: '2026-02-01T00:00:00Z' },
        ],
        broken: 'not an array',
      },
    };
    const r = await getChangelog(changelogCtx(comments, discData));
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, {
      events: [
        { type: 'comment', page: 'content/valid.md', author: 'carol', text: 'real comment', timestamp: '2026-02-02T00:00:00Z' },
        { type: 'message', channel: 'general', author: 'dave', text: 'real message', timestamp: '2026-02-01T00:00:00Z' },
      ],
      total: 2,
    });
  });

  it('contributes no message events when discData has no messages key', async () => {
    // discData lacks a messages property, so (discData.messages || {}) is empty
    // and the message loop iterates nothing. Only comment events appear.
    const comments = {
      'content/only.md': [
        { author: 'erin', text: 'sole comment', createdAt: '2026-04-01T00:00:00Z' },
      ],
    };
    const discData = {};
    const r = await getChangelog(changelogCtx(comments, discData));
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, {
      events: [
        { type: 'comment', page: 'content/only.md', author: 'erin', text: 'sole comment', timestamp: '2026-04-01T00:00:00Z' },
      ],
      total: 1,
    });
  });

  it('sorts an event with no timestamp to the end via the (timestamp || empty) fallback', async () => {
    // The second comment has no createdAt, so its projected timestamp is
    // undefined and (timestamp || '') treats it as the empty string, which the
    // descending localeCompare orders last.
    const comments = {
      'content/p.md': [
        { author: 'frank', text: 'newest', createdAt: '2026-05-02T00:00:00Z' },
        { author: 'grace', text: 'no timestamp' },
      ],
    };
    const discData = {
      messages: {
        general: [
          { author: 'heidi', text: 'middle', createdAt: '2026-05-01T00:00:00Z' },
        ],
      },
    };
    const r = await getChangelog(changelogCtx(comments, discData));
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, {
      events: [
        { type: 'comment', page: 'content/p.md', author: 'frank', text: 'newest', timestamp: '2026-05-02T00:00:00Z' },
        { type: 'message', channel: 'general', author: 'heidi', text: 'middle', timestamp: '2026-05-01T00:00:00Z' },
        { type: 'comment', page: 'content/p.md', author: 'grace', text: 'no timestamp', timestamp: undefined },
      ],
      total: 3,
    });
  });
});
