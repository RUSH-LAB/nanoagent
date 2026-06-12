import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load it the way the other route tests do. This
// suite guards the hoist + dedup of the /api/trash trashed-name regexes to the
// module-scope consts TRASH_NAME_RE / TRASH_TIME_TAIL_RE / TRASH_TIME_MID_RE. It
// proves four things:
//   1. each const is a non-global, non-sticky RegExp whose .source/.flags equal a
//      canonical inline literal byte for byte (no widened or narrowed hoist);
//   2. the consts are referentially stable across two require()s (one shared
//      instance per pattern, built once at module load);
//   3. the REAL GET /api/trash and POST /api/trash/restore handlers still parse the
//      originalName and ISO-format the deletedAt exactly as before, over a temp
//      .trash/ dir, and a non-matching name is skipped / rejected;
//   4. the source hoists each const once, exports it once, and references the shared
//      TRASH_NAME_RE at both former call sites with no inline literal left behind.
const require = createRequire(import.meta.url);
const SPECIFIER = '../server/routes/graph-trash-files.js';
const graphRoutes = require(SPECIFIER);

// The canonical inline literals the handlers carried before the hoist. Each shared
// const must equal these byte for byte (source + flags), so a widened or narrowed
// hoist is caught.
const CANONICAL = {
  TRASH_NAME_RE: /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)$/,
  TRASH_TIME_TAIL_RE: /(\d{2})-(\d{2})-(\d{3})Z$/,
  TRASH_TIME_MID_RE: /T(\d{2})-(\d{2})/,
};
const NAMES = Object.keys(CANONICAL);

// Temp PROJECT_ROOTs created during the run, removed in after().
const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

// Create a fresh temp PROJECT_ROOT, write each [relPath, body] entry under .trash/,
// and return the root path. relPath may include subdirectories.
function makeTrashDir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trashname-hoist-'));
  roots.push(root);
  for (const [rel, body] of files) {
    const full = path.join(root, '.trash', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }
  return root;
}

// Drive the real GET /api/trash handler over a temp root; capture json().
async function listTrash(root) {
  let captured = null;
  const res = { writableEnded: false };
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    TRASH_DIR: path.join(root, '.trash'),
    json: (_res, status, body) => { captured = { status, body }; res.writableEnded = true; },
  };
  const url = new URL('http://localhost/api/trash');
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await graphRoutes(req, res, url, '/api/trash', ctx);
  return captured;
}

// Drive the real POST /api/trash/restore handler over a temp root; capture json()
// plus the invalidateCache keys it emits.
async function restore(root, trashPath, { isValidFilePath = () => true, rateLimitOk = true } = {}) {
  let captured = null;
  const res = { writableEnded: false };
  const invalidated = [];
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    TRASH_DIR: path.join(root, '.trash'),
    rateLimit: () => rateLimitOk,
    readBody: async () => ({ trashPath }),
    isValidFilePath,
    invalidateCache: (k) => invalidated.push(k),
    json: (_res, status, body) => { captured = { status, body }; res.writableEnded = true; },
  };
  const url = new URL('http://localhost/api/trash/restore');
  const req = { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await graphRoutes(req, res, url, '/api/trash/restore', ctx);
  return { status: captured.status, body: captured.body, invalidated };
}

describe('TRASH_NAME_RE / TRASH_TIME_TAIL_RE / TRASH_TIME_MID_RE hoisted to module scope', () => {
  it('exports each as a non-global, non-sticky RegExp with the canonical source/flags', () => {
    for (const name of NAMES) {
      const re = graphRoutes[name];
      assert.ok(re instanceof RegExp, `${name} is a RegExp`);
      assert.equal(re.source, CANONICAL[name].source, `${name}.source`);
      assert.equal(re.flags, CANONICAL[name].flags, `${name}.flags`);
      assert.equal(re.flags, '', `${name} carries no flags`);
      assert.equal(re.global, false, `${name}.global`);
      assert.equal(re.sticky, false, `${name}.sticky`);
    }
  });

  it('is referentially stable across two requires (single shared instance per const)', () => {
    const second = require(SPECIFIER);
    for (const name of NAMES) {
      assert.strictEqual(second[name], graphRoutes[name], `${name} stable across requires`);
    }
  });

  it('parses the timestamp + original name and formats deletedAt via the shared instances', () => {
    const m = '2024-01-02T03-04-05-678Z_original-note.md'.match(graphRoutes.TRASH_NAME_RE);
    assert.equal(m[1], '2024-01-02T03-04-05-678Z');
    assert.equal(m[2], 'original-note.md');
    assert.equal('plain-name.md'.match(graphRoutes.TRASH_NAME_RE), null);
    // The exact deletedAt formatting chain the GET handler applies (note: the source
    // joins milliseconds with a colon, not a dot, this pins that behavior verbatim).
    const deletedAt = m[1]
      .replace(graphRoutes.TRASH_TIME_TAIL_RE, '$1:$2:$3Z')
      .replace(graphRoutes.TRASH_TIME_MID_RE, 'T$1:$2');
    assert.equal(deletedAt, '2024-01-02T03:04:05:678Z');
  });
});

describe('GET /api/trash — parses originalName + ISO deletedAt via the shared consts', () => {
  it('returns the parsed name and formatted timestamp for each trashed file, newest first', async () => {
    const root = makeTrashDir([
      ['2024-01-02T03-04-05-678Z_original-note.md', 'older trashed note'],
      [path.join('content', '2026-12-31T23-59-59-000Z_sub-note.mdx'), 'newer trashed note in a subdir'],
      ['not-a-trash-file.md', 'no timestamp prefix, must be skipped'],
    ]);
    const { status, body } = await listTrash(root);
    assert.equal(status, 200);
    // The non-matching name is skipped: only the two timestamped files remain.
    assert.equal(body.files.length, 2);
    const byName = Object.fromEntries(body.files.map(f => [f.originalName, f]));

    assert.deepEqual(byName['original-note.md'], {
      trashPath: path.join('.trash', '2024-01-02T03-04-05-678Z_original-note.md'),
      originalPath: 'original-note.md',
      originalName: 'original-note.md',
      deletedAt: '2024-01-02T03:04:05:678Z',
    });
    assert.deepEqual(byName['sub-note.mdx'], {
      trashPath: path.join('.trash', 'content', '2026-12-31T23-59-59-000Z_sub-note.mdx'),
      originalPath: path.join('content', 'sub-note.mdx'),
      originalName: 'sub-note.mdx',
      deletedAt: '2026-12-31T23:59:59:000Z',
    });
    // Sorted newest-first by deletedAt (descending localeCompare).
    assert.equal(body.files[0].originalName, 'sub-note.mdx');
    assert.equal(body.files[1].originalName, 'original-note.md');
  });

  it('returns an empty list when the trash dir is absent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trashname-empty-'));
    roots.push(root);
    const { status, body } = await listTrash(root);
    assert.equal(status, 200);
    assert.deepEqual(body, { files: [] });
  });

  it('returns identical results on a back-to-back request (shared consts carry no state)', async () => {
    const root = makeTrashDir([
      ['2024-01-02T03-04-05-678Z_original-note.md', 'note'],
      [path.join('content', '2026-12-31T23-59-59-000Z_sub-note.mdx'), 'note'],
    ]);
    const first = await listTrash(root);
    const second = await listTrash(root);
    assert.equal(first.status, 200);
    assert.deepEqual(second.body, first.body);
  });
});

describe('POST /api/trash/restore — parses originalName via the same shared TRASH_NAME_RE', () => {
  it('restores a trashed file to its original path using the parsed name', async () => {
    const trashRel = path.join('content', '2024-01-02T03-04-05-678Z_restore-me.md');
    const root = makeTrashDir([[trashRel, 'restore me']]);
    const { status, body, invalidated } = await restore(root, path.join('.trash', trashRel));
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.restoredPath, path.join('content', 'restore-me.md'));
    // The file moved out of trash and into the parsed original path.
    assert.ok(fs.existsSync(path.join(root, 'content', 'restore-me.md')), 'restored to original path');
    assert.ok(!fs.existsSync(path.join(root, '.trash', trashRel)), 'removed from trash');
    // A restore is the inverse of a delete: it drops both cached lists.
    assert.deepEqual(invalidated, ['search', 'stats']);
  });

  it('rejects a trashed name that does not match the timestamp pattern (same parser as GET)', async () => {
    const root = makeTrashDir([['not-a-valid-name.md', 'x']]);
    const { status, body } = await restore(root, path.join('.trash', 'not-a-valid-name.md'));
    assert.equal(status, 400);
    assert.equal(body.error, 'Invalid trash file format');
  });
});

describe('source structure — trash regexes hoisted once, name literal deduped', () => {
  const SRC = fs.readFileSync(new URL('../server/routes/graph-trash-files.js', import.meta.url), 'utf-8');
  const count = (hay, needle) => hay.split(needle).length - 1;

  it('defines and exports each trash const exactly once at module scope', () => {
    for (const name of NAMES) {
      assert.equal(count(SRC, `\nconst ${name} = `), 1, `${name} defined once`);
      assert.equal(count(SRC, `\nmodule.exports.${name} = ${name};`), 1, `${name} exported once`);
    }
  });

  it('pins the canonical const definitions byte for byte', () => {
    assert.ok(SRC.includes(String.raw`const TRASH_NAME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)$/;`));
    assert.ok(SRC.includes(String.raw`const TRASH_TIME_TAIL_RE = /(\d{2})-(\d{2})-(\d{3})Z$/;`));
    assert.ok(SRC.includes(String.raw`const TRASH_TIME_MID_RE = /T(\d{2})-(\d{2})/;`));
  });

  it('references the shared TRASH_NAME_RE at both former call sites and leaves no inline literal', () => {
    assert.equal(count(SRC, '.match(TRASH_NAME_RE)'), 2, 'both call sites share the const');
    // The deduped timestamp literal no longer appears at a .match() call site.
    assert.equal(count(SRC, String.raw`.match(/^(\d{4}`), 0, 'no inline timestamp literal at a call site');
  });

  it('references the shared time-format consts at the deletedAt replace chain', () => {
    assert.ok(SRC.includes(`.replace(TRASH_TIME_TAIL_RE, '$1:$2:$3Z')`));
    assert.ok(SRC.includes(`.replace(TRASH_TIME_MID_RE, 'T$1:$2')`));
    // The inline replace literals are gone.
    assert.equal(count(SRC, String.raw`.replace(/(\d{2})-(\d{2})-(\d{3})Z$/`), 0);
    assert.equal(count(SRC, String.raw`.replace(/T(\d{2})-(\d{2})/`), 0);
  });

  it('leaves the unrelated export/render regexes untouched', () => {
    assert.ok(SRC.includes(String.raw`const EXPORT_FM_RE = /^---\n([\s\S]*?)\n---\n?/;`));
    assert.ok(SRC.includes('const RENDER_H2_RE = /^## (.+)$/gm;'));
    assert.ok(SRC.includes('const SLIDES_H2_RE = /^## (.+)$/m;'));
  });
});
