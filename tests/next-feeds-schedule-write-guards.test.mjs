import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load the real module the way the sibling server route
// tests do (see tests/next-reviews-workflow-guards.test.mjs and
// tests/next-feeds-fold-schedule.test.mjs), so these cases exercise the shipped
// POST and DELETE /api/schedule write handlers rather than a reimplementation.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

const PROJECT_ROOT = '/proj';
// Both write handlers persist to this path via saveJSON. The mocked loadJSON
// below answers only for this path, so any stray read surfaces as a thrown
// error instead of silently passing. The GET handler already has coverage in
// tests/next-feeds-fold-schedule.test.mjs; this file pins the two write
// handlers, namely their guards and their save effects.
const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'data', 'schedule.json');

// Drive a real /api/schedule handler over a mocked ctx. readBody returns the
// supplied body, loadJSON returns the supplied document, saveJSON records every
// persist call, and json captures the (status, body) the handler hands back.
// sanitizeText is identity so a stored value equals its input verbatim. The
// schedule write handlers do not call rateLimit, so ctx omits it. No real
// filesystem, network, or git is ever touched.
async function runRoute({ method, body = {}, doc = {} }) {
  const saved = [];
  let captured = null;
  const ctx = {
    readBody: async () => body,
    loadJSON: (fp) => {
      if (fp === SCHEDULE_FILE) return doc;
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    sanitizeText: (s) => s,
    path,
    PROJECT_ROOT,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/schedule';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await feedsRoutes(req, res, url, pathname, ctx);
  return { captured, saved };
}

describe('POST /api/schedule write guards', () => {
  it('a missing or non-string path returns 400 and never saves', async () => {
    const missing = await runRoute({ method: 'POST', body: {} });
    assert.equal(missing.captured.status, 400);
    assert.deepEqual(missing.captured.body, { error: 'Missing or invalid path' });
    assert.equal(missing.saved.length, 0);

    // A non-string path (here a number) trips the same guard before any save,
    // even with a valid publishAt present.
    const nonString = await runRoute({
      method: 'POST',
      body: { path: 42, publishAt: '2026-07-01T00:00:00.000Z' },
    });
    assert.equal(nonString.captured.status, 400);
    assert.deepEqual(nonString.captured.body, { error: 'Missing or invalid path' });
    assert.equal(nonString.saved.length, 0);
  });

  it('a missing or non-string publishAt returns 400 and never saves', async () => {
    const missing = await runRoute({ method: 'POST', body: { path: 'content/page.md' } });
    assert.equal(missing.captured.status, 400);
    assert.deepEqual(missing.captured.body, { error: 'Missing or invalid publishAt' });
    assert.equal(missing.saved.length, 0);

    const nonString = await runRoute({
      method: 'POST',
      body: { path: 'content/page.md', publishAt: 123 },
    });
    assert.equal(nonString.captured.status, 400);
    assert.deepEqual(nonString.captured.body, { error: 'Missing or invalid publishAt' });
    assert.equal(nonString.saved.length, 0);
  });

  it('a present but non-string note returns 400 and never saves', async () => {
    // path and publishAt are valid, so this isolates the note type guard, which
    // fires only when note is present and not a string.
    const { captured, saved } = await runRoute({
      method: 'POST',
      body: { path: 'content/page.md', publishAt: '2026-07-01T00:00:00.000Z', note: 123 },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'note must be a string' });
    assert.equal(saved.length, 0);
  });

  it('a valid POST lazy-inits items, pushes one scheduled item, and saves once', async () => {
    // Seed a document with no items key so the handler also exercises its lazy
    // initialization branch before pushing.
    const { captured, saved } = await runRoute({
      method: 'POST',
      doc: {},
      body: { path: 'content/page.md', publishAt: '2026-07-01T00:00:00.000Z' },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
    // The response carries exactly the success flag and the created item.
    assert.deepEqual(Object.keys(captured.body).sort(), ['item', 'success']);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, SCHEDULE_FILE);

    const stored = saved[0].data.items;
    assert.equal(stored.length, 1);
    // Deterministic effects only: the id and createdAt are generated from the
    // clock and randomness, so assert the fields the handler sets verbatim and
    // never the generated id or timestamp.
    assert.equal(stored[0].path, 'content/page.md');
    assert.equal(stored[0].publishAt, '2026-07-01T00:00:00.000Z');
    assert.equal(stored[0].note, '');
    assert.equal(stored[0].status, 'scheduled');
    // The item returned in the response is the one that was persisted.
    assert.equal(captured.body.item, stored[0]);
  });

  it('a valid POST stores a provided note verbatim and appends to existing items', async () => {
    // An existing items array must be appended to, not replaced.
    const existing = {
      id: 'sched_old',
      path: 'content/old.md',
      publishAt: '2026-01-01T00:00:00.000Z',
      note: '',
      status: 'scheduled',
    };
    const { captured, saved } = await runRoute({
      method: 'POST',
      doc: { items: [existing] },
      body: { path: 'content/new.md', publishAt: '2026-08-01T00:00:00.000Z', note: 'Publish after review' },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
    assert.equal(saved.length, 1);

    const stored = saved[0].data.items;
    assert.equal(stored.length, 2);
    assert.equal(stored[0], existing); // prior item preserved
    assert.equal(stored[1].path, 'content/new.md');
    assert.equal(stored[1].publishAt, '2026-08-01T00:00:00.000Z');
    assert.equal(stored[1].note, 'Publish after review');
    assert.equal(stored[1].status, 'scheduled');
  });
});

describe('DELETE /api/schedule write guards', () => {
  it('a missing id returns 400 and never saves', async () => {
    const { captured, saved } = await runRoute({ method: 'DELETE', body: {} });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Missing id' });
    assert.equal(saved.length, 0);
  });

  it('a schedule with no items key returns 404 Not found and never saves', async () => {
    const { captured, saved } = await runRoute({ method: 'DELETE', doc: {}, body: { id: 'sched_x' } });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Not found' });
    assert.equal(saved.length, 0);
  });

  it('an id absent from items returns 404 Scheduled item not found and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'DELETE',
      doc: { items: [{ id: 'sched_a' }, { id: 'sched_b' }] },
      body: { id: 'sched_missing' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Scheduled item not found' });
    assert.equal(saved.length, 0);
  });

  it('a valid DELETE removes the matching item, saves once, and returns success', async () => {
    const { captured, saved } = await runRoute({
      method: 'DELETE',
      doc: { items: [{ id: 'sched_a' }, { id: 'sched_b' }] },
      body: { id: 'sched_a' },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, SCHEDULE_FILE);

    const remaining = saved[0].data.items;
    assert.equal(remaining.length, 1);
    assert.equal(remaining.find(i => i.id === 'sched_a'), undefined);
    assert.deepEqual(remaining.map(i => i.id), ['sched_b']);
  });
});
