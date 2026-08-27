import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// misc-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const miscRoutes = require('../../../../../server/routes/misc-tools.js');
const { TASK_STATUSES, TASK_PRIORITIES } = miscRoutes;

// Canonical values, copied verbatim from the former inline arrays. Used to assert
// the hoisted consts neither reordered nor changed their contents.
const CANON_STATUSES = ['todo', 'doing', 'done'];
const CANON_PRIORITIES = ['low', 'medium', 'high'];

// Drive POST /api/tasks with a mocked ctx and capture the json() response. The
// handler touches rateLimit, readBody, TASK_STATUSES/TASK_PRIORITIES, then
// loadJSON/sanitizeText/saveJSON on the accept path; the stub supplies just those.
// `saved` records what would be persisted so the created task can be asserted
// without real disk writes.
async function postTask({ title = 'My task', description, status, priority } = {}) {
  let captured = null;
  let saved = null;
  const ctx = {
    TASKS_FILE: 'tasks.json',
    rateLimit: () => true,
    readBody: async () => ({ title, description, status, priority }),
    loadJSON: () => ({ tasks: [] }),
    saveJSON: (_fp, data) => { saved = data; },
    sanitizeText: (s) => s,
    json: (_res, code, body) => { captured = { status: code, body }; },
  };
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const url = new URL('http://localhost/api/tasks');
  await miscRoutes(req, res, url, '/api/tasks', ctx);
  return { captured, saved };
}

// Drive PUT /api/tasks against a single existing task. `existing` seeds the stored
// task; the mocked ctx mutates it in place exactly as the real handler does.
async function putTask({ id = 't1', status, title, description, priority } = {}, existing = {}) {
  let captured = null;
  let saved = null;
  const stored = { id: 't1', title: 'Seed', description: '', status: 'todo', priority: 'medium', ...existing };
  const data = { tasks: [stored] };
  const ctx = {
    TASKS_FILE: 'tasks.json',
    rateLimit: () => true,
    readBody: async () => ({ id, status, title, description, priority }),
    loadJSON: () => data,
    saveJSON: (_fp, d) => { saved = d; },
    sanitizeText: (s) => s,
    json: (_res, code, body) => { captured = { status: code, body }; },
  };
  const req = { method: 'PUT', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const url = new URL('http://localhost/api/tasks');
  await miscRoutes(req, res, url, '/api/tasks', ctx);
  return { captured, saved, stored };
}

describe('TASK_STATUSES / TASK_PRIORITIES (hoisted to frozen module scope in misc-tools.js)', () => {
  it('exports both as frozen arrays with the exact former contents and order', () => {
    assert.ok(Array.isArray(TASK_STATUSES), 'TASK_STATUSES should be an array');
    assert.ok(Array.isArray(TASK_PRIORITIES), 'TASK_PRIORITIES should be an array');
    assert.deepEqual(TASK_STATUSES, CANON_STATUSES);
    assert.deepEqual(TASK_PRIORITIES, CANON_PRIORITIES);
    assert.equal(Object.isFrozen(TASK_STATUSES), true, 'TASK_STATUSES should be frozen');
    assert.equal(Object.isFrozen(TASK_PRIORITIES), true, 'TASK_PRIORITIES should be frozen');
  });

  it('is referentially stable across two requires (single shared instance)', () => {
    const a = require('../../../../../server/routes/misc-tools.js');
    const b = require('../../../../../server/routes/misc-tools.js');
    assert.strictEqual(a.TASK_STATUSES, b.TASK_STATUSES);
    assert.strictEqual(a.TASK_PRIORITIES, b.TASK_PRIORITIES);
  });

  it('cannot be mutated by a handler (frozen array stays intact)', () => {
    assert.throws(() => { TASK_STATUSES.push('archived'); }, TypeError);
    assert.throws(() => { TASK_PRIORITIES[0] = 'urgent'; }, TypeError);
    assert.deepEqual(TASK_STATUSES, CANON_STATUSES);
    assert.deepEqual(TASK_PRIORITIES, CANON_PRIORITIES);
  });
});

describe('POST /api/tasks (status/priority validated against the hoisted consts)', () => {
  it('accepts valid status and priority values unchanged', async () => {
    const { captured, saved } = await postTask({ status: 'doing', priority: 'high' });
    assert.equal(captured.status, 201);
    assert.equal(captured.body.success, true);
    assert.equal(captured.body.task.status, 'doing');
    assert.equal(captured.body.task.priority, 'high');
    assert.equal(saved.tasks[0].status, 'doing');
    assert.equal(saved.tasks[0].priority, 'high');
  });

  it('falls back to "todo" / "medium" for invalid status and priority', async () => {
    const { captured } = await postTask({ status: 'bogus', priority: 'bogus' });
    assert.equal(captured.status, 201);
    assert.equal(captured.body.task.status, 'todo');
    assert.equal(captured.body.task.priority, 'medium');
  });

  it('falls back to the defaults when status and priority are omitted', async () => {
    const { captured } = await postTask({});
    assert.equal(captured.status, 201);
    assert.equal(captured.body.task.status, 'todo');
    assert.equal(captured.body.task.priority, 'medium');
  });
});

describe('PUT /api/tasks (status/priority validated against the hoisted consts)', () => {
  it('applies valid status and priority values to the existing task', async () => {
    const { captured, stored } = await putTask(
      { status: 'done', priority: 'high' },
      { status: 'todo', priority: 'low' },
    );
    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
    assert.equal(stored.status, 'done');
    assert.equal(stored.priority, 'high');
  });

  it('ignores invalid status and priority, leaving the existing values intact', async () => {
    const { captured, stored } = await putTask(
      { status: 'bogus', priority: 'bogus' },
      { status: 'doing', priority: 'high' },
    );
    assert.equal(captured.status, 200);
    assert.equal(stored.status, 'doing');
    assert.equal(stored.priority, 'high');
  });
});
