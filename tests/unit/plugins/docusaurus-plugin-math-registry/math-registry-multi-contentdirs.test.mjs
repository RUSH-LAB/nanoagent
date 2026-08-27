import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// docusaurus-plugin-math-registry.js is CommonJS; load the REAL module the way
// the sibling plugin suites do, then drive its loadContent() over TWO
// contentDirs inside a SINGLE plugin instance. The existing single-dir suite
// (tests/next-math-registry-loadcontent-numbering.test.mjs) always passes one
// contentDirs entry per instance, so the multi-dir behavior below is otherwise
// at zero coverage.
//
// These are CHARACTERIZATION tests: they pin the CURRENT output of the numbering
// engine for the multi-dir case. Every golden is a hand trace of the module's
// loadContent function (its for...of contentDirs loop, plus the manifest and
// seenIds it keeps outside that loop). If the real engine ever diverges, that
// divergence is the surprise to record, not a reason to weaken an assertion.
const require = createRequire(import.meta.url);
const mathRegistryPlugin = require('../../../../plugins/docusaurus-plugin-math-registry.js');

// Write a file, creating its parent directory first. Bodies are written verbatim
// so the document order of the <Type id="..."> tags drives the counter order.
// (Mirrors the helper in the sibling single-dir suite.)
function writeFile(root, rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
}

// Dir A is served under routeBase "math". One top-level chapter (prefix "1",
// chapter 1) holding, in document order:
//   a-thm  (Theorem)  -> theorem-like #1            -> 1.1
//   a-eq   (Equation) -> per-file Equation #1       -> 1.1  (prefix "1")
//   a-fig  (Figure)   -> Figure #1                  -> 1.1
//   a-thm2 (Theorem)  -> theorem-like #2            -> 1.2
//   dup    (Theorem)  -> theorem-like #3            -> 1.3  (overwritten later)
const DIR_A_FILES = {
  '01-intro.md':
    '---\ntitle: Intro\n---\n\n# Intro\n\n' +
    '<Theorem id="a-thm">A theorem.</Theorem>\n\n' +
    '<Equation id="a-eq">a = 1</Equation>\n\n' +
    '<Figure id="a-fig">A figure.</Figure>\n\n' +
    '<Theorem id="a-thm2">A second theorem.</Theorem>\n\n' +
    '<Theorem id="dup">Shared id; dir A occurrence, overwritten by dir B.</Theorem>\n',
};

// Dir B is served under routeBase "guide". One top-level chapter (prefix "1",
// chapter 1) holding, in document order:
//   b-thm (Theorem)  -> theorem-like #1 -> 1.1   (counter RESET vs dir A)
//   b-eq  (Equation) -> per-file #1      -> 1.1
//   dup   (Lemma)    -> theorem-like #2 -> 1.2   (this write wins)
const DIR_B_FILES = {
  '01-start.md':
    '---\ntitle: Start\n---\n\n# Start\n\n' +
    '<Theorem id="b-thm">B theorem.</Theorem>\n\n' +
    '<Equation id="b-eq">b = 2</Equation>\n\n' +
    '<Lemma id="dup">Shared id; dir B occurrence wins.</Lemma>\n',
};

// The careful trace of the merged manifest: manifest and seenIds live OUTSIDE
// the contentDirs loop, so one object holds every entry from BOTH dirs. The
// "dup" key resolves to dir B's Lemma at /guide/start because the per-occurrence
// assignment "manifest[id] = ..." has no guard and the later dir overwrites.
const EXPECTED_MERGED = {
  'a-thm': { type: 'Theorem', number: '1.1', page: '/math/intro' },
  'a-eq': { type: 'Equation', number: '1.1', page: '/math/intro' },
  'a-fig': { type: 'Figure', number: '1.1', page: '/math/intro' },
  'a-thm2': { type: 'Theorem', number: '1.2', page: '/math/intro' },
  dup: { type: 'Lemma', number: '1.2', page: '/guide/start' },
  'b-thm': { type: 'Theorem', number: '1.1', page: '/guide/start' },
  'b-eq': { type: 'Equation', number: '1.1', page: '/guide/start' },
};

describe('math-registry loadContent across multiple contentDirs', () => {
  let root;
  let dirA;
  let dirB;
  let manifest;
  const warnings = [];

  before(async () => {
    // One temp root holds both fixture dirs; it is removed wholesale in after().
    // The physical folder names ("dir-a" / "dir-b") deliberately differ from the
    // routeBase values to show the route comes from routeBase, not the folder.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mathreg-multi-'));
    dirA = path.join(root, 'dir-a');
    dirB = path.join(root, 'dir-b');

    for (const [rel, body] of Object.entries(DIR_A_FILES)) writeFile(dirA, rel, body);
    for (const [rel, body] of Object.entries(DIR_B_FILES)) writeFile(dirB, rel, body);

    // A SINGLE plugin instance fed TWO contentDirs. This is the path the sibling
    // suite never exercises.
    const plugin = mathRegistryPlugin({}, {
      contentDirs: [
        { dir: dirA, routeBase: 'math' },
        { dir: dirB, routeBase: 'guide' },
      ],
    });

    // The engine logs a summary (console.log) and warns on duplicate ids
    // (console.warn). Silence both to keep the test output clean, and collect the
    // warnings so the cross-dir seenIds behavior can be asserted below.
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    console.log = () => {};
    try {
      manifest = await plugin.loadContent();
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('merges entries from both contentDirs into one manifest', () => {
    // The headline snapshot: a single returned object carrying every registered
    // tag from dir A AND dir B, with exact value for each.
    assert.deepEqual(manifest, EXPECTED_MERGED);
  });

  it('restarts the per-chapter counter for each contentDir', () => {
    // chapterCounters is declared INSIDE the contentDirs loop, so it starts empty
    // for dir B. Dir A's per-chapter theorem-like counter reaches 1.3 (a-thm,
    // a-thm2, dup), yet dir B's first theorem-like block is 1.1, not a
    // continuation. Both dirs therefore expose a block numbered 1.1, told apart
    // only by page.
    assert.equal(manifest['a-thm'].number, '1.1');
    assert.equal(manifest['b-thm'].number, '1.1');
    assert.equal(manifest['a-thm'].type, 'Theorem');
    assert.equal(manifest['b-thm'].type, 'Theorem');
    assert.notEqual(manifest['a-thm'].page, manifest['b-thm'].page);
  });

  it('routes each dir under its own routeBase', () => {
    // Each dir carries its own routeBase: dir A entries resolve under /math/ and
    // dir B entries under /guide/.
    assert.equal(manifest['a-thm'].page, '/math/intro');
    assert.equal(manifest['b-thm'].page, '/guide/start');
    assert.equal(manifest['b-eq'].page, '/guide/start');

    for (const id of ['a-thm', 'a-eq', 'a-fig', 'a-thm2']) {
      assert.ok(manifest[id].page.startsWith('/math/'), `${id} routes under /math/`);
    }
    for (const id of ['b-thm', 'b-eq']) {
      assert.ok(manifest[id].page.startsWith('/guide/'), `${id} routes under /guide/`);
    }
  });

  it('resolves a duplicate id to the last contentDir (last write wins)', () => {
    // manifest[id] is assigned on every occurrence with no guard, so the id "dup"
    // present in both dirs ends as dir B's entry. The survivor is the Lemma at
    // /guide/start numbered 1.2, NOT dir A's Theorem at /math/intro numbered 1.3.
    assert.deepStrictEqual(manifest.dup, {
      type: 'Lemma',
      number: '1.2',
      page: '/guide/start',
    });
  });

  it('shares seenIds across dirs, warning once on the cross-dir duplicate', () => {
    // seenIds also lives OUTSIDE the loop. Dir A's "dup" is a first sighting (no
    // warning); dir B's "dup" is already in seenIds, so exactly one duplicate
    // warning fires. A per-dir seenIds would have produced zero.
    const dupWarnings = warnings.filter(w => w.includes('Duplicate ID "dup"'));
    assert.equal(dupWarnings.length, 1);
  });

  it('shapes every merged entry as exactly { type, number, page }', () => {
    for (const [id, entry] of Object.entries(manifest)) {
      assert.deepEqual(Object.keys(entry).sort(), ['number', 'page', 'type'], `entry ${id} has the expected keys`);
      assert.equal(typeof entry.type, 'string');
      assert.equal(typeof entry.number, 'string');
      assert.equal(typeof entry.page, 'string');
    }
  });
});
