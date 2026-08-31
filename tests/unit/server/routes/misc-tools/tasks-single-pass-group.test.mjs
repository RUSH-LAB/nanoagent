import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { newStore } from '../../../_harness.mjs';
import path from 'node:path';

// misc-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../../../../../src/server/routes/misc-tools.js');

// Invoke GET /api/tasks with a mocked ctx and capture the json() response.
// loadJSON returns the whole tasks store; the handler reads data.tasks, buckets
// each task by status in one pass, and derives counts from the bucket lengths.
async function getTasks(store) {
  let captured = null;
  // The tasks store holds one row per task, keyed by id, in the caller's scope.
  // Seeded from the same array the JSON fixture used to be.
  const seeded = Object.fromEntries((store.tasks ?? []).map(t => [t.id, t]));
  const ctx = {
    path,
    ...newStore().seed('tasks', seeded).ctxFields,
    json: (_res, status, body) => { captured = { status, body }; return captured; },
  };
  const url = new URL('http://localhost/api/tasks');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await miscToolsRoutes(req, res, url, '/api/tasks', ctx);
  return captured;
}

describe('GET /api/tasks single-pass grouping', () => {
  it('buckets a mix of todo/doing/done plus an unknown status and pins the full body', async () => {
    // Interleave statuses so a per-bucket source-order regression would show up,
    // and include one task whose status matches none of the three buckets.
    const tasks = [
      { id: 'a', status: 'todo' },
      { id: 'b', status: 'doing' },
      { id: 'c', status: 'done' },
      { id: 'd', status: 'todo' },
      { id: 'e', status: 'archived' }, // unknown -> belongs to no bucket
      { id: 'f', status: 'done' },
      { id: 'g', status: 'doing' },
    ];
    const r = await getTasks({ tasks });
    assert.equal(r.status, 200);

    // Top-level shape and key order must stay {tasks, grouped, counts}.
    assert.deepEqual(Object.keys(r.body), ['tasks', 'grouped', 'counts']);
    assert.deepEqual(Object.keys(r.body.grouped), ['todo', 'doing', 'done']);
    assert.deepEqual(Object.keys(r.body.counts), ['todo', 'doing', 'done']);

    // tasks is the untouched input, unknown status included.
    assert.deepEqual(r.body.tasks, tasks);

    // Buckets hold exactly the matching tasks, in original source order.
    assert.deepEqual(r.body.grouped, {
      todo: [{ id: 'a', status: 'todo' }, { id: 'd', status: 'todo' }],
      doing: [{ id: 'b', status: 'doing' }, { id: 'g', status: 'doing' }],
      done: [{ id: 'c', status: 'done' }, { id: 'f', status: 'done' }],
    });

    // counts mirror the bucket lengths; the unknown-status task is counted nowhere.
    assert.deepEqual(r.body.counts, { todo: 2, doing: 2, done: 2 });
  });

  it('serializes byte-identically to the original three-filter implementation', async () => {
    // Pin the GOAL's "byte identical" promise directly: compare the serialized
    // response against the prior algorithm (three strict-equality filter passes)
    // recomputed inline as the reference.
    const tasks = [
      { id: 'a', status: 'todo' },
      { id: 'b', status: 'doing' },
      { id: 'c', status: 'done' },
      { id: 'd', status: 'todo' },
      { id: 'e', status: 'archived' },
      { id: 'f', status: 'done' },
      { id: 'g', status: 'doing' },
    ];
    const r = await getTasks({ tasks });
    const refGrouped = {
      todo: tasks.filter(t => t.status === 'todo'),
      doing: tasks.filter(t => t.status === 'doing'),
      done: tasks.filter(t => t.status === 'done'),
    };
    const reference = {
      tasks,
      grouped: refGrouped,
      counts: {
        todo: refGrouped.todo.length,
        doing: refGrouped.doing.length,
        done: refGrouped.done.length,
      },
    };
    assert.equal(JSON.stringify(r.body), JSON.stringify(reference));
  });

  it('returns empty buckets and zero counts when there are no tasks', async () => {
    const r = await getTasks({});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      tasks: [],
      grouped: { todo: [], doing: [], done: [] },
      counts: { todo: 0, doing: 0, done: 0 },
    });
  });

  // Within one response the buckets hold the same objects the flat list does,
  // rather than copies. Identity with the seed is no longer the way to say that
  // (the store hands back its own parse of each row), but identity between the
  // two views of it in the payload is the property the grouping pass has to keep.
  it('puts the same objects in the buckets as in the flat list, not copies', async () => {
    const r = await getTasks({ tasks: [{ id: 'x', status: 'todo' }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.grouped.todo[0], r.body.tasks[0]);
  });

  it('drops only the unknown-status tasks, never the known ones', async () => {
    const tasks = [
      { id: '1', status: 'weird' },
      { id: '2', status: 'todo' },
      { id: '3', status: '' },
      { id: '4', status: 'done' },
      { id: '5' }, // missing status -> no bucket
    ];
    const r = await getTasks({ tasks });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.grouped, {
      todo: [{ id: '2', status: 'todo' }],
      doing: [],
      done: [{ id: '4', status: 'done' }],
    });
    assert.deepEqual(r.body.counts, { todo: 1, doing: 0, done: 1 });
  });
});
