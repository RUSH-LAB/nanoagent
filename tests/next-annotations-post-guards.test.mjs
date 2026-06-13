import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analysis-admin.js is CommonJS; load the REAL route module the way the other
// server route tests do, so these cases exercise the shipped POST /api/annotations
// create handler instead of a reimplementation.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// Drive POST /api/annotations over a minimal mocked ctx (no real filesystem,
// network, or git). The create handler checks the rate limit, reads the body,
// runs the validation ladder, then loadJSON / push / saveJSON exactly once on
// success and returns {annotation} with status 201. Recorders count readBody and
// saveJSON so every guard branch can assert it short-circuits before the single
// write.
//
// sanitizeText is the identity function (mirroring the own-property guard test)
// so echoed fields stay verbatim, and rateLimitOk drives the 429 branch. The
// store defaults to a fresh {} per call (default parameters evaluate on each
// invocation), so no case pollutes another through shared mutable state.
async function invoke({ body = {}, store = {}, rateLimitOk = true } = {}) {
  const pathname = '/api/annotations';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const annotations = store;
  let captured = null;
  let saveCount = 0;
  let readBodyCount = 0;
  const ctx = {
    ANNOTATIONS_FILE: 'annotations.json',
    rateLimit: () => rateLimitOk,
    readBody: async () => { readBodyCount += 1; return body; },
    loadJSON: () => annotations,
    saveJSON: () => { saveCount += 1; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, pathname, ctx);
  return { captured, annotations, saveCount, readBodyCount };
}

// A complete, valid create body. Each guard case clones this and mutates or
// deletes a single field so the branch under test is the only difference from a
// request that would otherwise reach the 201 success path.
const validBody = () => ({
  page: 'guide/intro',
  text: 'highlighted span',
  startOffset: 3,
  endOffset: 19,
});

describe('POST /api/annotations create guards (current behavior)', () => {
  it('returns 429 and never reads the body or saves when rate limited', async () => {
    const { captured, saveCount, readBodyCount } = await invoke({
      body: validBody(),
      rateLimitOk: false,
    });
    assert.equal(captured.status, 429);
    assert.equal(captured.payload.error, 'Too many requests. Try again in a minute.');
    assert.equal(readBodyCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 400 with no save when page is missing', async () => {
    const body = validBody();
    delete body.page;
    const { captured, saveCount } = await invoke({ body });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing required fields: page, text, startOffset, endOffset');
    assert.equal(saveCount, 0);
  });

  it('returns 400 with no save when text is missing', async () => {
    const body = validBody();
    delete body.text;
    const { captured, saveCount } = await invoke({ body });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing required fields: page, text, startOffset, endOffset');
    assert.equal(saveCount, 0);
  });

  it('returns 400 with no save when startOffset is missing', async () => {
    const body = validBody();
    delete body.startOffset;
    const { captured, saveCount } = await invoke({ body });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing required fields: page, text, startOffset, endOffset');
    assert.equal(saveCount, 0);
  });

  it('returns 400 with no save when endOffset is missing', async () => {
    const body = validBody();
    delete body.endOffset;
    const { captured, saveCount } = await invoke({ body });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing required fields: page, text, startOffset, endOffset');
    assert.equal(saveCount, 0);
  });

  it('accepts startOffset: 0 and endOffset: 0 (the == null guard treats 0 as present)', async () => {
    const { captured, saveCount } = await invoke({
      body: { page: 'guide/intro', text: 'zero span', startOffset: 0, endOffset: 0 },
    });
    assert.equal(captured.status, 201);
    assert.equal(captured.payload.annotation.startOffset, 0);
    assert.equal(captured.payload.annotation.endOffset, 0);
    assert.equal(saveCount, 1);
  });

  it('returns 400 with no save when page exceeds 500 characters', async () => {
    const body = validBody();
    body.page = 'a'.repeat(501);
    const { captured, saveCount } = await invoke({ body });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Page must be 500 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('returns 400 with no save when text exceeds 5000 characters', async () => {
    const body = validBody();
    body.text = 'a'.repeat(5001);
    const { captured, saveCount } = await invoke({ body });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Text must be 5000 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('returns 400 with no save when note exceeds 5000 characters', async () => {
    const body = validBody();
    body.note = 'a'.repeat(5001);
    const { captured, saveCount } = await invoke({ body });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Note must be 5000 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('returns 400 with no save when author exceeds 100 characters', async () => {
    const body = validBody();
    body.author = 'a'.repeat(101);
    const { captured, saveCount } = await invoke({ body });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Author must be 100 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('returns 201 with the new annotation and saves exactly once on a valid create', async () => {
    const { captured, annotations, saveCount } = await invoke({ body: validBody() });
    assert.equal(captured.status, 201);
    const { annotation } = captured.payload;
    // Input fields echoed back through the identity sanitizeText.
    assert.equal(annotation.text, 'highlighted span');
    assert.equal(annotation.startOffset, 3);
    assert.equal(annotation.endOffset, 19);
    // Defaults applied when note and author are omitted.
    assert.equal(annotation.note, '');
    assert.equal(annotation.author, 'Anonymous');
    // Generated fields: pin presence and type only, never the value.
    assert.equal(typeof annotation.id, 'string');
    assert.equal(typeof annotation.createdAt, 'string');
    // Exactly one save, and the empty doc lazily gained the page bucket before
    // the push, holding the returned annotation.
    assert.equal(saveCount, 1);
    assert.equal(annotations['guide/intro'].length, 1);
    assert.equal(annotations['guide/intro'][0].id, annotation.id);
  });
});
