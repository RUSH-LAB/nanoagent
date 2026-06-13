import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the real module the way the sibling
// server route tests do, so these cases exercise the shipped handlers rather
// than a reimplementation.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
// The /api/research-questions handlers persist to this file via saveJSON. The
// mocked loadJSON below answers only for this path, so any stray read surfaces
// as a thrown error instead of silently passing.
const RQ_FILE = path.join(PROJECT_ROOT, 'data', 'research-questions.json');

// Drive the real /api/research-questions handler over a mocked ctx. loadJSON
// returns the supplied document, saveJSON records every persist call, and json
// captures the (status, body) the handler hands back. sanitizeText is identity
// so the asserted text equals the input verbatim. No real filesystem, network,
// or git is ever touched.
async function runRoute({ method, body = {}, doc = { questions: [] }, rateLimitOk = true, search = '' }) {
  const saved = [];
  let captured = null;
  const ctx = {
    rateLimit: () => rateLimitOk,
    readBody: async () => body,
    loadJSON: (fp) => {
      if (fp === RQ_FILE) return doc;
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    sanitizeText: (s) => s,
    path,
    PROJECT_ROOT,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/research-questions';
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, saved };
}

describe('POST /api/research-questions guards', () => {
  it('a rate-limited POST returns 429 and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'POST',
      rateLimitOk: false,
      body: { question: 'Anything' },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(saved.length, 0);
  });

  it('a missing or non-string question returns 400 and never saves', async () => {
    const missing = await runRoute({ method: 'POST', body: {} });
    assert.equal(missing.captured.status, 400);
    assert.deepEqual(missing.captured.body, { error: 'Missing or invalid question' });
    assert.equal(missing.saved.length, 0);

    // A non-string question (here a number) trips the same guard.
    const nonString = await runRoute({ method: 'POST', body: { question: 42 } });
    assert.equal(nonString.captured.status, 400);
    assert.deepEqual(nonString.captured.body, { error: 'Missing or invalid question' });
    assert.equal(nonString.saved.length, 0);
  });

  it('a question longer than 5000 characters returns 400 and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'POST',
      body: { question: 'q'.repeat(5001) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Question must be 5000 characters or fewer' });
    assert.equal(saved.length, 0);
  });

  it('a context longer than 5000 characters returns 400 and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'POST',
      body: { question: 'ok', context: 'c'.repeat(5001) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Context must be 5000 characters or fewer' });
    assert.equal(saved.length, 0);
  });

  it('a valid POST appends an open question and saves once', async () => {
    // Seed a document with no questions array so the handler also exercises its
    // lazy initialization branch before pushing.
    const { captured, saved } = await runRoute({
      method: 'POST',
      doc: {},
      body: { question: 'What is X?', context: 'Some context' },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, RQ_FILE);
    const stored = saved[0].data.questions;
    assert.equal(stored.length, 1);
    // Structural effects only: the id and createdAt are generated, so assert the
    // fields the handler controls deterministically.
    assert.equal(stored[0].question, 'What is X?');
    assert.equal(stored[0].context, 'Some context');
    assert.equal(stored[0].status, 'open');
    assert.deepEqual(stored[0].relatedPapers, []);
    assert.deepEqual(stored[0].tags, []);
  });
});

describe('PUT /api/research-questions guards', () => {
  it('a missing or non-string id returns 400 and never saves', async () => {
    const missing = await runRoute({ method: 'PUT', body: { status: 'open' } });
    assert.equal(missing.captured.status, 400);
    assert.deepEqual(missing.captured.body, { error: 'Missing or invalid id' });
    assert.equal(missing.saved.length, 0);

    const nonString = await runRoute({ method: 'PUT', body: { id: 99 } });
    assert.equal(nonString.captured.status, 400);
    assert.deepEqual(nonString.captured.body, { error: 'Missing or invalid id' });
    assert.equal(nonString.saved.length, 0);
  });

  it('an unknown id returns 404 and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'PUT',
      doc: { questions: [{ id: 'rq_known', status: 'open' }] },
      body: { id: 'rq_missing', status: 'resolved' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Question not found' });
    assert.equal(saved.length, 0);
  });

  it('the status whitelist updates a valid value, ignores an unknown one, and saves once each', async () => {
    // A whitelisted status is written through.
    const valid = await runRoute({
      method: 'PUT',
      doc: { questions: [{ id: 'rq1', status: 'open' }] },
      body: { id: 'rq1', status: 'resolved' },
    });
    assert.equal(valid.captured.status, 200);
    assert.equal(valid.saved.length, 1);
    assert.equal(valid.saved[0].data.questions[0].status, 'resolved');

    // A status outside the allowed set leaves the value unchanged, yet the
    // handler still persists and returns 200.
    const invalid = await runRoute({
      method: 'PUT',
      doc: { questions: [{ id: 'rq1', status: 'open' }] },
      body: { id: 'rq1', status: 'archived' },
    });
    assert.equal(invalid.captured.status, 200);
    assert.equal(invalid.saved.length, 1);
    assert.equal(invalid.saved[0].data.questions[0].status, 'open');
  });
});

describe('DELETE /api/research-questions guards', () => {
  it('a missing id returns 400 and never saves', async () => {
    const { captured, saved } = await runRoute({ method: 'DELETE', body: {} });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Missing id' });
    assert.equal(saved.length, 0);
  });

  it('returns 404 when there are no questions or the id is absent', async () => {
    // No questions array at all yields the generic not-found.
    const empty = await runRoute({ method: 'DELETE', doc: {}, body: { id: 'rq1' } });
    assert.equal(empty.captured.status, 404);
    assert.deepEqual(empty.captured.body, { error: 'Not found' });
    assert.equal(empty.saved.length, 0);

    // A populated list without the id yields the question-specific not-found.
    const absent = await runRoute({
      method: 'DELETE',
      doc: { questions: [{ id: 'rq_other' }] },
      body: { id: 'rq1' },
    });
    assert.equal(absent.captured.status, 404);
    assert.deepEqual(absent.captured.body, { error: 'Question not found' });
    assert.equal(absent.saved.length, 0);
  });

  it('a valid DELETE removes the matching question and saves once', async () => {
    const { captured, saved } = await runRoute({
      method: 'DELETE',
      doc: { questions: [{ id: 'keep1' }, { id: 'drop' }, { id: 'keep2' }] },
      body: { id: 'drop' },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true });
    assert.equal(saved.length, 1);
    const remaining = saved[0].data.questions.map(q => q.id);
    assert.deepEqual(remaining, ['keep1', 'keep2']);
  });
});

describe('GET /api/research-questions', () => {
  it('returns every question with a total, and ?status filters', async () => {
    const doc = {
      questions: [
        { id: 'a', status: 'open' },
        { id: 'b', status: 'resolved' },
        { id: 'c', status: 'open' },
      ],
    };
    const all = await runRoute({ method: 'GET', doc });
    assert.equal(all.captured.status, 200);
    assert.equal(all.captured.body.total, 3);
    assert.equal(all.captured.body.questions.length, all.captured.body.total);

    const open = await runRoute({ method: 'GET', doc, search: '?status=open' });
    assert.equal(open.captured.status, 200);
    assert.equal(open.captured.body.total, 2);
    assert.deepEqual(open.captured.body.questions.map(q => q.id), ['a', 'c']);
    assert.ok(open.captured.body.questions.every(q => q.status === 'open'));
  });
});
