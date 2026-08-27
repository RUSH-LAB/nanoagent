import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// content-analysis-a.js is CommonJS; load the real module the way the sibling
// route tests do, so this characterization test drives the genuine handler.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');

// The GET /api/analytics/export handler reads only loadJSON, ANALYTICS_FILE,
// CORS_ORIGIN, and json from ctx. loadJSON is stubbed so no real filesystem is
// touched, and every call is recorded so a test can prove the format guard runs
// before any load. CORS_ORIGIN is a distinctive value to prove it flows straight
// into the streamed Access-Control-Allow-Origin header.
const ANALYTICS_FILE = '/fake/root/data/analytics.json';
const CORS_ORIGIN = 'https://mochi.test';

function makeCtx({ analytics = {}, throwOnLoad = false } = {}) {
  const calls = { loadJSON: [] };
  const ctx = {
    ANALYTICS_FILE,
    CORS_ORIGIN,
    loadJSON(file) {
      calls.loadJSON.push(file);
      if (throwOnLoad) throw new Error('analytics store unreadable');
      return analytics;
    },
  };
  return { ctx, calls };
}

// Invoke the export handler with a mocked ctx, capturing BOTH response styles the
// module uses: the raw writeHead(status, headers) plus end(body) stream (the
// success path streams a downloadable CSV) and the json(res, status, payload)
// envelope (the 400 and 500 paths). Fully in process: no network, no server, no
// disk. `writableEnded` is tracked the way the live dispatcher detects a reply.
async function invoke(ctx, search = '') {
  const pathname = '/api/analytics/export';
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  let head = null;
  let body = null;
  let jsonResp = null;
  const res = {
    writableEnded: false,
    writeHead(status, headers) { head = { status, headers }; return this; },
    end(payload) { body = payload; this.writableEnded = true; return this; },
  };
  const fullCtx = {
    json(_res, status, payload) { jsonResp = { status, payload }; res.writableEnded = true; return jsonResp; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return { head, body, json: jsonResp, res };
}

describe('GET /api/analytics/export: format guard', () => {
  it('rejects a non-csv format with 400 Only CSV format supported, before loadJSON', async () => {
    const { ctx, calls } = makeCtx({ analytics: { counts: { a: 1 } } });
    const r = await invoke(ctx, '?format=json');

    assert.deepEqual(r.json, { status: 400, payload: { error: 'Only CSV format supported' } });
    assert.equal(r.head, null, 'no CSV stream is written for a rejected format');
    assert.equal(r.body, null);
    assert.equal(calls.loadJSON.length, 0, 'the format guard precedes the try, so loadJSON never runs');
  });

  it('rejects an arbitrary non-csv format (xml) the same way', async () => {
    const { ctx, calls } = makeCtx({ analytics: { counts: { a: 1 } } });
    const r = await invoke(ctx, '?format=xml');

    assert.deepEqual(r.json, { status: 400, payload: { error: 'Only CSV format supported' } });
    assert.equal(calls.loadJSON.length, 0);
  });
});

describe('GET /api/analytics/export: streamed CSV success', () => {
  it('streams a 200 CSV download with the exact headers and the injected CORS origin', async () => {
    const { ctx, calls } = makeCtx({ analytics: { counts: {} } });
    const r = await invoke(ctx);

    assert.equal(r.json, null, 'success streams via writeHead and end, not the json envelope');
    assert.equal(r.head.status, 200);
    assert.deepEqual(r.head.headers, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="analytics.csv"',
      'Access-Control-Allow-Origin': CORS_ORIGIN,
    });
    assert.equal(r.res.writableEnded, true, 'res.end finished the stream');
    assert.equal(calls.loadJSON.length, 1, 'the success path loads the analytics store once');
    assert.equal(calls.loadJSON[0], ANALYTICS_FILE, 'it loads exactly ANALYTICS_FILE');
  });

  it('emits only the Page,Views header row when counts is empty', async () => {
    const { ctx } = makeCtx({ analytics: { counts: {} } });
    const r = await invoke(ctx);
    assert.equal(r.body, 'Page,Views\n');
  });

  it('treats a missing counts field as empty via analytics.counts || {}', async () => {
    const { ctx } = makeCtx({ analytics: {} });
    const r = await invoke(ctx);
    assert.equal(r.head.status, 200);
    assert.equal(r.body, 'Page,Views\n');
  });

  it('takes the success path for an empty format param, since ?format= resolves to csv', async () => {
    const { ctx, calls } = makeCtx({ analytics: { counts: {} } });
    const r = await invoke(ctx, '?format=');

    assert.equal(r.json, null, 'an empty string format is falsy, so "" || "csv" === "csv"');
    assert.equal(r.head.status, 200);
    assert.equal(r.body, 'Page,Views\n');
    assert.equal(calls.loadJSON.length, 1);
  });
});

describe('GET /api/analytics/export: CSV body shape', () => {
  it('orders rows by views descending', async () => {
    const { ctx } = makeCtx({ analytics: { counts: { a: 1, b: 5, c: 3 } } });
    const r = await invoke(ctx);
    assert.equal(r.body, 'Page,Views\n"b",5\n"c",3\n"a",1\n');
  });

  it('escapes a double quote in a page name by doubling it', async () => {
    const { ctx } = makeCtx({ analytics: { counts: { 'a"b': 2 } } });
    const r = await invoke(ctx);
    assert.equal(r.body, 'Page,Views\n"a""b",2\n');
  });
});

describe('GET /api/analytics/export: failure', () => {
  it('returns 500 CSV export failed via json when loadJSON throws, with no stream', async () => {
    const { ctx } = makeCtx({ throwOnLoad: true });
    const r = await invoke(ctx);

    assert.deepEqual(r.json, { status: 500, payload: { error: 'CSV export failed' } });
    assert.equal(r.head, null, 'the catch returns json, it never writes the CSV stream');
    assert.equal(r.body, null);
  });
});
