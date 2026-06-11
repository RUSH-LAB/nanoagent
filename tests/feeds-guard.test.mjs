import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');
const { numericParam } = feedsRoutes;

const DAY = 86400000;
const dayKey = offset => new Date(Date.now() - offset * DAY).toISOString().slice(0, 10);

// Invoke a feeds route handler with a minimal mocked ctx and capture the
// response that the handler hands to `json(res, status, payload)`.
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
  await feedsRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('numericParam helper', () => {
  it('is exported alongside the route handler', () => {
    assert.equal(typeof feedsRoutes, 'function', 'default export is the route handler');
    assert.equal(typeof numericParam, 'function', 'numericParam is exported');
  });

  it('returns the default for absent values (null / empty string)', () => {
    assert.equal(numericParam(null, 20, 100), 20);
    assert.equal(numericParam('', 20, 100), 20);
  });

  it('returns the default for non-numeric values instead of NaN', () => {
    assert.equal(numericParam('abc', 20, 100), 20);
    assert.equal(numericParam('   ', 20, 100), 20);
    assert.ok(!Number.isNaN(numericParam('abc', 20, 100)), 'never yields NaN');
  });

  it('passes valid numeric values through unchanged', () => {
    assert.equal(numericParam('5', 20, 100), 5);
    assert.equal(numericParam('0', 20, 100), 0);
  });

  it('clamps valid numeric values to max', () => {
    assert.equal(numericParam('200', 20, 100), 100);
    assert.equal(numericParam('1000', 365, 365), 365);
  });

  it('keeps parseInt semantics for leading-numeric values', () => {
    assert.equal(numericParam('12abc', 20, 100), 12);
  });
});

describe('GET /api/sessions limit guard', () => {
  // 120 sessions so the default (20) and the clamp (100) are both observable,
  // and so the broken NaN path (returning everything) is distinguishable.
  const sessions = { u: Array.from({ length: 120 }, () => ({ duration: 1, wordsWritten: 2 })) };
  const ctx = { path, PROJECT_ROOT: '/tmp/feeds-guard-test', loadJSON: () => sessions };
  const callSessions = search => invoke({ pathname: '/api/sessions', search, ctx });

  it('absent limit returns the default-sized page (20)', async () => {
    const r = await callSessions('?userId=u');
    assert.equal(r.status, 200);
    assert.equal(r.payload.summary.totalSessions, 20);
  });

  it('valid limit is honored', async () => {
    const r = await callSessions('?userId=u&limit=5');
    assert.equal(r.status, 200);
    assert.equal(r.payload.summary.totalSessions, 5);
  });

  it('valid limit above the cap clamps to 100', async () => {
    const r = await callSessions('?userId=u&limit=200');
    assert.equal(r.status, 200);
    assert.equal(r.payload.summary.totalSessions, 100);
  });

  it('non-numeric limit falls back to the default instead of returning everything', async () => {
    const r = await callSessions('?userId=u&limit=abc');
    assert.equal(r.status, 200);
    assert.equal(r.payload.summary.totalSessions, 20, 'guarded to default, not all 120');
  });
});

describe('GET /api/activity-heatmap days guard', () => {
  // Fixed heatmap with entries at offsets chosen far from the 365/50 cutoffs so
  // membership is stable regardless of the exact moment the handler runs.
  const heatmap = {
    [dayKey(1)]: 1,
    [dayKey(30)]: 2,
    [dayKey(200)]: 3,
    [dayKey(400)]: 5,
  };
  const ctx = { cached: () => heatmap };
  const callHeatmap = search => invoke({ pathname: '/api/activity-heatmap', search, ctx });

  it('absent days uses the 365-day window (excludes the 400-day-old entry)', async () => {
    const r = await callHeatmap('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.totalDays, 3);
  });

  it('valid days narrows the window', async () => {
    const r = await callHeatmap('?days=50');
    assert.equal(r.status, 200);
    assert.equal(r.payload.totalDays, 2);
  });

  it('non-numeric days returns the default window instead of a 500', async () => {
    const def = await callHeatmap('');
    const bad = await callHeatmap('?days=abc');
    assert.equal(bad.status, 200, 'no longer throws on Invalid Date');
    assert.deepEqual(bad.payload, def.payload, 'matches the default-window result');
  });
});
