import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// discussions.js is CommonJS; load the REAL route module the way the other
// server route tests do, so these cases exercise the shipped handler instead of
// a reimplementation.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');

// Drive the POST /api/discussions create-channel handler with a minimal mocked
// ctx. Every create guard returns before the single saveJSON, so an in-memory
// store plus a few recorders are enough and no real filesystem write happens.
// The ctx mirrors what server.js passes: the create branch reads json,
// rateLimit, readBody, loadJSON, saveJSON, sanitizeText, and DISCUSSIONS_FILE;
// path and PROJECT_ROOT round out the documented ctx shape.
// A fresh default store is built per call (default parameters evaluate on each
// invocation), so no case can pollute another through shared mutable state.
async function invoke({ body = {}, data = { channels: {}, messages: {} }, rateLimitOk = true } = {}) {
  const pathname = '/api/discussions';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saved = null;
  let saveCount = 0;
  let readBodyCount = 0;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    loadJSON: () => data,
    saveJSON: (_file, d) => { saved = d; saveCount += 1; },
    rateLimit: () => rateLimitOk,
    readBody: async () => { readBodyCount += 1; return body; },
    sanitizeText: (s) => s,
    path,
    PROJECT_ROOT: '/tmp/discussions-create-channel-root',
    DISCUSSIONS_FILE: '/tmp/discussions-create-channel-test.json',
  };
  await discussionsRoutes(req, res, url, pathname, ctx);
  return { captured, saved, saveCount, readBodyCount };
}

describe('POST /api/discussions create-channel guards (current behavior)', () => {
  it('returns 429 and never reads the body when rate limited', async () => {
    const { captured, saveCount, readBodyCount } = await invoke({
      body: { name: 'My Channel' },
      rateLimitOk: false,
    });
    assert.equal(captured.status, 429);
    assert.equal(captured.payload.error, 'Too many requests. Try again in a minute.');
    assert.equal(saveCount, 0);
    assert.equal(readBodyCount, 0);
  });

  it('returns 400 when name is omitted', async () => {
    const { captured, saveCount } = await invoke({ body: {} });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid channel name');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when name is a non-string', async () => {
    const { captured, saveCount } = await invoke({ body: { name: 42 } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid channel name');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when name exceeds 100 characters', async () => {
    const { captured, saveCount } = await invoke({ body: { name: 'a'.repeat(101) } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Channel name too long (max 100 characters)');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when topic is present but not a string', async () => {
    const { captured, saveCount } = await invoke({ body: { name: 'Valid', topic: 123 } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'topic must be a string');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when topic exceeds 500 characters', async () => {
    const { captured, saveCount } = await invoke({ body: { name: 'Valid', topic: 'a'.repeat(501) } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Topic must be 500 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when linkedPage is present but not a string', async () => {
    const { captured, saveCount } = await invoke({ body: { name: 'Valid', linkedPage: 123 } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'linkedPage must be a string');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when linkedPage exceeds 500 characters', async () => {
    const { captured, saveCount } = await invoke({ body: { name: 'Valid', linkedPage: 'a'.repeat(501) } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'linkedPage must be 500 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when the name slugifies to empty', async () => {
    const { captured, saveCount } = await invoke({ body: { name: '!!!' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Channel name must contain at least one alphanumeric character');
    assert.equal(saveCount, 0);
  });

  it('returns 409 when the slug already exists', async () => {
    const { captured, saveCount } = await invoke({
      body: { name: 'My Channel' },
      data: { channels: { 'my-channel': { name: 'My Channel' } }, messages: {} },
    });
    assert.equal(captured.status, 409);
    assert.equal(captured.payload.error, 'Channel already exists');
    assert.equal(saveCount, 0);
  });

  it('returns 201 with the created channel and saves exactly once on a valid create', async () => {
    const { captured, saved, saveCount } = await invoke({ body: { name: 'My Channel' } });
    assert.equal(captured.status, 201);
    const { channel } = captured.payload;
    assert.equal(channel.id, 'my-channel');
    assert.equal(channel.name, 'My Channel');
    assert.equal(channel.topic, '');
    assert.equal(channel.linkedPage, null);
    assert.equal(channel.messageCount, 0);
    // createdAt uses the clock; pin only its type, never the value.
    assert.equal(typeof channel.createdAt, 'string');
    assert.equal(saveCount, 1);
    // The persisted document is the in-memory store, now holding the new channel
    // and its empty message list.
    assert.equal(saved.channels['my-channel'].name, 'My Channel');
    assert.deepEqual(saved.messages['my-channel'], []);
  });
});
