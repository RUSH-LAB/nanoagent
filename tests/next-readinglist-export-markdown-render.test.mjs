import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load the REAL route module the way the
// sibling reading-list tests do, so these cases drive the shipped export handler
// rather than a reimplementation.
const require = createRequire(import.meta.url);
const readingListRoutes = require('../server/routes/bookmarks-reading-lists.js');

// This file characterizes the markdown (default format) branch of
//   GET /api/reading-lists/:id/export
// matched by READING_LIST_EXPORT_RE. That branch reads the list from loadJSON and
// writes a deterministic markdown document straight to res.writeHead and res.end
// (it never calls ctx.json on success), so a res stub captures the status, the
// headers, and the body. The not-found guard fires first and answers 404 through
// ctx.json. Nothing here reads a clock, randomness, or the network, so every
// asserted byte is fixed. The bibtex branch (format === 'bibtex') is intentionally
// left alone; it reads the bibliography and is pinned by its own sibling tests.

const READING_LISTS_FILE = '/fake/reading-lists.json';
const CORS_ORIGIN = 'https://example.test';

// Drive one GET export request over a mocked ctx and report what the handler
// captured. `format` is omitted by default, so url.searchParams.get('format')
// returns null and the handler falls back to 'md' (the markdown branch). loadJSON
// answers only for the reading lists file, so any stray read surfaces loudly.
async function runExport({ lists, id, format } = {}) {
  const out = {};
  const ctx = {
    READING_LISTS_FILE,
    CORS_ORIGIN,
    loadJSON: (fp) => {
      if (fp === READING_LISTS_FILE) return { lists };
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    // The markdown branch never calls json on success; only the 404 guard does.
    json: (_res, status, payload) => { out.status = status; out.json = payload; out.viaJson = true; },
  };
  const pathname = `/api/reading-lists/${id}/export`;
  const query = format === undefined ? '' : `?format=${encodeURIComponent(format)}`;
  const url = new URL(`http://localhost${pathname}${query}`);
  const res = {
    writableEnded: false,
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    end(body) { out.body = body; this.writableEnded = true; },
  };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await readingListRoutes(req, res, url, pathname, ctx);
  return out;
}

describe('GET /api/reading-lists/:id/export markdown default branch (current behavior)', () => {
  it('numbers each item, tags references [Paper] and everything else [Doc], and falls back to path when title is absent', async () => {
    const list = {
      id: 'list-1',
      name: 'My Reading List',
      items: [
        { path: 'papers/transformer', title: 'Attention Is All You Need', type: 'reference' },
        { path: 'docs/getting-started', title: 'Getting Started', type: 'doc' },
        { path: 'docs/fallback-path', type: 'guide' },
      ],
    };
    const out = await runExport({ lists: [list], id: 'list-1' });

    // item[2] has no title, so the render falls back to its path; its type is
    // 'guide', which is not 'reference', so it is tagged [Doc].
    const expected =
`# My Reading List

1. [Paper] Attention Is All You Need
2. [Doc] Getting Started
3. [Doc] docs/fallback-path
`;
    assert.equal(out.status, 200);
    assert.equal(out.body, expected);
    assert.equal(out.headers['Content-Type'], 'text/markdown; charset=utf-8');
    assert.equal(out.headers['Content-Disposition'], 'attachment; filename="My_Reading_List.md"');
    assert.equal(out.headers['Access-Control-Allow-Origin'], CORS_ORIGIN);
    // A successful render goes through res.end, never ctx.json.
    assert.notEqual(out.viaJson, true);
  });

  it('prepends the description block when the list carries a description', async () => {
    const list = {
      id: 'list-2',
      name: 'Described',
      description: 'A short description.',
      items: [
        { path: 'papers/p1', title: 'Paper One', type: 'reference' },
      ],
    };
    const out = await runExport({ lists: [list], id: 'list-2' });

    const expected =
`# Described

A short description.

1. [Paper] Paper One
`;
    assert.equal(out.status, 200);
    assert.equal(out.body, expected);
    assert.equal(out.headers['Content-Type'], 'text/markdown; charset=utf-8');
  });

  it('renders the empty placeholder for a list with an empty items array', async () => {
    const list = { id: 'list-empty', name: 'Empty List', items: [] };
    const out = await runExport({ lists: [list], id: 'list-empty' });

    const expected =
`# Empty List

_No items in this list._
`;
    assert.equal(out.status, 200);
    assert.equal(out.body, expected);
    assert.equal(out.headers['Content-Type'], 'text/markdown; charset=utf-8');
  });

  it('renders the empty placeholder when the list has no items key at all', async () => {
    // `list.items && list.items.length > 0` is falsy when items is undefined, so
    // the else branch fires exactly as it does for an empty array.
    const list = { id: 'no-items-key', name: 'No Items Key' };
    const out = await runExport({ lists: [list], id: 'no-items-key' });

    const expected =
`# No Items Key

_No items in this list._
`;
    assert.equal(out.status, 200);
    assert.equal(out.body, expected);
    assert.equal(out.headers['Content-Type'], 'text/markdown; charset=utf-8');
  });

  it('treats any non-bibtex format value as the markdown default', async () => {
    // The branch guard is `format === 'bibtex'`; any other value (here 'json')
    // falls through to the markdown render.
    const list = {
      id: 'list-fmt',
      name: 'Format Probe',
      items: [{ path: 'docs/only', title: 'Only Item', type: 'doc' }],
    };
    const out = await runExport({ lists: [list], id: 'list-fmt', format: 'json' });

    const expected =
`# Format Probe

1. [Doc] Only Item
`;
    assert.equal(out.status, 200);
    assert.equal(out.body, expected);
    assert.equal(out.headers['Content-Type'], 'text/markdown; charset=utf-8');
  });

  it('answers 404 Reading list not found through ctx.json for an unknown id', async () => {
    const out = await runExport({
      lists: [{ id: 'present', name: 'Present', items: [] }],
      id: 'missing',
    });
    assert.equal(out.status, 404);
    assert.deepEqual(out.json, { error: 'Reading list not found' });
    // The not-found guard returns before any markdown is written.
    assert.equal(out.body, undefined);
    assert.equal(out.viaJson, true);
  });
});
