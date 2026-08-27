import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// docusaurus-plugin-math-registry.js is CommonJS; load the REAL module the way
// the sibling plugin suite does, then drive its loadContent() over a populated
// temp fixture so the actual directory walk (buildHierarchy, readSortedItems,
// getFolderPosition, getFilePosition, findIndexFile, toRoutePath, and the
// per-chapter / per-file counter loop) is exercised end to end.
//
// These are CHARACTERIZATION tests: they pin the CURRENT, correct output of the
// numbering engine. The expected manifest below is a hand trace of loadContent
// (plugin lines ~195 to 268). If the real engine ever diverges, the divergence
// is the surprise to record, not a reason to weaken an assertion.
const require = createRequire(import.meta.url);
const mathRegistryPlugin = require('../../../../plugins/docusaurus-plugin-math-registry.js');

// Write a file, creating its parent directory first. Bodies are written verbatim
// so the document order of the <Type id="..."> tags drives the counter order.
function writeFile(root, rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
}

// The recommended fixture from the GOAL. Each .md carries real frontmatter plus
// its <Type id="..."> blocks in document order.
//
//   01-intro.md              -> Theorem t1, Equation e1, Equation e2, Figure f1
//   02-algebra/index.md      -> Definition d1, Figure f2          (folder page)
//   02-algebra/01-groups.md  -> Theorem t2, Equation e3, Table tab1
//
// Plus decoys that must be skipped without perturbing any number:
//   index.md          (ROOT index is never registered)
//   _draft.md         (underscore prefix is skipped)
//   .hidden.md        (dot prefix is skipped)
//   assets/skip.md    (the assets directory is skipped wholesale)
const PRIMARY_FILES = {
  '01-intro.md':
    '---\ntitle: Intro\n---\n\n# Intro\n\n' +
    '<Theorem id="t1">First theorem.</Theorem>\n\n' +
    '<Equation id="e1">x = 1</Equation>\n\n' +
    '<Equation id="e2">y = 2</Equation>\n\n' +
    '<Figure id="f1">A picture.</Figure>\n',
  '02-algebra/_category_.json': '{"position": 2}\n',
  '02-algebra/index.md':
    '---\ntitle: Algebra\n---\n\n# Algebra\n\n' +
    '<Definition id="d1">A group.</Definition>\n\n' +
    '<Figure id="f2">A lattice.</Figure>\n',
  '02-algebra/01-groups.md':
    '---\ntitle: Groups\n---\n\n# Groups\n\n' +
    '<Theorem id="t2">Lagrange.</Theorem>\n\n' +
    '<Equation id="e3">|G| = |H| [G:H]</Equation>\n\n' +
    '<Table id="tab1">A Cayley table.</Table>\n',
  // Decoys: present in the tree but expected to leave NO manifest entry.
  'index.md':
    '---\ntitle: Root\n---\n\n<Remark id="rootIndexRemark">Root index is not registered.</Remark>\n',
  '_draft.md': '<Theorem id="draftThm">Underscore files are skipped.</Theorem>\n',
  '.hidden.md': '<Theorem id="hiddenThm">Dot files are skipped.</Theorem>\n',
  'assets/skip.md': '<Theorem id="assetThm">The assets directory is skipped.</Theorem>\n',
};

// The careful trace: these ARE the current correct outputs of loadContent.
const EXPECTED_MANIFEST = {
  t1: { type: 'Theorem', number: '1.1', page: '/math/intro' },
  e1: { type: 'Equation', number: '1.1', page: '/math/intro' },
  e2: { type: 'Equation', number: '1.2', page: '/math/intro' },
  f1: { type: 'Figure', number: '1.1', page: '/math/intro' },
  d1: { type: 'Definition', number: '2.1', page: '/math/algebra' },
  f2: { type: 'Figure', number: '2.1', page: '/math/algebra' },
  t2: { type: 'Theorem', number: '2.2', page: '/math/algebra/groups' },
  e3: { type: 'Equation', number: '2.1.1', page: '/math/algebra/groups' },
  tab1: { type: 'Table', number: '2.1', page: '/math/algebra/groups' },
};

// A second fixture that isolates folder ordering. The _category_.json "position"
// is made to CONTRADICT the numeric filename prefix so a passing assertion proves
// position wins (not the filename digits, which only act as the fallback):
//   08-zulu  has position 1  -> sorts FIRST  -> chapter 1
//   02-alpha has position 9  -> sorts SECOND -> chapter 2
const ORDERING_FILES = {
  '08-zulu/_category_.json': '{"position": 1}\n',
  '08-zulu/index.md': '---\ntitle: Zulu\n---\n\n<Theorem id="zulu">Sorted first by position.</Theorem>\n',
  '02-alpha/_category_.json': '{"position": 9}\n',
  '02-alpha/index.md': '---\ntitle: Alpha\n---\n\n<Theorem id="alpha">Sorted second by position.</Theorem>\n',
};

describe('math-registry loadContent numbering over a populated directory', () => {
  let root;
  let mathRoot;
  let orderRoot;
  let manifest;
  let orderManifest;

  before(async () => {
    // One temp root holds both fixtures; it is removed wholesale in after().
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mathreg-'));
    mathRoot = path.join(root, 'math');
    orderRoot = path.join(root, 'order');

    for (const [rel, body] of Object.entries(PRIMARY_FILES)) writeFile(mathRoot, rel, body);
    for (const [rel, body] of Object.entries(ORDERING_FILES)) writeFile(orderRoot, rel, body);

    // Run the real engine once per fixture; loadContent keeps all of its state
    // local to the call, so the two manifests are independent.
    const plugin = mathRegistryPlugin({}, { contentDirs: [{ dir: mathRoot, routeBase: 'math' }] });
    manifest = await plugin.loadContent();

    const orderPlugin = mathRegistryPlugin({}, { contentDirs: [{ dir: orderRoot, routeBase: 'math' }] });
    orderManifest = await orderPlugin.loadContent();
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('produces the full expected manifest for the recommended fixture', () => {
    // The headline characterization snapshot: exact key set and exact value for
    // every registered tag, with no decoy leaking in.
    assert.deepEqual(manifest, EXPECTED_MANIFEST);
  });

  it('shares one per-chapter counter across theorem-like types, spanning files', () => {
    // Theorem, Definition, Lemma, etc. draw from a single per-chapter counter.
    // d1 (in the folder index) takes 2.1, then t2 (in a sibling file of the same
    // chapter) takes 2.2: the counter carries ACROSS files. This cross-file shared
    // counter is the central behavior.
    assert.equal(manifest.t1.number, '1.1');
    assert.equal(manifest.d1.number, '2.1');
    assert.equal(manifest.t2.number, '2.2');
    assert.equal(manifest.t2.type, 'Theorem');
    assert.equal(manifest.d1.type, 'Definition');
  });

  it('gives Figure and Table their own per-chapter counters, independent of theorem-like', () => {
    // f1 is 1.1 even though t1 is also 1.1: Figure keeps a counter separate from
    // the theorem-like one. Table is likewise independent.
    assert.equal(manifest.f1.number, '1.1');
    assert.equal(manifest.f2.number, '2.1');
    assert.equal(manifest.tab1.number, '2.1');
    assert.equal(manifest.f1.type, 'Figure');
    assert.equal(manifest.tab1.type, 'Table');
  });

  it('numbers Equation with a per-file counter and the full hierarchical prefix, resetting each file', () => {
    // Equation uses a per-file counter prefixed by the file's hierarchical number.
    // e1, e2 run 1.1, 1.2 inside the top-level file (prefix "1"); e3 resets to
    // 2.1.1 inside the depth-2 file (prefix "2.1").
    assert.equal(manifest.e1.number, '1.1');
    assert.equal(manifest.e2.number, '1.2');
    assert.equal(manifest.e3.number, '2.1.1');
    assert.equal(manifest.e1.type, 'Equation');
  });

  it('shapes every manifest entry as exactly { type, number, page }', () => {
    for (const [id, entry] of Object.entries(manifest)) {
      assert.deepEqual(Object.keys(entry).sort(), ['number', 'page', 'type'], `entry ${id} has the expected keys`);
      assert.equal(typeof entry.type, 'string');
      assert.equal(typeof entry.number, 'string');
      assert.equal(typeof entry.page, 'string');
    }
  });

  it('registers a folder index.md under the folder prefix and route', () => {
    // 02-algebra/index.md is the folder's own page: it takes the folder prefix
    // (chapter 2) and the folder route /math/algebra, not a sub-section number.
    assert.equal(manifest.d1.page, '/math/algebra');
    assert.equal(manifest.f2.page, '/math/algebra');
  });

  it('does not register a root-level index.md', () => {
    // The top-level index.md represents the content root itself and is never
    // walked as a numbered child, so its tag is absent from the manifest.
    assert.equal(manifest.rootIndexRemark, undefined);
    assert.ok(!('rootIndexRemark' in manifest));
  });

  it('skips underscore-prefixed, dot-prefixed, and assets entries', () => {
    // _draft.md, .hidden.md, and assets/skip.md are all filtered by readSortedItems,
    // so none of their tags reach the manifest.
    assert.equal(manifest.draftThm, undefined);
    assert.equal(manifest.hiddenThm, undefined);
    assert.equal(manifest.assetThm, undefined);
  });

  it('strips the leading NN- numeric prefix from each page path segment', () => {
    // toRoutePath drops the ordering prefix from every segment: 01-intro becomes
    // intro, 02-algebra/01-groups becomes algebra/groups.
    assert.equal(manifest.t1.page, '/math/intro');
    assert.equal(manifest.t2.page, '/math/algebra/groups');
    for (const entry of Object.values(manifest)) {
      assert.ok(!/\/\d+-/.test(entry.page), `page ${entry.page} keeps no NN- prefix on any segment`);
    }
  });

  it('orders folders by _category_.json position over the numeric filename prefix', () => {
    // 08-zulu (position 1) sorts ahead of 02-alpha (position 9) despite the larger
    // filename digits, so zulu is chapter 1 and alpha is chapter 2. Position wins;
    // the filename prefix is only the fallback (as 01-intro demonstrates above).
    assert.equal(orderManifest.zulu.number, '1.1');
    assert.equal(orderManifest.zulu.page, '/math/zulu');
    assert.equal(orderManifest.alpha.number, '2.1');
    assert.equal(orderManifest.alpha.page, '/math/alpha');
  });
});
