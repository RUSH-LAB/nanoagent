import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Pins the loop-invariant `titleSlug` hoist in POST /api/recommendations/add
// (server/routes/research-tools.js). The key-collision `while (refs[finalKey])`
// loop used to recompute, on every iteration:
//
//   const titleSlug = (title || '').split(/\s+/).slice(0, 1).join('')
//     .toLowerCase().replace(/[^a-z0-9]/g, '');
//
// `titleSlug` depends only on `title`, which the L491 guard forces to a non-empty
// string and the loop never reassigns, so it is loop-invariant and is now computed
// once before the loop.
//
// Two layers of coverage:
//   1. Source shape: the hoist is behavior preserving, so a behavior test alone
//      cannot tell a hoisted handler from a non-hoisted one (both compute the same
//      key). A source-level check is what actually pins the move, mirroring the
//      verify.sh gate and the sibling tests/next-perfmetric-lastentry.test.mjs.
//   2. Behavior: drive the real handler over a mocked ctx (the shape from
//      tests/next-recadd-invalidate-stats.test.mjs) across a no-collision case,
//      a single-collision case that exercises `${baseKey}${titleSlug}`, and a
//      double-collision case that exercises the `${baseKey}${suffix}` fallback.

const require = createRequire(import.meta.url);
const routes = require('../server/routes/research-tools.js');
const yaml = require('js-yaml');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'server', 'routes', 'research-tools.js');
const PROJECT_ROOT = '/proj';

// Invoke the recommendations/add handler with a mocked ctx. `existingRefs` seeds
// the bibliography the handler reads (so the collision loop runs); the YAML the
// handler would write is captured and parsed back so a test can read the entry it
// actually saved. No network and no real filesystem are touched.
async function invoke({ body, existingRefs = {} }) {
  const pathname = '/api/recommendations/add';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };

  let captured = null;
  let writtenContent = null;

  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    readBody: async () => body,
    rateLimit: () => true,
    sanitizeText: s => s,
    invalidateCache() {},
    fs: {
      readFileSync: () => yaml.dump(existingRefs),
      writeFileSync: (_p, content) => { writtenContent = content; },
    },
    path,
    PROJECT_ROOT,
  };

  await routes(req, res, url, pathname, fullCtx);
  const written = writtenContent == null ? null : yaml.load(writtenContent);
  return { captured, written };
}

describe('research-tools.js recommendations/add hoists titleSlug above the collision loop (source shape)', () => {
  const src = readFileSync(SRC, 'utf-8');
  const lines = src.split('\n');
  const declLine = lines.findIndex(l => l.includes('const titleSlug = (title'));
  const whileLine = lines.findIndex(l => l.includes('while (refs[finalKey])'));

  it('declares const titleSlug exactly once', () => {
    const count = lines.filter(l => l.includes('const titleSlug = (title')).length;
    assert.equal(count, 1, 'titleSlug must be declared exactly once');
  });

  it('positions the titleSlug declaration before the collision while-loop', () => {
    assert.ok(declLine !== -1, 'titleSlug declaration not found');
    assert.ok(whileLine !== -1, 'collision while-loop not found');
    assert.ok(declLine < whileLine, 'titleSlug must be hoisted above the while loop');
  });

  it('no longer recomputes titleSlug inside the loop body', () => {
    // The loop body spans the two lines after the `while (...) {` opener; neither
    // may re-declare titleSlug.
    const body = lines.slice(whileLine + 1, whileLine + 4).join('\n');
    assert.ok(!body.includes('const titleSlug'), 'the loop body must not re-declare titleSlug');
  });
});

describe('POST /api/recommendations/add key collision resolution (behavior)', () => {
  it('uses the plain baseKey when there is no collision', async () => {
    const { captured, written } = await invoke({
      body: { title: 'Some Unique Paper', authors: ['Jane Smith'], year: 2020 },
    });

    assert.equal(captured.status, 201);
    assert.equal(captured.payload.success, true);
    assert.equal(captured.payload.key, 'smith2020', 'no collision keeps the bare baseKey');
    assert.ok(written.smith2020, 'the entry is saved under the baseKey');
    assert.equal(written.smith2020.title, 'Some Unique Paper');
  });

  it('appends the titleSlug when the baseKey already exists', async () => {
    const { captured, written } = await invoke({
      body: { title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer'], year: 2017 },
      existingRefs: { vaswani2017: { type: 'article', title: 'Existing Vaswani 2017' } },
    });

    assert.equal(captured.status, 201);
    assert.equal(captured.payload.key, 'vaswani2017attention', 'a single collision resolves to baseKey + titleSlug');
    assert.equal(written.vaswani2017attention.title, 'Attention Is All You Need');
    assert.equal(written.vaswani2017.title, 'Existing Vaswani 2017', 'the pre-existing colliding entry is untouched');
  });

  it('falls back to baseKey + suffix when baseKey and baseKey+titleSlug both exist', async () => {
    const { captured, written } = await invoke({
      body: { title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], year: 2017 },
      existingRefs: {
        vaswani2017: { type: 'article', title: 'First' },
        vaswani2017attention: { type: 'article', title: 'Second' },
      },
    });

    assert.equal(captured.status, 201);
    assert.equal(captured.payload.key, 'vaswani20172', 'a deeper collision exercises the ${baseKey}${suffix} fallback');
    assert.equal(written.vaswani20172.title, 'Attention Is All You Need');
    assert.equal(written.vaswani2017.title, 'First', 'pre-existing entries stay intact');
    assert.equal(written.vaswani2017attention.title, 'Second', 'pre-existing entries stay intact');
  });

  it('falls back to baseKey + suffix when the title slugifies to empty and the baseKey collides', async () => {
    // A first word with no a-z0-9 characters (here a CJK word) slugifies to '', so
    // `${baseKey}${titleSlug || suffix}` takes the numeric suffix branch. This pins
    // the hoisted empty-string value flowing correctly into the loop.
    const { captured, written } = await invoke({
      body: { title: '图 graph theory', authors: ['Maria Gonzalez'], year: 2023 },
      existingRefs: { gonzalez2023: { type: 'article', title: 'Existing' } },
    });

    assert.equal(captured.status, 201);
    assert.equal(captured.payload.key, 'gonzalez20231', 'an empty slug uses baseKey + numeric suffix');
    assert.equal(written.gonzalez20231.title, '图 graph theory');
    assert.equal(written.gonzalez2023.title, 'Existing', 'the pre-existing colliding entry is untouched');
  });
});
