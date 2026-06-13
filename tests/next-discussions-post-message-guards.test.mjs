import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// discussions.js is CommonJS; load the REAL route module the way the other
// server route tests do, so these cases exercise the shipped POST message
// handler instead of a reimplementation.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');

// Drive the POST /api/discussions/:channelId/messages handler with a minimal
// mocked ctx. The handler only touches rateLimit, json, loadJSON, readBody,
// sanitizeText, saveJSON, and DISCUSSIONS_FILE, so an in-memory store plus a few
// recorders are enough: no real filesystem, network, or git is involved.
// `loadCount`, `readBodyCount`, and `saveCount` make the guard ORDER observable:
// the rate-limit and malformed-id paths return before anything is loaded, read,
// or saved, while the channel-404 path returns after loadJSON but before readBody.
// An identity sanitizeText keeps the author
// default and the text passthrough visible in the response. The rate-limit key
// for this route is `disc-msg:<addr>` (limit 30), distinct from the PATCH
// edit-message handler; rateLimit is mocked to a boolean so the real key never
// needs to be reconstructed here.
async function invoke({
  method = 'POST',
  pathname = '/api/discussions/general/messages',
  body = {},
  data = makeData(),
  rateLimitOk = true,
  readBodyRejects = false,
} = {}) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saved = null;
  let saveCount = 0;
  let readBodyCount = 0;
  let loadCount = 0;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    loadJSON: () => { loadCount += 1; return data; },
    saveJSON: (_file, d) => { saved = d; saveCount += 1; },
    rateLimit: () => rateLimitOk,
    readBody: async () => {
      readBodyCount += 1;
      if (readBodyRejects) throw new Error('readBody failed');
      return body;
    },
    sanitizeText: (s) => s,
    DISCUSSIONS_FILE: '/tmp/discussions-post-message-test.json',
  };
  await discussionsRoutes(req, res, url, pathname, ctx);
  return { captured, saved, saveCount, readBodyCount, loadCount, data };
}

// A fresh store per test (the default parameter re-runs on each invoke call), so
// no case can pollute another through shared mutable state. The `general`
// channel already holds one message, so a successful append is observable as
// growth and ordering.
function makeData() {
  return {
    channels: { general: { name: 'General', topic: 'Chat' } },
    messages: { general: [{ id: 'm0', author: 'alice', text: 'first' }] },
  };
}

describe('POST /api/discussions/:channelId/messages guards (current behavior)', () => {
  it('returns 429 and never reads the body or saves when rate limited', async () => {
    const { captured, saveCount, readBodyCount, loadCount } = await invoke({
      body: { text: 'hello' },
      rateLimitOk: false,
    });
    assert.equal(captured.status, 429);
    assert.equal(captured.payload.error, 'Too many requests. Try again in a minute.');
    // The rate-limit guard returns before the try block, so nothing is loaded,
    // read, or saved.
    assert.equal(loadCount, 0);
    assert.equal(readBodyCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 404 for an unknown channel before reading the body or saving', async () => {
    const { captured, saveCount, readBodyCount, loadCount } = await invoke({
      pathname: '/api/discussions/missing/messages',
      body: { text: 'hello' },
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Channel not found');
    // Headline: the channel existence check runs after loadJSON but before
    // readBody, so an unknown channel loads once yet records zero body reads and
    // zero saves.
    assert.equal(loadCount, 1);
    assert.equal(readBodyCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 400 for a malformed channel id before loading, reading, or saving', async () => {
    // The route regex `[^/]+` lets a bare `%` reach the handler, where
    // decodeURIComponent throws and the inner catch returns this 400 before
    // loadJSON, readBody, or saveJSON run.
    const { captured, saveCount, readBodyCount, loadCount } = await invoke({
      pathname: '/api/discussions/%/messages',
      body: { text: 'hello' },
    });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Invalid channel id');
    assert.equal(loadCount, 0);
    assert.equal(readBodyCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 400 when text is omitted, after reading the body, without saving', async () => {
    const { captured, saveCount, readBodyCount } = await invoke({ body: { author: 'carol' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid message text');
    // The body is read before text validation, in contrast to the channel-404 path.
    assert.equal(readBodyCount, 1);
    assert.equal(saveCount, 0);
  });

  it('returns 400 when text is an empty string', async () => {
    const { captured, saveCount } = await invoke({ body: { text: '' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid message text');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when text is a non-string', async () => {
    const { captured, saveCount } = await invoke({ body: { text: 42 } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid message text');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when text exceeds 5000 characters', async () => {
    const { captured, saveCount } = await invoke({ body: { text: 'a'.repeat(5001) } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Message text must be 5000 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when author is present but not a string', async () => {
    const { captured, saveCount } = await invoke({ body: { author: 42, text: 'hello' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'author must be a string');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when author exceeds 100 characters', async () => {
    const { captured, saveCount } = await invoke({ body: { author: 'a'.repeat(101), text: 'hello' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Author must be 100 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('returns 201 with the Anonymous default and lazy-inits the message array when author is omitted', async () => {
    // The channel exists but has no messages array yet, so the handler must
    // create data.messages and data.messages[channelId] before the push.
    const { captured, saved, saveCount, readBodyCount } = await invoke({
      body: { text: 'hello world' },
      data: { channels: { general: { name: 'General' } } },
    });
    assert.equal(captured.status, 201);
    const { message } = captured.payload;
    assert.equal(message.author, 'Anonymous');
    assert.equal(message.text, 'hello world');
    // id and createdAt come from the clock and RNG; pin only their type.
    assert.equal(typeof message.id, 'string');
    assert.equal(typeof message.createdAt, 'string');
    assert.equal(readBodyCount, 1);
    assert.equal(saveCount, 1);
    // Lazy-init: the missing message array was created and the message pushed.
    assert.ok(Array.isArray(saved.messages.general));
    assert.equal(saved.messages.general.length, 1);
    assert.deepEqual(saved.messages.general[0], message);
  });

  it('returns 201 with the Anonymous default when author is an empty string', async () => {
    const { captured, saveCount } = await invoke({ body: { author: '', text: 'hi' } });
    assert.equal(captured.status, 201);
    assert.equal(captured.payload.message.author, 'Anonymous');
    assert.equal(captured.payload.message.text, 'hi');
    assert.equal(saveCount, 1);
  });

  it('returns 201 and echoes a provided in-range author, appending to the channel', async () => {
    const data = makeData();
    const { captured, saved, saveCount } = await invoke({
      body: { author: 'carol', text: 'third' },
      data,
    });
    assert.equal(captured.status, 201);
    const { message } = captured.payload;
    assert.equal(message.author, 'carol');
    assert.equal(message.text, 'third');
    assert.equal(saveCount, 1);
    // Appended after the seeded message, preserving order. The persisted entry is
    // exactly the returned message.
    assert.equal(saved.messages.general.length, 2);
    assert.deepEqual(saved.messages.general[1], message);
  });

  it('returns 400 Invalid request when reading the body throws, without saving', async () => {
    // The channel exists, so control reaches readBody inside the try; a rejected
    // readBody is caught by the handler outer catch and mapped to this 400.
    const { captured, saveCount, readBodyCount } = await invoke({
      body: { text: 'hello' },
      readBodyRejects: true,
    });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Invalid request');
    assert.equal(readBodyCount, 1);
    assert.equal(saveCount, 0);
  });
});
