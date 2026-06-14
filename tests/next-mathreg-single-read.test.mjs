import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// docusaurus-plugin-math-registry.js is CommonJS; load the REAL module the way the
// sibling plugin suites do. This is a METRIC test: it pins the read COUNT, proving
// each content file is read from disk exactly once per loadContent() run.
//
// Background: the plugin used to read every non-index file twice per build, once in
// getFilePosition (frontmatter sidebar_position for sorting) and again in loadContent
// (the TAG_RE scan). getFilePosition now carries the raw text it already read through
// readSortedItems and buildHierarchy, so loadContent reuses it instead of re-reading.
// Index files are never seen by getFilePosition, so they were already read just once
// and must stay read just once.
//
// The gate: spy on fs.readFileSync (the plugin's require('fs') resolves to the same
// singleton this ESM default import exposes), run loadContent once over a fixture,
// and count reads per path. On the old double-read source every non-index file was
// read twice, so the "exactly once" assertions are RED until the single-read change
// lands; the existing math-registry suites cover that the manifest is unchanged.
const require = createRequire(import.meta.url);
const mathRegistryPlugin = require('../plugins/docusaurus-plugin-math-registry.js');

// Write a file, creating its parent directory first (mirrors the sibling suites).
function writeFile(root, rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
}

// One chapter folder "01-sec" (route base "math") holds three content files:
//   index.md   folder page, <Theorem id="idx">  : read just once, by loadContent
//   1-foo.md   sidebar_position 1, <Theorem>     : read in getFilePosition, reused after
//   2-bar.md   sidebar_position 2, <Theorem>     : read in getFilePosition, reused after
// Sorted by sidebar_position the children are foo then bar, and the single top-level
// folder is chapter 1, so the three theorem-like tags number 1.1, 1.2, 1.3 in the
// order index, foo, bar (the folder index is registered before its children).
const INDEX_MD = '---\ntitle: Sec\n---\n\n# Sec\n\n<Theorem id="idx">root</Theorem>\n';
const FOO_MD = '---\ntitle: Foo\nsidebar_position: 1\n---\n\n# Foo\n\n<Theorem id="foo">a</Theorem>\n';
const BAR_MD = '---\ntitle: Bar\nsidebar_position: 2\n---\n\n# Bar\n\n<Theorem id="bar">b</Theorem>\n';

// Hand traced from the real engine: every entry is { type, number, page }. The
// single read must scan the same bytes, so this manifest is byte-for-byte what the
// old double-read engine produced.
const EXPECTED_MANIFEST = {
  idx: { type: 'Theorem', number: '1.1', page: '/math/sec' },
  foo: { type: 'Theorem', number: '1.2', page: '/math/sec/foo' },
  bar: { type: 'Theorem', number: '1.3', page: '/math/sec/bar' },
};

describe('math-registry reads each content file exactly once per build', () => {
  let root;
  let mathRoot;
  let mdPaths; // logical name : absolute path of each fixture .md file
  let reads;   // resolved path : read count, fixture files only
  let manifest;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mathreg-single-read-'));
    mathRoot = path.join(root, 'math');
    const secRoot = path.join(mathRoot, '01-sec');

    writeFile(secRoot, 'index.md', INDEX_MD);
    writeFile(secRoot, '1-foo.md', FOO_MD);
    writeFile(secRoot, '2-bar.md', BAR_MD);

    mdPaths = {
      index: path.join(secRoot, 'index.md'),
      foo: path.join(secRoot, '1-foo.md'),
      bar: path.join(secRoot, '2-bar.md'),
    };

    // Count reads per resolved path, but only for files under the fixture root so
    // incidental reads elsewhere (module loading, parser engines) cannot pollute the
    // count. The spy delegates to the real reader so getFilePosition and loadContent
    // still see file contents. fs.readFileSync is restored in the finally block.
    reads = new Map();
    const fixturePrefix = path.resolve(root) + path.sep;
    const realReadFileSync = fs.readFileSync;
    const origLog = console.log;
    const origWarn = console.warn;

    fs.readFileSync = function (p, ...rest) {
      if (typeof p === 'string') {
        const resolved = path.resolve(p);
        if (resolved.startsWith(fixturePrefix)) {
          reads.set(resolved, (reads.get(resolved) || 0) + 1);
        }
      }
      return realReadFileSync.call(this, p, ...rest);
    };
    console.log = () => {};
    console.warn = () => {};
    try {
      const plugin = mathRegistryPlugin({}, { contentDirs: [{ dir: mathRoot, routeBase: 'math' }] });
      manifest = await plugin.loadContent();
    } finally {
      fs.readFileSync = realReadFileSync;
      console.log = origLog;
      console.warn = origWarn;
    }
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads each non-index content file exactly once (the double read is gone)', () => {
    // The core gate. On the old source getFilePosition and loadContent each read
    // these files, so the count was 2; carrying the raw text through makes it 1.
    assert.equal(reads.get(path.resolve(mdPaths.foo)), 1, '1-foo.md read exactly once');
    assert.equal(reads.get(path.resolve(mdPaths.bar)), 1, '2-bar.md read exactly once');
  });

  it('keeps index files read exactly once (they never reach getFilePosition)', () => {
    // index.md is excluded from readSortedItems, so it is read solely by loadContent:
    // one read on both the old and new source. Pinning it guards the branch where a
    // hierarchy entry carries no raw text and loadContent must read it itself.
    assert.equal(reads.get(path.resolve(mdPaths.index)), 1, 'index.md read exactly once');
  });

  it('reads no fixture file more than once and reads no extra files', () => {
    // Exactly three fixture reads total: one per .md file, nothing doubled, nothing
    // spurious. This is the whole-build read budget for the fixture.
    const total = [...reads.values()].reduce((sum, n) => sum + n, 0);
    assert.equal(total, 3, 'three fixture reads total (one per .md file)');
    for (const [p, count] of reads) {
      assert.equal(count, 1, `${p} read exactly once`);
    }
  });

  it('produces the unchanged manifest from the single read (behavior preserved)', () => {
    // Reusing the carried raw must scan the same bytes: the manifest is identical to
    // what the double-read engine produced. The existing suites pin manifest behavior
    // broadly; this is the local proof that single-read did not corrupt the scan.
    assert.deepStrictEqual(manifest, EXPECTED_MANIFEST);
  });
});
