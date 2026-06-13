import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// research-tools.js is CommonJS; load the REAL route module the way the other
// server route tests do, so these cases exercise the shipped
// GET /api/notifications/counts handler instead of a reimplementation.
const require = createRequire(import.meta.url);
const researchToolsRoutes = require('../server/routes/research-tools.js');

// Sentinel file-path constants used only as keys into the in-memory store. The
// mocked loadJSON returns the right doc per file, so the string values never
// reach disk and no real filesystem access happens.
const COMMENTS_FILE = '/sentinel/comments.json';
const DISCUSSIONS_FILE = '/sentinel/discussions.json';

// Drive the GET /api/notifications/counts handler with a fully mocked ctx. The
// handler reads two flat-file JSON stores through loadJSON and returns counts of
// items created strictly after `since`. It has no guards, no try/catch, and no
// clock, fs walk, or randomness, so an in-memory store plus a capturing json is
// enough and nothing touches disk. The json recorder mirrors the sibling route
// tests: it stashes {status, payload} and marks the response ended. `since`
// rides on the URL query string exactly as server.js would supply it; omitting
// it exercises the epoch default. A fresh store is built per call, so no case
// can pollute another through shared mutable state.
async function invoke({ comments = {}, discussions = {}, since } = {}) {
  const pathname = '/api/notifications/counts';
  const url = since === undefined
    ? new URL(`http://localhost${pathname}`)
    : new URL(`http://localhost${pathname}?since=${encodeURIComponent(since)}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const store = { [COMMENTS_FILE]: comments, [DISCUSSIONS_FILE]: discussions };
  const ctx = {
    COMMENTS_FILE,
    DISCUSSIONS_FILE,
    loadJSON: (f) => store[f],
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await researchToolsRoutes(req, res, url, pathname, ctx);
  return { captured };
}

describe('GET /api/notifications/counts (current behavior)', () => {
  it('counts comments and discussions created strictly after an explicit since (createdAt === since is excluded)', async () => {
    const since = '2024-06-01T00:00:00.000Z';
    const { captured } = await invoke({
      since,
      comments: {
        'docs/a': [
          { createdAt: '2024-06-02T00:00:00.000Z' }, // after since → counted
          { createdAt: '2024-06-01T00:00:00.000Z' }, // equal to since → excluded (strict >)
          { createdAt: '2024-05-31T00:00:00.000Z' }, // before since → excluded
        ],
        'docs/b': [
          { createdAt: '2024-12-01T00:00:00.000Z' }, // after since → counted
        ],
      },
      discussions: {
        messages: {
          general: [
            { createdAt: '2024-06-02T00:00:00.000Z' }, // after since → counted
            { createdAt: '2024-06-01T00:00:00.000Z' }, // equal to since → excluded
          ],
          random: [
            { createdAt: '2024-07-01T00:00:00.000Z' }, // after since → counted
          ],
        },
      },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { comments: 2, discussions: 2 });
  });

  it('defaults since to the epoch when no query param is given, counting every entry with a createdAt', async () => {
    const { captured } = await invoke({
      comments: {
        'docs/a': [
          { createdAt: '2024-01-01T00:00:00.000Z' },
          { createdAt: '2023-05-05T00:00:00.000Z' },
        ],
        'docs/b': [
          { createdAt: '2020-01-01T00:00:00.000Z' },
        ],
      },
      discussions: {
        messages: {
          general: [{ createdAt: '2024-01-01T00:00:00.000Z' }],
          random: [
            { createdAt: '2022-02-02T00:00:00.000Z' },
            { createdAt: '2025-01-01T00:00:00.000Z' },
          ],
        },
      },
    });
    assert.equal(captured.status, 200);
    // No since param → since defaults to '1970-01-01T00:00:00.000Z', so every
    // entry whose createdAt sorts after the epoch is counted.
    assert.deepEqual(captured.payload, { comments: 3, discussions: 3 });
  });

  it('ignores comment entries without createdAt, non-array page buckets, and a discussions doc missing .messages', async () => {
    const { captured } = await invoke({
      comments: {
        'docs/valid': [
          { createdAt: '2024-01-01T00:00:00.000Z' }, // counted
          { id: 'no-timestamp' },                    // no createdAt → ignored
          { createdAt: '' },                         // falsy createdAt → ignored
        ],
        'docs/object-bucket': { not: 'an array' },    // non-array page bucket → ignored
        'docs/string-bucket': 'also not an array',    // non-array page bucket → ignored
        'docs/empty': [],                             // empty array → contributes 0
      },
      discussions: {}, // no .messages key → discData.messages || {} → 0 discussions
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { comments: 1, discussions: 0 });
  });

  it('ignores discussion messages without createdAt and non-array channel buckets', async () => {
    const { captured } = await invoke({
      comments: {},
      discussions: {
        messages: {
          general: [
            { createdAt: '2024-01-01T00:00:00.000Z' }, // counted
            { id: 'no-timestamp' },                    // no createdAt → ignored
            { createdAt: '' },                         // falsy createdAt → ignored
          ],
          'object-channel': { not: 'an array' },        // non-array channel bucket → ignored
          'string-channel': 'also not an array',        // non-array channel bucket → ignored
          empty: [],                                    // empty array → contributes 0
        },
      },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { comments: 0, discussions: 1 });
  });
});
