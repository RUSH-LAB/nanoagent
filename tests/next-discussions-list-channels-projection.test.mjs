import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// discussions.js is CommonJS; load the REAL route module the way the sibling
// discussions tests do, so these cases exercise the shipped GET list handler
// instead of a reimplementation.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');

// Drive the GET /api/discussions list-channels handler with a minimal mocked
// ctx. The handler reads the store once via loadJSON(DISCUSSIONS_FILE) and
// returns a projection, so loadJSON, the DISCUSSIONS_FILE constant, and a json
// recorder are the only ctx fields it touches. saveJSON is wired as a tripwire:
// the list path is read only, so a non zero call count would signal a
// behavior change.
const DISCUSSIONS_FILE = '/tmp/discussions-list-channels-test.json';

async function invoke(data) {
  const pathname = '/api/discussions';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadArg;
  let loadCount = 0;
  let saveCount = 0;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    loadJSON: (file) => { loadArg = file; loadCount += 1; return data; },
    saveJSON: () => { saveCount += 1; },
    DISCUSSIONS_FILE,
  };
  await discussionsRoutes(req, res, url, pathname, ctx);
  return { captured, loadArg, loadCount, saveCount };
}

describe('GET /api/discussions list-channels projection (current behavior)', () => {
  it('projects each channel to {id, ...storedFields, messageCount} with the message-array length', async () => {
    const data = {
      channels: {
        general: { name: 'General', topic: 'Anything goes', linkedPage: null, createdAt: '2024-01-01T00:00:00.000Z' },
        random: { name: 'Random', topic: '', linkedPage: '/docs/random', createdAt: '2024-02-02T00:00:00.000Z' },
      },
      messages: {
        general: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
        random: [{ id: 'm4' }],
      },
    };
    const { captured, loadArg, loadCount, saveCount } = await invoke(data);

    assert.equal(captured.status, 200);
    // The handler reads the store exactly once, from the DISCUSSIONS_FILE path,
    // and never writes on the list path.
    assert.equal(loadCount, 1);
    assert.equal(loadArg, DISCUSSIONS_FILE);
    assert.equal(saveCount, 0);
    // Every stored field is preserved, the channel id comes from the map key,
    // messageCount is the length of that channel's messages array, and channels
    // keep their insertion order.
    assert.deepEqual(captured.payload, {
      channels: [
        { id: 'general', name: 'General', topic: 'Anything goes', linkedPage: null, createdAt: '2024-01-01T00:00:00.000Z', messageCount: 3 },
        { id: 'random', name: 'Random', topic: '', linkedPage: '/docs/random', createdAt: '2024-02-02T00:00:00.000Z', messageCount: 1 },
      ],
    });
  });

  it('falls back to messageCount 0 when a channel has no entry in the messages map', async () => {
    // messages is present but the channel id is absent, so messages[id] is
    // undefined and the `|| []` fallback yields length 0.
    const data = {
      channels: {
        quiet: { name: 'Quiet', topic: 'No messages yet', linkedPage: null, createdAt: '2024-03-03T00:00:00.000Z' },
      },
      messages: {},
    };
    const { captured } = await invoke(data);

    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, {
      channels: [
        { id: 'quiet', name: 'Quiet', topic: 'No messages yet', linkedPage: null, createdAt: '2024-03-03T00:00:00.000Z', messageCount: 0 },
      ],
    });
  });

  it('treats an absent messages map as empty, so every channel reports messageCount 0', async () => {
    // No messages key at all exercises the `data.messages || {}` guard in
    // addition to the per-channel `|| []` fallback.
    const data = {
      channels: {
        alpha: { name: 'Alpha', topic: 'First', linkedPage: null, createdAt: '2024-04-04T00:00:00.000Z' },
        beta: { name: 'Beta', topic: 'Second', linkedPage: '/docs/beta', createdAt: '2024-05-05T00:00:00.000Z' },
      },
    };
    const { captured } = await invoke(data);

    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, {
      channels: [
        { id: 'alpha', name: 'Alpha', topic: 'First', linkedPage: null, createdAt: '2024-04-04T00:00:00.000Z', messageCount: 0 },
        { id: 'beta', name: 'Beta', topic: 'Second', linkedPage: '/docs/beta', createdAt: '2024-05-05T00:00:00.000Z', messageCount: 0 },
      ],
    });
  });

  it('responds with an empty channels list when the store has no channels key', async () => {
    // The `data.channels || {}` guard turns an empty store into an empty list.
    const { captured, saveCount } = await invoke({});

    assert.equal(captured.status, 200);
    assert.equal(saveCount, 0);
    assert.deepEqual(captured.payload, { channels: [] });
  });
});
