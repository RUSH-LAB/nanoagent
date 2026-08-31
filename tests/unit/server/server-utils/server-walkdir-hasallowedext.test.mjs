import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Pins the behavior of the walkDir / flatFiles ALLOWED_EXTS closure hoist:
//   - server/index.js now declares a module-scope `function hasAllowedExt(name)` that
//     wraps the `ALLOWED_EXTS.some(ext => name.endsWith(ext))` suffix test;
//   - both walkDir (the GET /api/files content tree) and flatFiles call
//     `hasAllowedExt(entry.name)` instead of allocating a fresh arrow per entry.
// The hoist must be byte-for-byte behavior preserving: same allowed extensions,
// same `.`-prefix skipping, same recursion, same returned tree objects.
//
// walkDir / flatFiles are internal to server/index.js, which calls server.listen() at
// module load and exports nothing, so it cannot be require()'d from a unit test.
// Following tests/moon-etag-json-cachecontrol.test.mjs, we lift the exact source
// of the three top-level functions, brace-balance their bodies, and instantiate
// them with new Function while injecting a stubbed fs over an in-memory fixture
// tree. This pins the helpers' real bytes rather than a reimplementation, and
// never boots a server (matching the rest of the suite).

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

// Pin against the real allowed-extension list rather than a hard-coded copy.
const { ALLOWED_EXTS } = require('../../../../src/server/server-utils');

// Lift a top-level `function <name>` out of server/index.js by brace balancing. The
// start is the line beginning with `function <name>`; the end is the line where
// the brace depth returns to zero. Robust to indentation and nested blocks (the
// bodies hold no braces inside strings or comments). Fails loud (a failed assert
// or a SyntaxError from new Function), never silently.
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

// Lift hasAllowedExt + walkDir + flatFiles together so they share one scope (the
// two walkers reference the helper, and walkDir recurses into itself). Inject the
// three module-scope values they close over: fs, path, ALLOWED_EXTS. The walkers
// take their root as the `base` argument now, so there is no PROJECT_ROOT left
// for them to close over.
function liftWalkers(fs) {
  const src = readFileSync(path.join(REPO_ROOT, 'src/server/index.js'), 'utf-8');
  const hasAllowedExtSrc = extractFn(src, 'hasAllowedExt');
  const walkDirSrc = extractFn(src, 'walkDir');
  const flatFilesSrc = extractFn(src, 'flatFiles');
  const combined = [hasAllowedExtSrc, walkDirSrc, flatFilesSrc].join('\n\n');
  const make = new Function(
    'fs', 'path', 'ALLOWED_EXTS',
    `${combined}\nreturn { hasAllowedExt, walkDir, flatFiles };`,
  );
  return {
    hasAllowedExtSrc, walkDirSrc, flatFilesSrc,
    fns: make(fs, path, ALLOWED_EXTS),
  };
}

// In-memory fixture rooted at one organization's content tree. Covers every
// branch: allowed .md / .mdx files, a disallowed extension, an extensionless
// file, a hidden file, a hidden directory, and two levels of nested
// subdirectories.
const PROJECT_ROOT = '/fake/root';
const CONTENT = path.join(PROJECT_ROOT, 'content', 'mochi');
const SUB = path.join(CONTENT, 'sub');
const NESTED = path.join(SUB, 'nested');

const TREE = {
  [CONTENT]: [
    { name: 'a.md', dir: false },
    { name: 'b.mdx', dir: false },
    { name: 'c.txt', dir: false },        // disallowed extension
    { name: '.hidden.md', dir: false },   // hidden file
    { name: 'README', dir: false },       // no extension
    { name: 'sub', dir: true },
    { name: '.git', dir: true },          // hidden directory
  ],
  [SUB]: [
    { name: 'd.md', dir: false },
    { name: 'e.json', dir: false },       // disallowed extension
    { name: 'nested', dir: true },
  ],
  [NESTED]: [
    { name: 'f.mdx', dir: false },
  ],
};

// statSync is only reached for entries that pass the extension filter.
const STATS = {
  [path.join(CONTENT, 'a.md')]: { mtimeMs: 111, size: 11 },
  [path.join(CONTENT, 'b.mdx')]: { mtimeMs: 222, size: 22 },
  [path.join(SUB, 'd.md')]: { mtimeMs: 333, size: 33 },
  [path.join(NESTED, 'f.mdx')]: { mtimeMs: 444, size: 44 },
};

function makeFakeFs() {
  return {
    readdirSync(dir, opts) {
      assert.deepEqual(opts, { withFileTypes: true }, 'readdirSync must request Dirents');
      const entries = TREE[dir];
      assert.ok(entries, `unexpected readdirSync path: ${dir}`);
      return entries.map(e => ({ name: e.name, isDirectory: () => e.dir }));
    },
    statSync(p) {
      const s = STATS[p];
      assert.ok(s, `unexpected statSync path: ${p}`);
      return { mtimeMs: s.mtimeMs, size: s.size };
    },
  };
}

describe('server/index.js hasAllowedExt hoist (source shape)', () => {
  const { hasAllowedExtSrc, walkDirSrc, flatFilesSrc } = liftWalkers(makeFakeFs());

  it('declares a module-scope helper with the exact suffix predicate', () => {
    assert.match(hasAllowedExtSrc, /^function hasAllowedExt\(name\) \{/m);
    assert.match(hasAllowedExtSrc, /return ALLOWED_EXTS\.some\(ext => name\.endsWith\(ext\)\);/);
  });

  it('routes both walkers through hasAllowedExt(entry.name)', () => {
    assert.ok(walkDirSrc.includes('hasAllowedExt(entry.name)'), 'walkDir must call the helper');
    assert.ok(flatFilesSrc.includes('hasAllowedExt(entry.name)'), 'flatFiles must call the helper');
  });

  it('leaves no inline per-entry ALLOWED_EXTS closure behind', () => {
    assert.ok(!walkDirSrc.includes('ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))'),
      'walkDir must not keep the inline closure');
    assert.ok(!flatFilesSrc.includes('ALLOWED_EXTS.some(ext => entry.name.endsWith(ext))'),
      'flatFiles must not keep the inline closure');
  });
});

describe('server/index.js walkDir / flatFiles behavior over a fixture', () => {
  const { fns } = liftWalkers(makeFakeFs());
  const { hasAllowedExt, walkDir, flatFiles } = fns;

  it('hasAllowedExt accepts only the allowed extensions', () => {
    assert.equal(hasAllowedExt('a.md'), true);
    assert.equal(hasAllowedExt('b.mdx'), true);
    assert.equal(hasAllowedExt('c.txt'), false);
    assert.equal(hasAllowedExt('README'), false);
    assert.equal(hasAllowedExt('weird.md.bak'), false);
  });

  // Every path is relative to `base`, which defaults to the directory being
  // walked. Called on the caller's content root, as GET /api/files calls it,
  // that makes the wire paths `books/math/0-intro.md` with no organization in
  // them: a request has nowhere to name another workspace's tree.
  it('walkDir returns the nested tree with only allowed files, skipping dotfiles', () => {
    assert.deepEqual(walkDir(CONTENT), [
      { name: 'a.md', path: 'a.md', type: 'file', mtime: 111, size: 11 },
      { name: 'b.mdx', path: 'b.mdx', type: 'file', mtime: 222, size: 22 },
      {
        name: 'sub', path: 'sub', type: 'directory', children: [
          { name: 'd.md', path: 'sub/d.md', type: 'file', mtime: 333, size: 33 },
          {
            name: 'nested', path: 'sub/nested', type: 'directory', children: [
              { name: 'f.mdx', path: 'sub/nested/f.mdx', type: 'file', mtime: 444, size: 44 },
            ],
          },
        ],
      },
    ]);
  });

  it('flatFiles returns every allowed file flattened in depth-first order', () => {
    assert.deepEqual(flatFiles(CONTENT), [
      { name: 'a.md', path: 'a.md' },
      { name: 'b.mdx', path: 'b.mdx' },
      { name: 'd.md', path: 'sub/d.md' },
      { name: 'f.mdx', path: 'sub/nested/f.mdx' },
    ]);
  });

  // A subdirectory listing keeps reporting against the content root rather than
  // against the subdirectory, which is the whole reason `base` is a separate
  // argument: recursion passes it down unchanged, so `sub/nested/f.mdx` reads
  // the same whether the walk started at the root or one level in.
  it('walkDir and flatFiles report paths relative to an explicit base', () => {
    assert.deepEqual(walkDir(SUB, CONTENT), [
      { name: 'd.md', path: 'sub/d.md', type: 'file', mtime: 333, size: 33 },
      {
        name: 'nested', path: 'sub/nested', type: 'directory', children: [
          { name: 'f.mdx', path: 'sub/nested/f.mdx', type: 'file', mtime: 444, size: 44 },
        ],
      },
    ]);
    assert.deepEqual(flatFiles(SUB, CONTENT), [
      { name: 'd.md', path: 'sub/d.md' },
      { name: 'f.mdx', path: 'sub/nested/f.mdx' },
    ]);
    // Without a base, the same walk is relative to the subdirectory itself.
    assert.deepEqual(flatFiles(SUB), [
      { name: 'd.md', path: 'd.md' },
      { name: 'f.mdx', path: 'nested/f.mdx' },
    ]);
  });

  it('omits disallowed extensions, extensionless files, and hidden entries', () => {
    const flatNames = flatFiles(CONTENT).map(f => f.name);
    for (const skipped of ['c.txt', 'e.json', 'README', '.hidden.md', '.git']) {
      assert.ok(!flatNames.includes(skipped), `${skipped} must be excluded`);
    }
  });
});
