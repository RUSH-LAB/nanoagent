import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the real shipped module the way the
// sibling research-questions suite does, so these cases exercise the actual
// PUT /api/research-questions handler rather than a reimplementation.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
// The PUT handler resolves its store with
// path.join(PROJECT_ROOT, 'data', 'research-questions.json'). The mocked
// loadJSON records the path it is handed, so the boundary case can prove the
// read targeted this exact file.
const RQ_FILE = path.join(PROJECT_ROOT, 'data', 'research-questions.json');

// Drive the real PUT /api/research-questions handler over a mocked ctx.
// loadJSON records every store read and returns the supplied document; saveJSON
// is a tripwire that records every persist; json captures the (status, body)
// the handler hands back. sanitizeText is identity so any asserted text equals
// the input verbatim, and rateLimit always allows the request through (the
// handler is rate-limited before the answer cap guard). No real filesystem,
// network, or git is ever touched.
async function runPut({ body, doc = { questions: [] } }) {
  const loads = [];
  const saves = [];
  let captured = null;
  const ctx = {
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: (fp) => { loads.push(fp); return doc; },
    saveJSON: (fp, data) => { saves.push({ fp, data }); },
    sanitizeText: (s) => s,
    path,
    PROJECT_ROOT,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/research-questions';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'PUT', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, loads, loadCount: loads.length, saveCount: saves.length };
}

describe('PUT /api/research-questions answer length cap', () => {
  it('rejects an answer over the 5000 character cap before reading the store', async () => {
    // A valid string id clears the id guard, so the next rung reached is the
    // answer cap; a 5001 character answer trips it.
    const { captured, loadCount, saveCount } = await runPut({
      body: { id: 'rq_valid', answer: 'a'.repeat(5001) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Answer must be 5000 characters or fewer' });
    // The cap guard returns before the store is touched, so neither the read
    // nor the persist ever runs.
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });

  it('lets an answer of exactly 5000 characters clear the cap and reach the store', async () => {
    // The boundary is inclusive: a 5000 character answer passes the cap and the
    // handler proceeds to the read. With an empty store it finds no matching
    // question and returns the not-found response, not the cap message.
    const { captured, loadCount, loads, saveCount } = await runPut({
      body: { id: 'rq_valid', answer: 'a'.repeat(5000) },
      doc: { questions: [] },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Question not found' });
    assert.notEqual(captured.body.error, 'Answer must be 5000 characters or fewer');
    // Exactly one read, aimed at the research-questions store, proves the
    // 5000 character answer passed the cap guard.
    assert.equal(loadCount, 1);
    assert.equal(loads[0], RQ_FILE);
    assert.equal(saveCount, 0);
  });

  it('treats the cap as string only, so a non-string answer skips it and reaches the store', async () => {
    // The guard is answer !== undefined && typeof answer === 'string' &&
    // answer.length > 5000, so a numeric answer never trips the cap regardless
    // of magnitude; the handler falls through to the read and returns 404.
    const { captured, loadCount, loads, saveCount } = await runPut({
      body: { id: 'rq_valid', answer: 999999 },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Question not found' });
    assert.notEqual(captured.body.error, 'Answer must be 5000 characters or fewer');
    assert.equal(loadCount, 1);
    assert.equal(loads[0], RQ_FILE);
    assert.equal(saveCount, 0);
  });
});
