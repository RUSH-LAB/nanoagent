import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Pins the streaming branches of the module-scope body readers in server/index.js:
//   - `readBody(req)` accumulates request chunks, rejects with `Body too large`
//     as soon as the running size passes MAX_BODY_SIZE, and on `end` resolves
//     JSON.parse(...) of the joined buffer (rejecting `Invalid JSON` when the
//     bytes do not parse).
//   - `readRawBody(req)` shares the exact same size guard, but on `end` resolves
//     the raw Buffer.concat(chunks) with no JSON parse.
//
// The many `readBody` references already in tests/ are all test-local MOCKED
// `ctx.readBody` that throw `Invalid JSON` to drive handler catch-mapping; none
// exercise server/index.js's REAL streaming parser, size guard, or raw resolve. This
// add-only characterization test pins those bytes.
//
// server/index.js calls server.listen() at module load and exports nothing, so it
// cannot be require()'d from a unit test. Following
// tests/next-server-cached-invalidatecache.test.mjs and the sibling source-lift
// tests, we lift the exact source of the two top-level functions, brace-balance
// their bodies, and instantiate them together in ONE new Function scope (so they
// share the injected MAX_BODY_SIZE) while injecting a tiny cap so a small chunk
// trips the size guard. This pins the helpers' real bytes rather than a
// reimplementation, and never boots a server.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

// Lift a top-level `function <name>` out of server/index.js by brace balancing. The
// start is the line beginning with `function <name>`; the end is the line where
// the brace depth returns to zero. Robust to indentation and nested blocks (the
// bodies hold no braces inside strings or comments). Fails loud (a failed assert
// or a SyntaxError from new Function), never silently. Mirrors the sibling
// source-lift tests.
function extractFn(src, name) {
  const lines = src.split('\n');
  const startRe = new RegExp('^function ' + name + '\\b');
  const start = lines.findIndex(l => startRe.test(l));
  assert.ok(start !== -1, `server/index.js must define a top-level \`function ${name}\``);
  let depth = 0, opened = false, end = -1;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') depth--;
    }
    if (opened && depth === 0) { end = i; break; }
  }
  assert.ok(end !== -1, `could not find the end of \`function ${name}\` in server/index.js`);
  return lines.slice(start, end + 1).join('\n');
}

// Read the real server/index.js once and lift readBody + readRawBody into a single
// factory. make(MAX_BODY_SIZE) binds both functions to the supplied cap, so a
// test can inject a tiny limit and trip the size guard with a small chunk. Both
// functions reference the free variable MAX_BODY_SIZE (a module import in the
// real server/index.js); injecting it as the factory parameter is what lets a 7-byte
// chunk overflow a cap of 5.
const src = readFileSync(path.join(REPO_ROOT, 'src/server/index.js'), 'utf-8');
const readBodySrc = extractFn(src, 'readBody');
const readRawBodySrc = extractFn(src, 'readRawBody');
const make = new Function(
  'MAX_BODY_SIZE',
  readBodySrc + '\n\n' + readRawBodySrc + '\nreturn { readBody, readRawBody };',
);

// Inject MAX_BODY_SIZE = 5 so a 7-byte chunk overflows while small valid bodies
// (2 to 3 bytes) stay under the cap.
const { readBody, readRawBody } = make(5);

// A fresh mock request: an EventEmitter with a no-op destroy (the size guard
// calls req.destroy() before rejecting). Call the lifted reader FIRST so its
// data/end/error listeners are registered, THEN emit synchronously.
function mockReq() {
  const req = new EventEmitter();
  req.destroy = () => {};
  return req;
}

describe('server/index.js readBody/readRawBody source-lift (shape)', () => {
  it('lifts both real functions and references the real MAX_BODY_SIZE constant', () => {
    assert.match(readBodySrc, /^function readBody\(req\) \{/m);
    assert.match(readRawBodySrc, /^function readRawBody\(req\) \{/m);
    assert.ok(src.match(/MAX_BODY_SIZE/), 'server/index.js must reference MAX_BODY_SIZE');
  });

  it('pins the real size-guard, JSON parse, and raw-resolve bytes', () => {
    assert.match(
      readBodySrc,
      /if \(size > MAX_BODY_SIZE\) \{ req\.destroy\(\); return reject\(new Error\('Body too large'\)\); \}/,
    );
    assert.match(readBodySrc, /resolve\(JSON\.parse\(Buffer\.concat\(chunks\)\.toString\(\)\)\);/);
    assert.match(readBodySrc, /catch \{ reject\(new Error\('Invalid JSON'\)\); \}/);
    assert.match(
      readRawBodySrc,
      /if \(size > MAX_BODY_SIZE\) \{ req\.destroy\(\); return reject\(new Error\('Body too large'\)\); \}/,
    );
    assert.match(readRawBodySrc, /resolve\(Buffer\.concat\(chunks\)\)/);
  });
});

describe('server/index.js readBody() streaming branches', () => {
  it('rejects `Body too large` once a chunk pushes size past MAX_BODY_SIZE', async () => {
    const req = mockReq();
    const p = readBody(req);
    req.emit('data', Buffer.from('1234567')); // 7 bytes > injected cap of 5
    await assert.rejects(p, { message: 'Body too large' });
  });

  it('rejects `Invalid JSON` when the buffered body does not parse', async () => {
    const req = mockReq();
    const p = readBody(req);
    req.emit('data', Buffer.from('{x}'));
    req.emit('end');
    await assert.rejects(p, { message: 'Invalid JSON' });
  });

  it('resolves the parsed object for a valid JSON body', async () => {
    const req = mockReq();
    const p = readBody(req);
    req.emit('data', Buffer.from('{}'));
    req.emit('end');
    assert.deepStrictEqual(await p, {});
  });

  it('accepts a body of exactly MAX_BODY_SIZE bytes (strict guard) and resolves it', async () => {
    // 5 bytes == the injected cap. The real guard is `size > MAX_BODY_SIZE`
    // (strict), so a boundary chunk passes the guard and JSON.parse runs. This
    // makes the behavioral layer bite a `>` to `>=` off-by-one in server/index.js:142,
    // which a too-large-only case cannot distinguish.
    const req = mockReq();
    const p = readBody(req);
    req.emit('data', Buffer.from('12345')); // exactly 5 bytes, valid JSON number
    req.emit('end');
    assert.deepStrictEqual(await p, 12345);
  });
});

describe('server/index.js readRawBody() streaming branches', () => {
  it('rejects `Body too large` with the same size guard', async () => {
    const req = mockReq();
    const p = readRawBody(req);
    req.emit('data', Buffer.from('1234567'));
    await assert.rejects(p, { message: 'Body too large' });
  });

  it('resolves the raw concatenated Buffer with no JSON parse', async () => {
    const req = mockReq();
    const p = readRawBody(req);
    req.emit('data', Buffer.from('ab'));
    req.emit('end');
    const out = await p;
    assert.ok(Buffer.isBuffer(out));
    assert.equal(out.toString(), 'ab');
  });

  it('accepts a raw body of exactly MAX_BODY_SIZE bytes (strict guard)', async () => {
    // Same boundary pin for the raw reader: 5 bytes == cap passes the strict
    // `size > MAX_BODY_SIZE` guard at server/index.js:159 and resolves the raw Buffer.
    const req = mockReq();
    const p = readRawBody(req);
    req.emit('data', Buffer.from('abcde')); // exactly 5 bytes
    req.emit('end');
    const out = await p;
    assert.ok(Buffer.isBuffer(out));
    assert.equal(out.toString(), 'abcde');
  });
});
