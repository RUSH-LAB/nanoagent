import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Pins the key-cap eviction branch of the in-memory rate limiter in server/index.js:
//   function rateLimit(key, maxPerMinute) keeps a timestamp array per key, drops
//   timestamps older than 60000 ms, and returns false once a key already holds
//   maxPerMinute recent hits. Once the number of TRACKED keys reaches
//   MAX_RATE_LIMIT_KEYS (10000) it runs a two stage eviction: first it deletes
//   every key whose timestamp array is empty; if the key count is still at the
//   cap it drops the oldest half, ranked by each key's minimum timestamp. Then it
//   pushes `now` onto the current key's array and returns true.
//
// The rest of the suite drives route handlers and never reaches this cap, so the
// eviction block (server/index.js:231 through 247) is otherwise uncovered. This
// add only characterization test pins those exact bytes.
//
// server/index.js calls server.listen() at module load and exports nothing, so it
// cannot be require()'d from a unit test. Following
// tests/next-server-cached-invalidatecache.test.mjs and
// tests/next-perfcleanup-arr.test.mjs, we lift the exact source of rateLimit,
// brace balance its body, and instantiate it with new Function while injecting a
// fresh store and a SMALL cap, so the eviction branch is exercised cheaply
// without seeding ten thousand keys. This pins the real bytes rather than a
// reimplementation, and never boots a server. The body holds no braces inside
// strings or comments, so plain brace counting is exact.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

// Lift a top level `function <name>` out of server/index.js by brace balancing. The
// start is the line beginning with `function <name>`; the end is the line where
// the brace depth returns to zero. Fails loud (a failed assert or a SyntaxError
// from new Function), never silently. Mirrors the sibling source lift tests.
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

// Read the real server/index.js once, lift rateLimit, and pin the cap constant from
// source (not a hard coded copy). make(store, cap) binds rateLimit to the
// supplied store object and cap, so every test gets an isolated, fresh store and
// can exercise the eviction with a tiny cap.
const src = readFileSync(path.join(REPO_ROOT, 'src/server/index.js'), 'utf-8');
const rateLimitSrc = extractFn(src, 'rateLimit');
const capMatch = src.match(/^const MAX_RATE_LIMIT_KEYS = (\d+);/m);
assert.ok(capMatch, 'server/index.js must declare `const MAX_RATE_LIMIT_KEYS = <n>;`');
const MAX_RATE_LIMIT_KEYS = Number(capMatch[1]);
const make = new Function(
  'rateLimits', 'MAX_RATE_LIMIT_KEYS',
  `${rateLimitSrc}\nreturn { rateLimit };`,
);

describe('server/index.js rateLimit source lift (shape)', () => {
  it('lifts the real function and the eviction cap (MAX_RATE_LIMIT_KEYS === 10000)', () => {
    assert.match(rateLimitSrc, /^function rateLimit\(key, maxPerMinute\) \{/m);
    assert.equal(MAX_RATE_LIMIT_KEYS, 10000);
  });

  it('pins the real two stage eviction bytes', () => {
    assert.match(rateLimitSrc, /if \(keys\.length >= MAX_RATE_LIMIT_KEYS\) \{/);
    assert.ok(
      rateLimitSrc.includes('if (rateLimits[k].length === 0) delete rateLimits[k];'),
      'rateLimit() must keep the empty-key sweep',
    );
    assert.match(rateLimitSrc, /Math\.floor\(remaining\.length \/ 2\)/);
  });
});

describe('server/index.js rateLimit key-cap eviction behavior', () => {
  it('oldest-half drop: keeps the current key plus the newest others, drops the oldest half', () => {
    const t = Date.now();
    // Four keys at a cap of four, none empty: the empty sweep clears nothing, so
    // the oldest-half branch drops Math.floor(4 / 2) = 2 keys, ranked by each
    // key's minimum timestamp. b and c (the two oldest) go; a survives, and cur
    // (the key being recorded) is kept then has `now` pushed onto it.
    const store = { cur: [t - 10], a: [t - 100], b: [t - 200], c: [t - 300] };
    const { rateLimit } = make(store, 4);
    assert.equal(rateLimit('cur', 10), true);
    assert.deepStrictEqual(Object.keys(store).sort(), ['a', 'cur']);
    assert.equal(store.cur.length, 2, 'cur kept its recent hit and pushed now');
  });

  it('empty-key sweep alone clears the cap, so the oldest-half branch is skipped', () => {
    const t = Date.now();
    // Four keys at a cap of four, but three are empty: the sweep removes
    // e1/e2/e3, the key count falls below the cap, and the oldest-half branch is
    // never reached. Only cur remains, and the call still records a hit.
    const store = { cur: [t - 10], e1: [], e2: [], e3: [] };
    const { rateLimit } = make(store, 4);
    assert.equal(rateLimit('cur', 10), true);
    assert.deepStrictEqual(Object.keys(store).sort(), ['cur']);
  });

  it('latent edge: a new key removed by its own empty sweep makes the final push throw', () => {
    const t = Date.now();
    // The new key d is initialised to [], counted toward the cap (4 keys >= 3),
    // then deleted by the empty sweep alongside a and b (c, holding one
    // timestamp, survives). The trailing rateLimits[key].push(now) then
    // dereferences the just-deleted key and throws a TypeError.
    const store = { a: [], b: [], c: [t] };
    const { rateLimit } = make(store, 3);
    assert.throws(() => rateLimit('d', 10), TypeError);
  });
});
