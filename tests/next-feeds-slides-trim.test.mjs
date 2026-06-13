import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// feeds.js is CommonJS; load it the way the sibling slides suite
// (next-feeds-slides-cache) does and reuse its ctx-mocking shape. These tests
// drive the REAL `GET /api/file/slides` handler over in-memory fixtures and pin
// the `{title, slides:[{index,content}], totalSlides}` payload against goldens
// captured from the live handler. The handler builds `slides` by trimming each
// split chunk ONCE (map-then-filter) instead of twice (filter-then-map); the
// transform is algebraically identical, so the goldens below are byte-identical
// to the prior double-trim output. No network and no server.
const require = createRequire(import.meta.url);
const SRC = path.resolve(fileURLToPath(import.meta.url), '../../server/routes/feeds.js');
const routes = require(SRC);

const PROJECT_ROOT = '/proj';

// In-memory fs stub keyed by absolute path. The slides handler reads exactly one
// file with readFileSync(path.join(PROJECT_ROOT, filePath)); a missing file
// throws ENOENT so the 404 path can be exercised.
function makeFs(fileMap) {
  const fileContents = new Map();
  for (const [rel, content] of Object.entries(fileMap)) {
    fileContents.set(path.join(PROJECT_ROOT, rel), content);
  }
  return {
    readFileSync(fp) {
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server.js
// helper: run fn and store on a miss, return the stored value on a hit.
function makeCached() {
  const store = new Map();
  return (key, ttl, fn) => {
    if (store.has(key)) return store.get(key);
    const val = fn();
    store.set(key, val);
    return val;
  };
}

// Invoke the file-slides handler with a mocked ctx and capture the response
// handed to `json(res, status, payload)`.
async function invoke(fileMap, rel) {
  const pathname = '/api/file/slides';
  const url = new URL(`http://localhost${pathname}?path=${rel}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs: makeFs(fileMap),
    path,
    PROJECT_ROOT,
    isValidFilePath: () => true,
    cached: makeCached(),
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// deck.md exercises the `\n---\n` separator: a whitespace-only chunk
// ("  \n\t  ", spaces/newline/tab) must be DROPPED, a bare "0" must be KEPT, and
// a spaced " 0 " must trim to "0" and be KEPT, proving the single trim still
// runs and that a falsy-looking-but-truthy "0" survives the `.filter(s => s)`.
const DECK = {
  'content/deck.md': '---\ntitle: My Deck\n---\nSlide one body\n---\n  \n\t  \n---\n0\n---\n 0 \n---\nSlide last\n',
};
const EXPECTED_DECK = {
  title: 'My Deck',
  slides: [
    { index: 0, content: 'Slide one body' },
    { index: 1, content: '0' },
    { index: 2, content: '0' },
    { index: 3, content: 'Slide last' },
  ],
  totalSlides: 4,
};

// talk.md exercises the `## ` heading lookahead: the body opens with text, so the
// split keeps each heading with its section and yields three slides.
const TALK = {
  'content/talk.md': '---\ntitle: Talk\n---\nOpening line\n\n## First\n\nbody one\n\n## Second\n\nbody two\n',
};
const EXPECTED_TALK = {
  title: 'Talk',
  slides: [
    { index: 0, content: 'Opening line' },
    { index: 1, content: '## First\n\nbody one' },
    { index: 2, content: '## Second\n\nbody two' },
  ],
  totalSlides: 3,
};

// talk2.md begins with `\n## `, so the zero-width split at index 0 produces a
// leading empty chunk that must be DROPPED in the heading branch too.
const TALK2 = {
  'content/talk2.md': '---\ntitle: Headings Only\n---\n\n## Alpha\n\naaa\n\n## Beta\n\nbbb\n',
};
const EXPECTED_TALK2 = {
  title: 'Headings Only',
  slides: [
    { index: 0, content: '## Alpha\n\naaa' },
    { index: 1, content: '## Beta\n\nbbb' },
  ],
  totalSlides: 2,
};

describe('GET /api/file/slides trims each slide chunk once (map-then-filter)', () => {
  it('splits on \\n---\\n: drops whitespace-only chunks and keeps "0" (bare and spaced)', async () => {
    const res = await invoke(DECK, 'content/deck.md');
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_DECK);
    // Byte-identity: same fields, same order, same serialization as the prior
    // double-trim chain produced.
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_DECK));
  });

  it('splits on `## ` headings, keeping each heading with its section', async () => {
    const res = await invoke(TALK, 'content/talk.md');
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_TALK);
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_TALK));
  });

  it('drops the leading empty chunk when the body starts with `\\n## `', async () => {
    const res = await invoke(TALK2, 'content/talk2.md');
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_TALK2);
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_TALK2));
  });
});

describe('GET /api/file/slides source uses the single-trim chain', () => {
  const source = readFileSync(SRC, 'utf-8');

  it('contains the single-trim map-then-filter chain', () => {
    assert.ok(
      source.includes('.map(s => s.trim()).filter(s => s)'),
      'feeds.js must build slides with .map(s => s.trim()).filter(s => s)',
    );
  });

  it('no longer contains the old double-trim filter-then-map chain', () => {
    assert.ok(
      !source.includes('.filter(s => s.trim()).map(s => s.trim())'),
      'the old double-trim .filter(s => s.trim()).map(s => s.trim()) chain must be gone',
    );
  });
});

describe('single-trim is behavior-preserving (old double-trim === new single-trim)', () => {
  // The refactor is safe because String.prototype.trim() is pure and idempotent:
  // a chunk survives iff its trimmed form is non-empty, and the surviving value is
  // that trimmed string, in the same order, in both forms. "" is the only falsy
  // string, so both forms drop exactly the chunks whose trim is empty. This lemma
  // pins that identity across representative chunk arrays, including the tricky
  // truthy-string "0".
  const OLD = arr => arr.filter(s => s.trim()).map(s => s.trim());
  const NEW = arr => arr.map(s => s.trim()).filter(s => s);
  const SAMPLES = [
    ['Slide one body', '  \n\t  ', '0', ' 0 ', 'Slide last\n'],
    ['', '\n## Alpha\n\naaa\n', '\n## Beta\n\nbbb\n'],
    ['', '   ', '\t', '\n', '0', ' 0 ', '00', '0 0', 'false', 'null', ' x '],
    [],
    [''],
    ['   '],
  ];

  for (const sample of SAMPLES) {
    it(`agrees for ${JSON.stringify(sample)}`, () => {
      assert.deepEqual(NEW(sample), OLD(sample));
    });
  }
});
