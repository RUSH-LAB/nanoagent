import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../server/routes/misc-tools.js');

const SCHEDULES_FILE = 'schedules.json';

// Invoke the /api/schedule handler with a mocked ctx and capture everything the
// handler touches on this path. `stored` is what the schedules file holds on
// disk; the mocked loadJSON hands back a fresh deep copy on every call (mirroring
// the real pure loader) and bumps a counter so a test can prove the handler now
// reads the file exactly once instead of twice. saveJSON records its payload and
// json() records the response.
async function invokeSchedule({ method, body, stored }) {
  let loadCount = 0;
  let saved = null; // { file, payload } from saveJSON, if the handler saves
  let captured = null; // { status, body } from json
  const ctx = {
    SCHEDULES_FILE,
    path,
    PROJECT_ROOT: '/tmp/next-schedule-single-load-test',
    rateLimit: () => true,
    isValidFilePath: () => true,
    fs: { existsSync: () => true },
    readBody: async () => body,
    loadJSON: () => {
      loadCount++;
      return JSON.parse(JSON.stringify(stored));
    },
    saveJSON: (file, payload) => { saved = { file, payload }; },
    json: (_res, status, b) => { captured = { status, body: b }; return captured; },
  };
  const url = new URL('http://localhost/api/schedule');
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await miscToolsRoutes(req, res, url, '/api/schedule', ctx);
  return { res: captured, saved, loadCount };
}

const isoSchedule = (filePath, publishAt, createdAt) => ({
  path: filePath,
  publishAt,
  createdAt,
});

describe('GET /api/schedule reads the file once', () => {
  it('returns the stored schedules unchanged with a single read', async () => {
    const stored = [
      isoSchedule('content/a.md', '2030-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
      isoSchedule('content/b.md', '2030-02-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z'),
    ];
    const { res, saved, loadCount } = await invokeSchedule({ method: 'GET', stored });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { schedules: stored });
    assert.equal(loadCount, 1, 'loadJSON called exactly once (was twice before the fix)');
    assert.equal(saved, null, 'GET never saves');
  });

  it('treats a non-array file as an empty list', async () => {
    const { res, saved, loadCount } = await invokeSchedule({ method: 'GET', stored: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { schedules: [] });
    assert.equal(loadCount, 1);
    assert.equal(saved, null);
  });
});

describe('POST /api/schedule reads the file once', () => {
  it('appends a new schedule, preserving existing entries, with a single read', async () => {
    const stored = [
      isoSchedule('content/existing.md', '2030-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
    ];
    const body = { path: 'content/new.md', publishAt: '2030-06-01T12:00:00Z' };
    const { res, saved, loadCount } = await invokeSchedule({ method: 'POST', body, stored });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.schedule.path, 'content/new.md');
    assert.equal(res.body.schedule.publishAt, '2030-06-01T12:00:00.000Z', 'publishAt normalized to ISO');
    assert.ok(
      typeof res.body.schedule.createdAt === 'string' && !Number.isNaN(Date.parse(res.body.schedule.createdAt)),
      'createdAt is a valid ISO timestamp',
    );

    assert.equal(loadCount, 1, 'loadJSON called exactly once (was twice before the fix)');
    assert.equal(saved.file, SCHEDULES_FILE);
    assert.ok(Array.isArray(saved.payload));
    assert.equal(saved.payload.length, 2, 'existing entry kept, new one appended');
    assert.deepEqual(saved.payload[0], stored[0], 'existing entry untouched');
    assert.deepEqual(saved.payload[1], res.body.schedule, 'saved tail matches the returned schedule');
  });

  it('replaces an existing schedule for the same path rather than duplicating it', async () => {
    const stored = [
      isoSchedule('content/dup.md', '2030-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
    ];
    const body = { path: 'content/dup.md', publishAt: '2031-02-02T00:00:00Z' };
    const { res, saved, loadCount } = await invokeSchedule({ method: 'POST', body, stored });

    assert.equal(res.status, 200);
    assert.equal(loadCount, 1);
    assert.equal(saved.payload.length, 1, 'old entry for the path removed before the new one is pushed');
    assert.equal(saved.payload[0].path, 'content/dup.md');
    assert.equal(saved.payload[0].publishAt, '2031-02-02T00:00:00.000Z');
    assert.deepEqual(saved.payload[0], res.body.schedule);
  });

  it('treats a non-array file as an empty list before appending', async () => {
    const body = { path: 'content/new.md', publishAt: '2030-06-01T12:00:00Z' };
    const { res, saved, loadCount } = await invokeSchedule({ method: 'POST', body, stored: {} });
    assert.equal(res.status, 200);
    assert.equal(loadCount, 1);
    assert.equal(saved.payload.length, 1);
    assert.equal(saved.payload[0].path, 'content/new.md');
  });
});

describe('DELETE /api/schedule reads the file once', () => {
  it('removes the matching schedule and saves the remainder with a single read', async () => {
    const stored = [
      isoSchedule('content/a.md', '2030-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
      isoSchedule('content/b.md', '2030-02-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z'),
    ];
    const { res, saved, loadCount } = await invokeSchedule({
      method: 'DELETE',
      body: { path: 'content/a.md' },
      stored,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true });
    assert.equal(loadCount, 1, 'loadJSON called exactly once (was twice before the fix)');
    assert.equal(saved.file, SCHEDULES_FILE);
    assert.deepEqual(saved.payload, [stored[1]], 'only the non-matching entry remains');
  });

  it('returns 404 without saving when the path is absent, still reading once', async () => {
    const stored = [
      isoSchedule('content/a.md', '2030-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
    ];
    const { res, saved, loadCount } = await invokeSchedule({
      method: 'DELETE',
      body: { path: 'content/missing.md' },
      stored,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Schedule not found' });
    assert.equal(loadCount, 1, 'loadJSON called exactly once (was twice before the fix)');
    assert.equal(saved, null, 'nothing saved when no entry matched');
  });

  it('treats a non-array file as an empty list (nothing to delete)', async () => {
    const { res, saved, loadCount } = await invokeSchedule({
      method: 'DELETE',
      body: { path: 'content/a.md' },
      stored: {},
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Schedule not found' });
    assert.equal(loadCount, 1);
    assert.equal(saved, null);
  });
});
