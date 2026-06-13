import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the real module the way the sibling route
// tests do (see tests/next-pins-crud-guards.test.mjs), so these cases exercise
// the shipped POST /api/templates/custom create handler rather than a
// reimplementation.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
// The create handler reads and persists this single file. The mocked loadJSON
// answers only for this path, so any stray read surfaces as a thrown error
// instead of silently passing.
const TEMPLATES_FILE = path.join(PROJECT_ROOT, 'data', 'custom-templates.json');

// Tag wrapper for sanitizeText so each case can prove WHICH fields the handler
// routes through sanitizeText (name and content) versus which it leaves raw (the
// slug id and the createdAt timestamp).
const tag = (s) => `sanitized:${s}`;

// Drive the real POST /api/templates/custom handler over a mocked ctx. rateLimit
// records its (key, limit) and answers rateLimitOk; readBody counts its calls and
// returns the supplied body; loadJSON returns a fresh clone of the seed document
// per call; saveJSON records every persist; json captures the (status, body) the
// handler hands back. No real filesystem, network, or git is ever touched.
async function runRoute({
  method = 'POST',
  body = {},
  doc = {},
  rateLimitOk = true,
} = {}) {
  const saved = [];
  const rateLimitCalls = [];
  let readBodyCount = 0;
  let loadCount = 0;
  let captured = null;
  const ctx = {
    rateLimit: (key, limit) => {
      rateLimitCalls.push({ key, limit });
      return rateLimitOk;
    },
    readBody: async () => {
      readBodyCount += 1;
      return body;
    },
    loadJSON: (fp) => {
      if (fp === TEMPLATES_FILE) {
        loadCount += 1;
        return structuredClone(doc);
      }
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    sanitizeText: tag,
    path,
    PROJECT_ROOT,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/templates/custom';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, saved, rateLimitCalls, readBodyCount, loadCount };
}

describe('POST /api/templates/custom guards', () => {
  it('a rate-limited POST returns 429, never reads the body, and never saves', async () => {
    const { captured, saved, rateLimitCalls, readBodyCount, loadCount } = await runRoute({
      rateLimitOk: false,
      body: { name: 'My Template', content: 'Body text' },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
    // The guard fires before the try block, so the body is never read or saved.
    assert.equal(readBodyCount, 0);
    assert.equal(loadCount, 0);
    assert.equal(saved.length, 0);
    // The rate-limit bucket is scoped to the client address with a limit of 30.
    assert.equal(rateLimitCalls.length, 1);
    assert.equal(rateLimitCalls[0].key, 'templates:127.0.0.1');
    assert.equal(rateLimitCalls[0].limit, 30);
  });

  it('a missing, empty, or non-string name returns 400 and never saves', async () => {
    const missing = await runRoute({ body: { content: 'Body text' } });
    assert.equal(missing.captured.status, 400);
    assert.deepEqual(missing.captured.body, { error: 'Missing or invalid name' });
    assert.equal(missing.saved.length, 0);

    // An empty string is falsy, so it trips the same guard as a missing name.
    const empty = await runRoute({ body: { name: '', content: 'Body text' } });
    assert.equal(empty.captured.status, 400);
    assert.deepEqual(empty.captured.body, { error: 'Missing or invalid name' });
    assert.equal(empty.saved.length, 0);

    // A non-string name (here a number) trips the typeof check.
    const nonString = await runRoute({ body: { name: 42, content: 'Body text' } });
    assert.equal(nonString.captured.status, 400);
    assert.deepEqual(nonString.captured.body, { error: 'Missing or invalid name' });
    assert.equal(nonString.saved.length, 0);
  });

  it('a name longer than 200 characters returns 400, and a 200-character name clears the guard', async () => {
    const tooLong = await runRoute({ body: { name: 'a'.repeat(201), content: 'Body text' } });
    assert.equal(tooLong.captured.status, 400);
    assert.deepEqual(tooLong.captured.body, { error: 'Name must be 200 characters or fewer' });
    assert.equal(tooLong.saved.length, 0);

    // The bound is exclusive: a length-200 name passes the length guard and the
    // request proceeds to a successful create.
    const atBound = await runRoute({ body: { name: 'a'.repeat(200), content: 'Body text' } });
    assert.equal(atBound.captured.status, 200);
    assert.equal(atBound.captured.body.success, true);
    assert.equal(atBound.saved.length, 1);
  });

  it('a missing, empty, or non-string content returns 400 and never saves', async () => {
    const missing = await runRoute({ body: { name: 'My Template' } });
    assert.equal(missing.captured.status, 400);
    assert.deepEqual(missing.captured.body, { error: 'Missing or invalid content' });
    assert.equal(missing.saved.length, 0);

    const empty = await runRoute({ body: { name: 'My Template', content: '' } });
    assert.equal(empty.captured.status, 400);
    assert.deepEqual(empty.captured.body, { error: 'Missing or invalid content' });
    assert.equal(empty.saved.length, 0);

    const nonString = await runRoute({ body: { name: 'My Template', content: 42 } });
    assert.equal(nonString.captured.status, 400);
    assert.deepEqual(nonString.captured.body, { error: 'Missing or invalid content' });
    assert.equal(nonString.saved.length, 0);
  });

  it('content longer than 50000 characters returns 400, and 50000-character content clears the guard', async () => {
    const tooLong = await runRoute({ body: { name: 'My Template', content: 'x'.repeat(50001) } });
    assert.equal(tooLong.captured.status, 400);
    assert.deepEqual(tooLong.captured.body, { error: 'Content must be 50000 characters or fewer' });
    assert.equal(tooLong.saved.length, 0);

    // The bound is exclusive: length-50000 content passes and the request
    // proceeds to a successful create.
    const atBound = await runRoute({ body: { name: 'My Template', content: 'x'.repeat(50000) } });
    assert.equal(atBound.captured.status, 200);
    assert.equal(atBound.captured.body.success, true);
    assert.equal(atBound.saved.length, 1);
  });

  it('a name that slugifies to an existing id returns 409 and does not save', async () => {
    // The seed already holds the slug `my-template`; posting a name that
    // slugifies to the same id collides.
    const { captured, saved } = await runRoute({
      doc: { items: [{ id: 'my-template' }] },
      body: { name: 'My Template', content: 'Body text' },
    });
    assert.equal(captured.status, 409);
    assert.deepEqual(captured.body, { error: 'Template with this name already exists' });
    assert.equal(saved.length, 0);
  });

  it('a valid create on an empty document returns 200, saves once, and sanitizes name and content', async () => {
    // An empty document also exercises the lazy `if (!templates.items)` init
    // before the push.
    const { captured, saved } = await runRoute({
      doc: {},
      body: { name: 'My Template', content: 'Body text' },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
    const template = captured.body.template;
    // The id is the raw slug and is not routed through sanitizeText.
    assert.equal(template.id, 'my-template');
    // name and content are the sanitizeText outputs, proving both are sanitized.
    assert.equal(template.name, 'sanitized:My Template');
    assert.equal(template.content, 'sanitized:Body text');
    // createdAt is a clock value, so assert only that it is a string.
    assert.equal(typeof template.createdAt, 'string');

    // The handler persists exactly once, to the templates file, with the new
    // template appended to a freshly created items array.
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, TEMPLATES_FILE);
    assert.equal(saved[0].data.items.length, 1);
    assert.deepEqual(saved[0].data.items[0], template);
  });

  it('slugifies the id by lowercasing, collapsing non-alphanumeric runs, and stripping edge dashes', async () => {
    // Trailing punctuation is stripped after the run collapses to one dash.
    const trailing = await runRoute({
      doc: {},
      body: { name: 'My Template!!!', content: 'Body text' },
    });
    assert.equal(trailing.captured.status, 200);
    assert.equal(trailing.captured.body.template.id, 'my-template');

    // An internal run of spaces collapses to a single dash.
    const internal = await runRoute({
      doc: {},
      body: { name: 'My   Template', content: 'Body text' },
    });
    assert.equal(internal.captured.status, 200);
    assert.equal(internal.captured.body.template.id, 'my-template');

    // Leading punctuation is also stripped.
    const leading = await runRoute({
      doc: {},
      body: { name: '###Hello World', content: 'Body text' },
    });
    assert.equal(leading.captured.status, 200);
    assert.equal(leading.captured.body.template.id, 'hello-world');
  });
});
