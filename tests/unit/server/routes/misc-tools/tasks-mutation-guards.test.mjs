import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// misc-tools.js is CommonJS; load the real module via createRequire the way the
// sibling task suites do (next-tasks-single-pass-group.test.mjs and
// next-misctasks-arrays-hoist.test.mjs) so these cases exercise the shipped
// mutating handlers in server/routes/misc-tools.js rather than a reimplementation.
//
// This is an add-only characterization test. It pins the CURRENT, correct
// behavior of the guard branches of the three mutating methods on /api/tasks
// (POST, PUT, DELETE): the rate-limit 429, the missing-field 400s, the readBody
// throw 400, and the Task-not-found 404. The GET grouping and the POST/PUT
// accept paths are pinned elsewhere and are not re-pinned here; the accept paths
// also use Date.now, Math.random, and new Date, so they are left out as
// non-deterministic. No source file is edited.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');

// The mocked loadJSON answers only for this exact store path, so a stray read
// surfaces as a thrown error instead of silently passing.
const TASKS_FILE = '/proj/data/tasks.json';

// Drive one mutating /api/tasks request over a fully mocked ctx and capture the
// json() response. No real filesystem, network, clock, or randomness is touched.
// rateLimit records each call (key and limit) and returns the per-call toggle;
// readBody returns the supplied body and counts its calls, or throws when asked;
// loadJSON returns a fresh deep copy of `store` keyed on TASKS_FILE and counts
// its calls; saveJSON records every persist. The counters let each guard branch
// prove that the store was never loaded or saved when it must short-circuit
// first. sanitizeText and the clock are intentionally absent: every branch under
// test returns before the handler would reach them.
async function runTasks({
  method,
  body = {},
  store = { tasks: [] },
  rateLimitOk = true,
  throwOnReadBody = false,
} = {}) {
  const saved = [];
  const rateLimitCalls = [];
  let readBodyCount = 0;
  let loadJSONCount = 0;
  let captured = null;
  const ctx = {
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return rateLimitOk; },
    readBody: async () => {
      readBodyCount++;
      if (throwOnReadBody) throw new Error('readBody failed');
      return body;
    },
    loadJSON: (fp) => {
      loadJSONCount++;
      if (fp === TASKS_FILE) return JSON.parse(JSON.stringify(store));
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    TASKS_FILE,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/tasks';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { captured, saved, readBodyCount, loadJSONCount, rateLimitCalls };
}

describe('POST /api/tasks guard branches in routes/misc-tools.js', () => {
  it('a rate-limited POST returns 429, never reads the body, loads, or saves, and uses the tasks key with limit 60', async () => {
    const r = await runTasks({ method: 'POST', rateLimitOk: false, body: { title: 'Buy milk' } });
    assert.equal(r.captured.status, 429);
    assert.deepEqual(r.captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(r.readBodyCount, 0, 'the rate-limit guard returns before readBody');
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
    assert.equal(r.rateLimitCalls.length, 1);
    assert.deepEqual(r.rateLimitCalls[0], { key: 'tasks:127.0.0.1', limit: 60 });
  });

  it('an omitted title returns 400 Missing title, reads the body once, never loads or saves', async () => {
    const r = await runTasks({ method: 'POST', body: { description: 'no title here' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing title' });
    assert.equal(r.readBodyCount, 1, 'the body is read before the title is validated');
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a whitespace-only title returns 400 Missing title via the trim guard, never loads or saves', async () => {
    // '   ' is truthy and a string, so it clears the first two clauses; the
    // trailing !title.trim() clause is the branch under test. An empty string
    // would instead trip the first !title clause; both yield Missing title.
    const r = await runTasks({ method: 'POST', body: { title: '   ' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing title' });
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a non-string title (42) returns 400 Missing title, never loads or saves', async () => {
    // 42 is truthy so it clears the falsy check, but typeof 42 !== 'string'
    // trips the type clause; a numeric title is never coerced into a task.
    const r = await runTasks({ method: 'POST', body: { title: 42 } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing title' });
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('an outer throw (readBody fails) returns 400 Invalid request, never loads or saves', async () => {
    const r = await runTasks({ method: 'POST', throwOnReadBody: true, body: { title: 'Buy milk' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid request' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });
});

describe('PUT /api/tasks guard branches in routes/misc-tools.js', () => {
  it('a rate-limited PUT returns 429, never reads the body, loads, or saves, and uses the tasks key with limit 60', async () => {
    const r = await runTasks({ method: 'PUT', rateLimitOk: false, body: { id: 't1', status: 'done' } });
    assert.equal(r.captured.status, 429);
    assert.deepEqual(r.captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(r.readBodyCount, 0, 'the rate-limit guard returns before readBody');
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
    assert.equal(r.rateLimitCalls.length, 1);
    assert.deepEqual(r.rateLimitCalls[0], { key: 'tasks:127.0.0.1', limit: 60 });
  });

  it('an omitted id returns 400 Missing id, reads the body once, never loads or saves', async () => {
    const r = await runTasks({ method: 'PUT', body: { status: 'done' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing id' });
    assert.equal(r.readBodyCount, 1, 'the body is read before the id is validated');
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a non-string id (42) returns 400 Missing id, never loads or saves', async () => {
    const r = await runTasks({ method: 'PUT', body: { id: 42, status: 'done' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing id' });
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('an id absent from an empty store returns 404 Task not found, loads once, never saves', async () => {
    const r = await runTasks({ method: 'PUT', store: { tasks: [] }, body: { id: 'ghost', status: 'done' } });
    assert.equal(r.captured.status, 404);
    assert.deepEqual(r.captured.body, { error: 'Task not found' });
    assert.equal(r.loadJSONCount, 1, 'the store is loaded before the id is sought');
    assert.equal(r.saved.length, 0);
  });

  it('an id absent from a non-empty store returns 404 Task not found, loads once, never saves', async () => {
    const r = await runTasks({ method: 'PUT', store: { tasks: [{ id: 'other' }] }, body: { id: 'ghost', status: 'done' } });
    assert.equal(r.captured.status, 404);
    assert.deepEqual(r.captured.body, { error: 'Task not found' });
    assert.equal(r.loadJSONCount, 1);
    assert.equal(r.saved.length, 0);
  });

  it('an outer throw (readBody fails) returns 400 Invalid request, never loads or saves', async () => {
    const r = await runTasks({ method: 'PUT', throwOnReadBody: true, body: { id: 't1' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid request' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });
});

describe('DELETE /api/tasks guard branches in routes/misc-tools.js', () => {
  it('a rate-limited DELETE returns 429, never reads the body, loads, or saves, and uses the tasks-del key with limit 30', async () => {
    const r = await runTasks({ method: 'DELETE', rateLimitOk: false, body: { id: 't1' } });
    assert.equal(r.captured.status, 429);
    assert.deepEqual(r.captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(r.readBodyCount, 0, 'the rate-limit guard returns before readBody');
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
    assert.equal(r.rateLimitCalls.length, 1);
    // The DELETE limiter is distinct from POST and PUT: key 'tasks-del:' with
    // limit 30, not 'tasks:' with limit 60.
    assert.deepEqual(r.rateLimitCalls[0], { key: 'tasks-del:127.0.0.1', limit: 30 });
  });

  it('an omitted id returns 400 Missing id, reads the body once, never loads or saves', async () => {
    const r = await runTasks({ method: 'DELETE', body: {} });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing id' });
    assert.equal(r.readBodyCount, 1, 'the body is read before the id is validated');
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a non-string id (42) returns 400 Missing id, never loads or saves', async () => {
    const r = await runTasks({ method: 'DELETE', body: { id: 42 } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing id' });
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('an id absent from an empty store returns 404 Task not found, loads once, never saves', async () => {
    const r = await runTasks({ method: 'DELETE', store: { tasks: [] }, body: { id: 'ghost' } });
    assert.equal(r.captured.status, 404);
    assert.deepEqual(r.captured.body, { error: 'Task not found' });
    assert.equal(r.loadJSONCount, 1, 'the store is loaded before the id is sought');
    assert.equal(r.saved.length, 0);
  });

  it('an id absent from a non-empty store returns 404 Task not found, loads once, never saves', async () => {
    const r = await runTasks({ method: 'DELETE', store: { tasks: [{ id: 'other' }] }, body: { id: 'ghost' } });
    assert.equal(r.captured.status, 404);
    assert.deepEqual(r.captured.body, { error: 'Task not found' });
    assert.equal(r.loadJSONCount, 1);
    assert.equal(r.saved.length, 0);
  });

  it('an outer throw (readBody fails) returns 400 Invalid request, never loads or saves', async () => {
    const r = await runTasks({ method: 'DELETE', throwOnReadBody: true, body: { id: 't1' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid request' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });
});
