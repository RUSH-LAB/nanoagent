import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the real module via createRequire the way the
// sibling guard suites do (next-misctools-create-write-guards.test.mjs and
// next-snapshots-delete-guards.test.mjs) so these cases exercise the shipped
// POST /api/goals (create) handler in server/routes/misc-tools.js rather than a
// reimplementation. The handler runs over a fully mocked ctx: no real
// filesystem, network, clock, or randomness is touched, except where a stub
// deliberately stands in for one.
//
// This is an add-only characterization test. The sibling suite already drives
// PUT /api/goals (key goals-update:); the POST create verb, its validation
// guards, its content-walk baseline, and its outer catch were all untested.
// These cases pin the CURRENT, correct create behavior so a future refactor
// cannot silently change it. No source file is edited.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';
// The data-file constant handed to the handler through ctx. The mocked loadJSON
// answers only for this exact path, so a stray read surfaces as a thrown error
// instead of silently passing; handler and mock agree on the store path.
const GOALS_FILE = path.join(PROJECT_ROOT, 'data', 'goals.json');

// Drive POST /api/goals (create) over a mocked ctx. rateLimit records each call
// (key and limit) and returns the per-call toggle; readBody returns the supplied
// body and counts its calls; loadJSON returns a fresh deep copy of `store` keyed
// on GOALS_FILE and counts its calls; saveJSON records every persist;
// sanitizeText is the identity so the stored uid is deterministic. The fake fs
// readdirSync returns an empty listing, so the recursive content walk visits no
// entries, readFileSync is never reached, and baselineWords stays a deterministic
// 0; real node:path joins the content dir; json captures the (status, body)
// handed back. The counters let the guard branches prove the store and the
// content walk were never reached.
async function runGoalsCreate({
  body = {},
  store = {},
  rateLimitOk = true,
  throwOnReadBody = false,
} = {}) {
  const saved = [];
  const rateLimitCalls = [];
  let readBodyCount = 0;
  let loadJSONCount = 0;
  let readdirCount = 0;
  let captured = null;
  const ctx = {
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return rateLimitOk; },
    readBody: async () => {
      readBodyCount++;
      if (throwOnReadBody) throw new Error('readBody failed');
      return body;
    },
    sanitizeText: (s) => s,
    loadJSON: (fp) => {
      loadJSONCount++;
      if (fp === GOALS_FILE) return JSON.parse(JSON.stringify(store));
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    fs: {
      readdirSync: () => { readdirCount++; return []; },
      readFileSync: () => { throw new Error('readFileSync must not run for an empty content dir'); },
    },
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    GOALS_FILE,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/goals';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { captured, saved, readBodyCount, loadJSONCount, readdirCount, rateLimitCalls };
}

describe('POST /api/goals (create) in routes/misc-tools.js', () => {
  it('a rate-limited create returns 429, never reads the body, loads, walks, or saves, and uses the create key goals:127.0.0.1 with limit 30', async () => {
    const r = await runGoalsCreate({ rateLimitOk: false, body: { type: 'daily', target: 100 } });
    assert.equal(r.captured.status, 429);
    assert.deepEqual(r.captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(r.readBodyCount, 0, 'the rate-limit guard returns before readBody');
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.readdirCount, 0);
    assert.equal(r.saved.length, 0);
    // Pin the per-handler rate-limit identity. The create key goals:127.0.0.1
    // with limit 30 distinguishes this handler from PUT /api/goals, which shares
    // the 429 string but throttles under goals-update:.
    assert.equal(r.rateLimitCalls.length, 1);
    assert.deepEqual(r.rateLimitCalls[0], { key: 'goals:127.0.0.1', limit: 30 });
  });

  it('a missing type returns 400 type must be "daily" or "weekly", reads the body once, never loads, walks, or saves', async () => {
    const r = await runGoalsCreate({ body: { target: 100 } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'type must be "daily" or "weekly"' });
    assert.equal(r.readBodyCount, 1, 'the body is read before type is validated');
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.readdirCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('an out-of-set type returns 400 type must be "daily" or "weekly", never loads or saves', async () => {
    // 'monthly' is truthy so it clears the falsy check, but it is outside the
    // allowed set, so the same guard rejects it.
    const r = await runGoalsCreate({ body: { type: 'monthly', target: 100 } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'type must be "daily" or "weekly"' });
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a non-number target returns 400 target must be a positive number, never loads or saves', async () => {
    // type passes; the numeric string '100' trips the typeof guard and is never
    // coerced into a target.
    const r = await runGoalsCreate({ body: { type: 'daily', target: '100' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'target must be a positive number' });
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a zero target is not positive, returning 400 target must be a positive number, never loads or saves', async () => {
    const r = await runGoalsCreate({ body: { type: 'weekly', target: 0 } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'target must be a positive number' });
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a negative target is not positive, returning 400 target must be a positive number, never loads or saves', async () => {
    const r = await runGoalsCreate({ body: { type: 'daily', target: -5 } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'target must be a positive number' });
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a non-string, non-undefined userId returns 400 userId must be a string, never loads or saves', async () => {
    // type and target pass; a numeric userId is neither undefined nor a string,
    // so the dedicated type guard rejects it.
    const r = await runGoalsCreate({ body: { type: 'daily', target: 100, userId: 42 } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'userId must be a string' });
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('an over-long userId returns 400 userId must be 200 characters or fewer, never loads or saves', async () => {
    // A 201-character string clears the typeof guard but trips the length guard.
    const r = await runGoalsCreate({ body: { type: 'daily', target: 100, userId: 'u'.repeat(201) } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'userId must be 200 characters or fewer' });
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('creates a goal: 201 with type/target/userId, a structural goal_ id, matching createdAt/startDate, baselineWords 0, and one save to GOALS_FILE', async () => {
    const r = await runGoalsCreate({ body: { type: 'daily', target: 500, userId: 'alice' }, store: {} });
    assert.equal(r.captured.status, 201);
    const goal = r.captured.body;
    assert.equal(goal.type, 'daily');
    assert.equal(goal.target, 500);
    assert.equal(goal.userId, 'alice');
    // id, createdAt, and startDate come from the real clock and Math.random, which
    // are global (not ctx injected), so they are asserted structurally, never by
    // value. startDate is the date portion of the same ISO createdAt.
    assert.equal(typeof goal.id, 'string');
    assert.ok(goal.id.startsWith('goal_'), 'id carries the goal_ prefix');
    assert.equal(typeof goal.createdAt, 'string');
    assert.equal(goal.startDate, goal.createdAt.slice(0, 10));
    // The fake fs walks an empty content dir, so the baseline word count is a
    // deterministic 0; readdirSync ran exactly once over the content directory.
    assert.equal(goal.baselineWords, 0);
    assert.equal(r.readdirCount, 1);
    assert.equal(r.loadJSONCount, 1);
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].fp, GOALS_FILE);
    // The persisted store gains exactly the returned goal in a fresh goals array.
    assert.deepEqual(r.saved[0].data.goals, [goal]);
    assert.deepEqual(r.rateLimitCalls[0], { key: 'goals:127.0.0.1', limit: 30 });
  });

  it('an omitted userId defaults the stored uid to "default" and accepts the weekly type', async () => {
    const r = await runGoalsCreate({ body: { type: 'weekly', target: 1000 }, store: {} });
    assert.equal(r.captured.status, 201);
    assert.equal(r.captured.body.type, 'weekly');
    // uid is `userId ? sanitizeText(userId) : 'default'`, so an absent userId
    // takes the default branch.
    assert.equal(r.captured.body.userId, 'default');
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].data.goals[0].userId, 'default');
  });

  it('replaces a pre-existing goal of the same type and userId, keeping a different-type sibling and a same-type goal for another user', async () => {
    const store = { goals: [
      { id: 'old-daily-alice', type: 'daily', userId: 'alice', target: 100, baselineWords: 5, startDate: '2026-01-01', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'keep-weekly-alice', type: 'weekly', userId: 'alice', target: 3000, baselineWords: 7, startDate: '2026-01-01', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'keep-daily-bob', type: 'daily', userId: 'bob', target: 250, baselineWords: 9, startDate: '2026-01-01', createdAt: '2026-01-01T00:00:00.000Z' },
    ] };
    const r = await runGoalsCreate({ store, body: { type: 'daily', target: 500, userId: 'alice' } });
    assert.equal(r.captured.status, 201);
    assert.equal(r.saved.length, 1);
    const goals = r.saved[0].data.goals;
    // The replace filter drops only the daily goal owned by alice; the weekly
    // alice goal and the daily bob goal both survive, then the new goal is pushed
    // onto the end.
    assert.equal(goals.length, 3);
    assert.equal(goals.some(g => g.id === 'old-daily-alice'), false);
    assert.deepEqual(goals.map(g => g.id), ['keep-weekly-alice', 'keep-daily-bob', r.captured.body.id]);
    const fresh = goals[2];
    assert.equal(fresh.type, 'daily');
    assert.equal(fresh.userId, 'alice');
    assert.equal(fresh.target, 500);
  });

  it('an outer throw (readBody fails) returns 400 Invalid request, reads the body once, never loads or saves', async () => {
    // readBody runs inside the try with no inner parse guard, so its rejection
    // lands on the outer catch as a 400 Invalid request, not a validation 400.
    const r = await runGoalsCreate({ throwOnReadBody: true, body: { type: 'daily', target: 100 } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid request' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });
});
