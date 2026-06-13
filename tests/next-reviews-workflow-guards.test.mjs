import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the real module the way the sibling
// server route tests do, so these cases exercise the shipped /api/reviews
// content-review-workflow handlers rather than a reimplementation.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
// The /api/reviews handlers persist to this file via saveJSON. The mocked
// loadJSON below answers only for this path, so any stray read surfaces as a
// thrown error instead of silently passing.
const REVIEWS_FILE = path.join(PROJECT_ROOT, 'data', 'reviews.json');

// Drive the real /api/reviews handler over a mocked ctx. loadJSON returns the
// supplied document, saveJSON records every persist call, and json captures the
// (status, body) the handler hands back. sanitizeText is identity so the
// asserted text equals the input verbatim. No real filesystem, network, or git
// is ever touched.
async function runRoute({ method, body = {}, doc = { reviews: [] }, rateLimitOk = true, search = '' }) {
  const saved = [];
  let captured = null;
  const ctx = {
    rateLimit: () => rateLimitOk,
    readBody: async () => body,
    loadJSON: (fp) => {
      if (fp === REVIEWS_FILE) return doc;
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    sanitizeText: (s) => s,
    path,
    PROJECT_ROOT,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/reviews';
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, saved };
}

describe('POST /api/reviews guards', () => {
  it('a rate-limited POST returns 429 and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'POST',
      rateLimitOk: false,
      body: { path: 'docs/page.md' },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(saved.length, 0);
  });

  it('a missing or non-string path returns 400 and never saves', async () => {
    const missing = await runRoute({ method: 'POST', body: {} });
    assert.equal(missing.captured.status, 400);
    assert.deepEqual(missing.captured.body, { error: 'Missing or invalid path' });
    assert.equal(missing.saved.length, 0);

    // A non-string path (here a number) trips the same guard.
    const nonString = await runRoute({ method: 'POST', body: { path: 42 } });
    assert.equal(nonString.captured.status, 400);
    assert.deepEqual(nonString.captured.body, { error: 'Missing or invalid path' });
    assert.equal(nonString.saved.length, 0);
  });

  it('a path longer than 500 characters returns 400 and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'POST',
      body: { path: 'p'.repeat(501) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Path must be 500 characters or fewer' });
    assert.equal(saved.length, 0);
  });

  it('a requestedBy string longer than 100 characters returns 400 and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'POST',
      body: { path: 'docs/page.md', requestedBy: 'r'.repeat(101) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'requestedBy must be 100 characters or fewer' });
    assert.equal(saved.length, 0);
  });

  it('a note string longer than 5000 characters returns 400 and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'POST',
      body: { path: 'docs/page.md', note: 'n'.repeat(5001) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Note must be 5000 characters or fewer' });
    assert.equal(saved.length, 0);
  });

  it('a valid POST appends a pending review with the documented defaults and saves once', async () => {
    // Seed a document with no reviews array so the handler also exercises its
    // lazy initialization branch before pushing.
    const { captured, saved } = await runRoute({
      method: 'POST',
      doc: {},
      body: { path: 'docs/page.md' },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, REVIEWS_FILE);
    const stored = saved[0].data.reviews;
    assert.equal(stored.length, 1);
    // Structural effects only: the id and createdAt are generated, so assert the
    // fields the handler controls deterministically.
    assert.equal(stored[0].path, 'docs/page.md');
    assert.equal(stored[0].requestedBy, 'Anonymous');
    assert.equal(stored[0].note, '');
    assert.equal(stored[0].status, 'pending');
  });

  it('a valid POST stores a provided requestedBy and note verbatim', async () => {
    const { captured, saved } = await runRoute({
      method: 'POST',
      body: { path: 'docs/page.md', requestedBy: 'Alice', note: 'Please review' },
    });
    assert.equal(captured.status, 200);
    assert.equal(saved.length, 1);
    const stored = saved[0].data.reviews;
    assert.equal(stored[0].requestedBy, 'Alice');
    assert.equal(stored[0].note, 'Please review');
    assert.equal(stored[0].status, 'pending');
  });
});

describe('GET /api/reviews', () => {
  it('returns every review with a total, and ?status filters', async () => {
    const doc = {
      reviews: [
        { id: 'a', status: 'pending' },
        { id: 'b', status: 'approved' },
        { id: 'c', status: 'pending' },
      ],
    };
    const all = await runRoute({ method: 'GET', doc });
    assert.equal(all.captured.status, 200);
    // Pin both the reported total and the returned array length to the seeded
    // count so the case checks the actual payload, not just the handler's own
    // total === reviews.length invariant.
    assert.equal(all.captured.body.total, 3);
    assert.equal(all.captured.body.reviews.length, 3);

    const pending = await runRoute({ method: 'GET', doc, search: '?status=pending' });
    assert.equal(pending.captured.status, 200);
    assert.equal(pending.captured.body.total, 2);
    assert.deepEqual(pending.captured.body.reviews.map(r => r.id), ['a', 'c']);
    assert.ok(pending.captured.body.reviews.every(r => r.status === 'pending'));
  });

  it('a document with no reviews array yields an empty list', async () => {
    const { captured } = await runRoute({ method: 'GET', doc: {} });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { reviews: [], total: 0 });
  });
});

describe('PUT /api/reviews guards', () => {
  it('a rate-limited PUT returns 429 and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'PUT',
      rateLimitOk: false,
      body: { id: 'rev1', status: 'approved' },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(saved.length, 0);
  });

  it('a missing or non-string id returns 400 and never saves', async () => {
    const missing = await runRoute({ method: 'PUT', body: { status: 'approved' } });
    assert.equal(missing.captured.status, 400);
    assert.deepEqual(missing.captured.body, { error: 'Missing or invalid id' });
    assert.equal(missing.saved.length, 0);

    const nonString = await runRoute({ method: 'PUT', body: { id: 99, status: 'approved' } });
    assert.equal(nonString.captured.status, 400);
    assert.deepEqual(nonString.captured.body, { error: 'Missing or invalid id' });
    assert.equal(nonString.saved.length, 0);
  });

  it('a missing or non-string status returns 400 and never saves', async () => {
    const missing = await runRoute({ method: 'PUT', body: { id: 'rev1' } });
    assert.equal(missing.captured.status, 400);
    assert.deepEqual(missing.captured.body, { error: 'Missing or invalid status' });
    assert.equal(missing.saved.length, 0);

    const nonString = await runRoute({ method: 'PUT', body: { id: 'rev1', status: 7 } });
    assert.equal(nonString.captured.status, 400);
    assert.deepEqual(nonString.captured.body, { error: 'Missing or invalid status' });
    assert.equal(nonString.saved.length, 0);
  });

  it('a status outside the whitelist returns 400 and never saves', async () => {
    // Unlike the research-questions PUT, which silently ignores an unknown
    // status, this handler rejects it outright.
    const { captured, saved } = await runRoute({
      method: 'PUT',
      doc: { reviews: [{ id: 'rev1', status: 'pending' }] },
      body: { id: 'rev1', status: 'archived' },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid status' });
    assert.equal(saved.length, 0);
  });

  it('a reviewedBy string longer than 100 characters returns 400 and never saves', async () => {
    // Seed the matching id so this case isolates the reviewedBy length guard:
    // the result is 400 because of the length check, not because the review is
    // absent, regardless of how the handler orders its guards.
    const { captured, saved } = await runRoute({
      method: 'PUT',
      doc: { reviews: [{ id: 'rev1', status: 'pending' }] },
      body: { id: 'rev1', status: 'approved', reviewedBy: 'r'.repeat(101) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'reviewedBy must be 100 characters or fewer' });
    assert.equal(saved.length, 0);
  });

  it('a feedback string longer than 5000 characters returns 400 and never saves', async () => {
    // Seed the matching id so this case isolates the feedback length guard
    // rather than also depending on the absence of the review.
    const { captured, saved } = await runRoute({
      method: 'PUT',
      doc: { reviews: [{ id: 'rev1', status: 'pending' }] },
      body: { id: 'rev1', status: 'approved', feedback: 'f'.repeat(5001) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Feedback must be 5000 characters or fewer' });
    assert.equal(saved.length, 0);
  });

  it('an unknown id returns 404 and never saves', async () => {
    const { captured, saved } = await runRoute({
      method: 'PUT',
      doc: { reviews: [{ id: 'rev_known', status: 'pending' }] },
      body: { id: 'rev_missing', status: 'approved' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Review not found' });
    assert.equal(saved.length, 0);
  });

  it('a valid PUT writes the whitelisted status through and defaults reviewedBy and feedback to null', async () => {
    const { captured, saved } = await runRoute({
      method: 'PUT',
      doc: { reviews: [{ id: 'rev1', status: 'pending' }] },
      body: { id: 'rev1', status: 'approved' },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, REVIEWS_FILE);
    const stored = saved[0].data.reviews.find(r => r.id === 'rev1');
    // Structural effects only: reviewedAt is a generated timestamp, so assert the
    // status value and the null defaults the handler controls deterministically.
    assert.equal(stored.status, 'approved');
    assert.equal(stored.reviewedBy, null);
    assert.equal(stored.feedback, null);
  });
});
