import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// docusaurus-plugin-math-registry.js is CommonJS; load the REAL module the way
// the sibling plugin suites do, then drive its loadContent() over a fixture that
// repeats one id WITHIN A SINGLE content directory. The sibling
// tests/next-math-registry-multi-contentdirs.test.mjs pins a duplicate id ACROSS
// two dirs (each dir starts with a fresh chapterCounters); the other
// math-registry suites use all-unique ids. So this same-dir collision is
// otherwise at zero coverage. Here both occurrences share ONE chapterCounters
// object, so the duplicate also advances (and thereby leaks) a counter slot.
//
// These are CHARACTERIZATION tests: every golden below is the actual return value
// of the real loadContent for this fixture (captured by running it), not an
// aspiration. If the real engine ever diverges, that divergence is the surprise
// to record, not a reason to weaken an assertion.
const require = createRequire(import.meta.url);
const mathRegistryPlugin = require('../plugins/docusaurus-plugin-math-registry.js');

// Write a file, creating its parent directory first. The body is written verbatim
// so the document order of the <Type id="..."> tags drives the counter order.
// (Mirrors the helper in the sibling math-registry suites.)
function writeFile(root, rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
}

// One content dir (routeBase "math") with a single chapter file. In document
// order the file holds:
//   dup (Theorem) -> theorem-like #1 -> 1.1   (first sighting, later overwritten)
//   dup (Theorem) -> theorem-like #2 -> 1.2   (this write wins; warns once)
//   lem (Lemma)   -> theorem-like #3 -> 1.3
// The two dup tags share the chapter's single theorem-like counter, so the
// duplicate consumes 1.2 and pushes lem to 1.3. The slot 1.1 is therefore
// leaked: the first dup consumed it, then the second dup overwrote that entry.
const FILES = {
  '01-ch.md':
    '---\ntitle: Chapter\n---\n\n# Chapter\n\n' +
    '<Theorem id="dup">first</Theorem>\n\n' +
    '<Theorem id="dup">second</Theorem>\n\n' +
    '<Lemma id="lem">third</Lemma>\n',
};

// The careful trace, confirmed against the real loadContent. The manifest holds
// only two keys: the duplicate id reuses its key (last write wins), so it never
// creates a second entry. The page /math/ch comes from stripping the leading
// "01-" ordering prefix off the "01-ch.md" filename.
const EXPECTED_MANIFEST = {
  dup: { type: 'Theorem', number: '1.2', page: '/math/ch' },
  lem: { type: 'Lemma', number: '1.3', page: '/math/ch' },
};

describe('math-registry loadContent same-dir duplicate id', () => {
  let root;
  let contentDir;
  let manifest;
  const warnings = [];

  before(async () => {
    // One temp root holds the single fixture dir; it is removed wholesale in
    // after(). The physical folder name ("content") deliberately differs from the
    // routeBase ("math") to show the route comes from routeBase, not the folder.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mathreg-samedir-'));
    contentDir = path.join(root, 'content');

    for (const [rel, body] of Object.entries(FILES)) writeFile(contentDir, rel, body);

    const plugin = mathRegistryPlugin({}, {
      contentDirs: [{ dir: contentDir, routeBase: 'math' }],
    });

    // The engine logs a summary (console.log) and warns on duplicate ids
    // (console.warn). Silence both to keep the output clean, and collect the
    // warnings so the single same-dir duplicate warning can be asserted. Restore
    // both in a finally so a thrown loadContent cannot leak the patched globals.
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

  it('pins the full manifest to exactly two keys (the duplicate adds no second key)', () => {
    // Behavior 3: the headline snapshot. Both dup tags collapse onto one "dup"
    // key, so the manifest carries exactly { dup, lem } and nothing else.
    assert.deepStrictEqual(manifest, EXPECTED_MANIFEST);
    assert.deepStrictEqual(Object.keys(manifest).sort(), ['dup', 'lem']);
  });

  it('resolves the duplicate id to its second occurrence (last write wins)', () => {
    // Behavior 1: manifest[id] is assigned on every occurrence with no guard, so
    // the surviving "dup" is the SECOND Theorem (number 1.2), not the first
    // (number 1.1). Both occurrences sit on the same page /math/ch.
    assert.deepStrictEqual(manifest.dup, {
      type: 'Theorem',
      number: '1.2',
      page: '/math/ch',
    });
  });

  it('advances the shared theorem-like counter on the duplicate, leaking 1.1', () => {
    // Behavior 2: the seenIds.has(id) branch only warns; it has no continue or
    // return, so the counter still advances for the duplicate. The first dup took
    // 1.1, the duplicate dup took 1.2, and lem took 1.3. No surviving entry holds
    // 1.1, so that slot is leaked.
    assert.equal(manifest.dup.number, '1.2');
    assert.equal(manifest.lem.number, '1.3');
    const numbers = Object.values(manifest).map(entry => entry.number);
    assert.ok(!numbers.includes('1.1'), 'the first dup consumed 1.1; no surviving entry holds it');
  });

  it('pins the trailing lemma that the leaked counter pushes to 1.3', () => {
    // The Lemma after the duplicate is the third theorem-like block in the
    // chapter, so it lands on 1.3 (not 1.2), proving the duplicate was counted
    // rather than skipped.
    assert.deepStrictEqual(manifest.lem, {
      type: 'Lemma',
      number: '1.3',
      page: '/math/ch',
    });
  });

  it('warns exactly once for the same-dir duplicate id', () => {
    // Behavior 4: the first dup is a first sighting (no warning); the second dup
    // is already in seenIds, so exactly one duplicate warning fires for "dup".
    const dupWarnings = warnings.filter(w => w.includes('Duplicate ID "dup"'));
    assert.equal(dupWarnings.length, 1);
  });

  it('shapes every manifest entry as exactly { type, number, page }', () => {
    // Each survivor is a plain three-field record, with no extra bookkeeping keys
    // leaking out of the duplicate handling.
    for (const [id, entry] of Object.entries(manifest)) {
      assert.deepStrictEqual(Object.keys(entry).sort(), ['number', 'page', 'type'], `entry ${id} has the expected keys`);
      assert.equal(typeof entry.type, 'string');
      assert.equal(typeof entry.number, 'string');
      assert.equal(typeof entry.page, 'string');
    }
  });
});
