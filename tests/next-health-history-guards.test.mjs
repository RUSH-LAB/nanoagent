import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the REAL route module the way the
// sibling suites do (next-recommendv2-cache, next-trajectory-cache) and reuse
// their mocked-ctx shape. These tests pin the CURRENT behavior of the
// POST and GET /api/health-history handler pair, which is otherwise uncovered.
// Every case runs through a mocked ctx (rateLimit, readBody, loadJSON, saveJSON,
// json recorder), so no real filesystem, network, or git ever happens. The POST
// guard cases also assert saveJSON was never reached, and the success cases
// assert exactly one write, pinning the no-write-on-rejection discipline.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/fake/root';
// The history file path the handler builds from ctx.path + ctx.PROJECT_ROOT.
const HISTORY_FILE = path.join(PROJECT_ROOT, 'data', 'health-history.json');

// Drive the /api/health-history handler with a mocked ctx and capture both the
// json(res, status, payload) response and the list of saveJSON(file, data) calls.
// rateLimit defaults to allowing the request; readBody resolves to `body` unless
// readBodyThrows is set; loadJSON returns a fresh `loadResult` (default {}), which
// the POST success path mutates and the GET path slices. saveJSON only records, so
// nothing is ever written to disk.
async function invokeRoute({ method, body, readBodyThrows = false, loadResult = {}, rateLimit = () => true }) {
  const pathname = '/api/health-history';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const saveCalls = [];
  const ctx = {
    path,
    PROJECT_ROOT,
    rateLimit,
    readBody: async () => {
      if (readBodyThrows) throw new Error('bad body');
      return body;
    },
    loadJSON: () => loadResult,
    saveJSON: (file, data) => { saveCalls.push({ file, data }); },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, pathname, ctx);
  return { captured, saveCalls };
}

describe('POST /api/health-history validation guards (no write on any rejected path)', () => {
  it('returns 429 when the request is rate-limited and never writes', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: 50 }, rateLimit: () => false });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(saveCalls.length, 0, 'a rate-limited request never writes history');
  });

  it('returns 400 when score is missing', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: {} });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid score' });
    assert.equal(saveCalls.length, 0);
  });

  it('returns 400 when score is not a number', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: '88' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid score' });
    assert.equal(saveCalls.length, 0);
  });

  it('returns 400 when score is NaN', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: NaN } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid score' });
    assert.equal(saveCalls.length, 0);
  });

  it('returns 400 when score is Infinity', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: Infinity } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid score' });
    assert.equal(saveCalls.length, 0);
  });

  it('returns 400 when score is below 0', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: -1 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Score must be between 0 and 100' });
    assert.equal(saveCalls.length, 0);
  });

  it('returns 400 when score is above 100', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: 101 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Score must be between 0 and 100' });
    assert.equal(saveCalls.length, 0);
  });

  it('returns 400 when details is a string', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: 50, details: 'nope' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'details must be an object' });
    assert.equal(saveCalls.length, 0);
  });

  it('returns 400 when details is null', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: 50, details: null } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'details must be an object' });
    assert.equal(saveCalls.length, 0);
  });

  it('returns 400 when details is an array', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: 50, details: [1, 2] } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'details must be an object' });
    assert.equal(saveCalls.length, 0);
  });

  it('returns 400 when readBody throws', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', readBodyThrows: true });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Invalid request' });
    assert.equal(saveCalls.length, 0);
  });
});

describe('POST /api/health-history success path (writes exactly once)', () => {
  it('stores details as {} when details is omitted and writes the history file once', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: 75 }, loadResult: {} });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(saveCalls.length, 1, 'a valid score writes exactly once');
    assert.equal(saveCalls[0].file, HISTORY_FILE);
    const saved = saveCalls[0].data;
    assert.equal(saved.entries.length, 1);
    assert.equal(saved.entries[0].score, 75);
    assert.deepEqual(saved.entries[0].details, {}, 'omitted details default to an empty object');
  });

  it('preserves a plain object details and writes once', async () => {
    const details = { note: 'looks good', count: 3 };
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: 60, details }, loadResult: {} });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(saveCalls.length, 1);
    assert.deepEqual(saveCalls[0].data.entries[0].details, details);
  });

  it('accepts the lower boundary score 0', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: 0 }, loadResult: {} });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(saveCalls.length, 1);
    assert.equal(saveCalls[0].data.entries[0].score, 0);
  });

  it('accepts the upper boundary score 100 and appends to existing entries', async () => {
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: 100 }, loadResult: { entries: [{ score: 40, details: {}, date: '2024-01-01T00:00:00.000Z' }] } });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(saveCalls.length, 1);
    const saved = saveCalls[0].data;
    assert.equal(saved.entries.length, 2, 'the new entry appends to the existing log');
    assert.equal(saved.entries[1].score, 100);
  });

  it('trims the log back to the most recent 365 entries when it exceeds the cap', async () => {
    // 365 seeded entries (id 0..364) plus the new POST makes 366, so the handler
    // trims with slice(-365): the oldest (id 0) is dropped and the freshly posted
    // entry stays last. This pins the POST write-side 365-entry cap.
    const seeded = Array.from({ length: 365 }, (_, i) => ({ score: 50, id: i, details: {}, date: '2024-01-01T00:00:00.000Z' }));
    const { captured, saveCalls } = await invokeRoute({ method: 'POST', body: { score: 100 }, loadResult: { entries: seeded } });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(saveCalls.length, 1);
    const saved = saveCalls[0].data;
    assert.equal(saved.entries.length, 365, 'the log is trimmed back to the 365 cap');
    assert.equal(saved.entries[0].id, 1, 'the oldest seeded entry (id 0) is dropped');
    assert.equal(saved.entries[364].score, 100, 'the freshly posted entry is kept last');
    assert.equal(saved.entries[364].id, undefined, 'the last entry is the new one, not a seeded entry');
  });
});

describe('GET /api/health-history (entries slice, total, and trend)', () => {
  it('returns an empty list, total 0, and a stable trend when there is no history', async () => {
    const { captured } = await invokeRoute({ method: 'GET', loadResult: {} });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload.entries, []);
    assert.equal(captured.payload.total, 0);
    assert.equal(captured.payload.trend, 'stable');
  });

  it('reports a stable trend for a single entry (fewer than 2)', async () => {
    const { captured } = await invokeRoute({ method: 'GET', loadResult: { entries: [{ score: 42 }] } });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.total, 1);
    assert.equal(captured.payload.trend, 'stable');
  });

  it('reports a stable trend when the endpoints are equal', async () => {
    const { captured } = await invokeRoute({ method: 'GET', loadResult: { entries: [{ score: 50 }, { score: 99 }, { score: 50 }] } });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.total, 3);
    assert.equal(captured.payload.trend, 'stable');
  });

  it('reports an improving trend when the last score exceeds the first', async () => {
    const { captured } = await invokeRoute({ method: 'GET', loadResult: { entries: [{ score: 10 }, { score: 50 }, { score: 90 }] } });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.total, 3);
    assert.equal(captured.payload.trend, 'improving');
  });

  it('reports a declining trend when the last score is below the first', async () => {
    const { captured } = await invokeRoute({ method: 'GET', loadResult: { entries: [{ score: 90 }, { score: 40 }] } });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.total, 2);
    assert.equal(captured.payload.trend, 'declining');
  });

  it('returns only the last 90 entries with total capped at 90', async () => {
    // 100 entries with ascending scores 0..99. The slice keeps the last 90
    // (scores 10..99), so total is 90 and the trend is improving (99 > 10).
    const entries = Array.from({ length: 100 }, (_, i) => ({ score: i }));
    const { captured } = await invokeRoute({ method: 'GET', loadResult: { entries } });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.entries.length, 90);
    assert.equal(captured.payload.total, 90);
    assert.equal(captured.payload.entries[0].score, 10);
    assert.equal(captured.payload.entries[89].score, 99);
    assert.equal(captured.payload.trend, 'improving');
  });
});
