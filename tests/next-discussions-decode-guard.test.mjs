import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// discussions.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');

// Invoke a discussions route handler with a minimal mocked ctx and capture the
// response the handler hands to `json(res, status, payload)`. Mirrors the helper
// in next-discussions-pagination-guard.test.mjs.
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
    ...ctx,
  };
  await discussionsRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('GET discussions channel-id decode guard', () => {
  // One real channel so the happy path has something to return. The route regex
  // `[^/]+` lets a bare `%` reach the handler, where `decodeURIComponent('%')`
  // throws URIError; before the guard that throw escaped as an unhandled
  // rejection and the request hung. The guard turns it into a clean 400.
  const data = {
    channels: { general: { name: 'General' } },
    messages: { general: [{ id: 'm1', author: 'Alice', text: 'hello' }] },
  };
  const ctx = { loadJSON: () => data, DISCUSSIONS_FILE: '/tmp/discussions-decode-guard-test.json' };

  it('GET /messages with a malformed channel id resolves 400 and never throws', async () => {
    let captured;
    await assert.doesNotReject(async () => {
      captured = await invoke({ pathname: '/api/discussions/%/messages', ctx });
    }, 'a bare "%" must not crash the read handler');
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Invalid channel id');
  });

  it('GET /messages/search with a malformed channel id resolves 400', async () => {
    let captured;
    await assert.doesNotReject(async () => {
      captured = await invoke({
        pathname: '/api/discussions/%E0%A4/messages/search',
        search: '?q=hi',
        ctx,
      });
    }, 'an incomplete escape must not crash the search handler');
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Invalid channel id');
  });

  it('GET /messages with a valid channel id still returns 200 with the messages', async () => {
    const r = await invoke({ pathname: '/api/discussions/general/messages', ctx });
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 1);
    assert.equal(r.payload.messages.length, 1);
    assert.equal(r.payload.messages[0].id, 'm1');
  });
});
