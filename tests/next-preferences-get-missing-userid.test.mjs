import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the real shipping module the way the
// sibling server route tests do, so this pins the live handler rather than a copy.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// ── GET /api/preferences missing-userId guard ──
// The handler's first two statements are
//   const userId = url.searchParams.get('userId');
//   if (!userId) return json(res, 400, {error: 'Missing userId'});
// so a falsy userId short-circuits with a 400 BEFORE loadJSON runs. Drive the
// real handler with a minimal mocked ctx: a json() capturer plus loadJSON wired
// as a call-counter tripwire that also returns a benign empty object for the
// pass-through case. Every assertion is anchored on method GET and pathname
// '/api/preferences', because the 'Missing userId' string is reused by the
// sibling GET /api/users/me and GET /api/reading-progress routes; the PUT
// /api/preferences handler uses the different 'Missing or invalid userId'
// message and is left untouched.
async function invokePreferences({ userId }) {
  const query = userId === undefined ? '' : `?userId=${encodeURIComponent(userId)}`;
  const pathname = '/api/preferences';
  const url = new URL(`http://localhost${pathname}${query}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadJSONCount = 0;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp',
    loadJSON() {
      loadJSONCount += 1;
      return {};
    },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, loadJSONCount };
}

describe('GET /api/preferences missing-userId guard', () => {
  it('returns 400 {error: "Missing userId"} when no userId query is present, before loadJSON', async () => {
    const { captured, loadJSONCount } = await invokePreferences({ userId: undefined });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing userId' });
    assert.equal(loadJSONCount, 0);
  });

  it('returns 400 {error: "Missing userId"} for an empty ?userId= (falsy), before loadJSON', async () => {
    const { captured, loadJSONCount } = await invokePreferences({ userId: '' });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing userId' });
    assert.equal(loadJSONCount, 0);
  });

  it('passes the guard for a present userId and reaches loadJSON', async () => {
    const { captured, loadJSONCount } = await invokePreferences({ userId: 'alice' });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { preferences: {} });
    assert.ok(loadJSONCount >= 1, `expected loadJSON to run at least once, got ${loadJSONCount}`);
  });
});
