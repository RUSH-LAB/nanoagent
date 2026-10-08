import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// docusaurus-plugin-math-registry.js is CommonJS; load the REAL module the way
// the sibling plugin suite does, then drive its loadContent() over a populated
// temp fixture so the actual getFolderPosition fallback chain runs end to end.
//
// These are CHARACTERIZATION tests: they pin the CURRENT, correct output of the
// folder-ordering fallback in getFolderPosition (plugin lines ~90 to 101). The
// sibling suite (next-math-registry-loadcontent-numbering) never reaches that
// fallback because every folder it builds carries a valid _category_.json
// "position"; here NONE of the folders yields a usable position, so each rung of
// the fallback fires. The expected manifest below was captured from the real
// engine and matches a hand trace of getFolderPosition; if the engine ever
// diverges, the divergence is the surprise to record, not a reason to weaken an
// assertion.
const require = createRequire(import.meta.url);
const mathRegistryPlugin = require('../../../../plugins/math-registry/index.js');

// Write a file, creating its parent directory first. Mirrors the sibling suite's
// helper so the document order of the <Type id="..."> tags drives counter order.
function writeFile(root, rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
}

// A fixture that isolates the FOLDER-position fallback chain. None of these four
// folders yields a usable _category_.json "position", so getFolderPosition must
// fall back, and each folder exercises a different rung of that fallback:
//
//   02-gamma  malformed _category_.json     -> JSON.parse throws  -> prefix 2
//   03-alpha  no _category_.json            -> existsSync false   -> prefix 3
//   05-beta   _category_.json, no position  -> position != null no -> prefix 5
//   zeta      no _category_.json, no digits -> no prefix match    -> 999
//
// Sorted by the resulting positions (2, 3, 5, 999) the chapters fall out as
// gamma=1, alpha=2, beta=3, zeta=4, so the single <Theorem> in each index.md is
// numbered 1.1, 2.1, 3.1, 4.1 at /math/gamma, /math/alpha, /math/beta,
// /math/zeta.
const FOLDER_FILES = {
  // 1. Malformed _category_.json: the whole string fails JSON.parse, the catch
  // swallows it, and the position falls back to the folder filename prefix 2.
  // The bogus "position": 42 (between beta's 5 and zeta's 999) would sort gamma
  // THIRD if it were ever parsed, so gamma landing at chapter 1 proves the
  // throw-and-fallback path actually ran.
  '02-gamma/_category_.json': '{ "position": 42, this is not valid json,, }\n',
  '02-gamma/index.md':
    '---\ntitle: Gamma\n---\n\n# Gamma\n\n' +
    '<Theorem id="gammaThm">Malformed _category_.json falls back to prefix 2.</Theorem>\n',
  // 2. Absent _category_.json: existsSync is false, so the position falls back to
  // the folder filename prefix 3.
  '03-alpha/index.md':
    '---\ntitle: Alpha\n---\n\n# Alpha\n\n' +
    '<Theorem id="alphaThm">Absent _category_.json falls back to prefix 3.</Theorem>\n',
  // 3. Present but position-less _category_.json: JSON.parse succeeds yet the
  // cat.position != null guard fails, so the position falls back to the prefix 5.
  '05-beta/_category_.json': '{"label": "Beta", "collapsed": false}\n',
  '05-beta/index.md':
    '---\ntitle: Beta\n---\n\n# Beta\n\n' +
    '<Theorem id="betaThm">Position-less _category_.json falls back to prefix 5.</Theorem>\n',
  // 4. Neither a _category_.json nor a leading numeric prefix: the basename has
  // no digits, so the position falls back to the sentinel 999 and sorts last.
  'zeta/index.md':
    '---\ntitle: Zeta\n---\n\n# Zeta\n\n' +
    '<Theorem id="zetaThm">No _category_.json and no prefix falls back to 999.</Theorem>\n',
};

// The careful trace, captured from the real engine: these ARE the current
// correct outputs of loadContent over the fixture above.
const EXPECTED_MANIFEST = {
  gammaThm: { type: 'Theorem', number: '1.1', page: '/math/gamma' },
  alphaThm: { type: 'Theorem', number: '2.1', page: '/math/alpha' },
  betaThm: { type: 'Theorem', number: '3.1', page: '/math/beta' },
  zetaThm: { type: 'Theorem', number: '4.1', page: '/math/zeta' },
};

describe('math-registry getFolderPosition fallback chain over a populated directory', () => {
  let root;
  let mathRoot;
  let manifest;

  before(async () => {
    // One temp root holds the fixture; it is removed wholesale in after().
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mathreg-folderpos-'));
    mathRoot = path.join(root, 'math');
    for (const [rel, body] of Object.entries(FOLDER_FILES)) writeFile(mathRoot, rel, body);

    // Run the real engine once; loadContent keeps all of its state local to the
    // call, so the manifest is a clean function of the fixture.
    const plugin = mathRegistryPlugin({}, { contentDirs: [{ dir: mathRoot, routeBase: 'math' }] });
    manifest = await plugin.loadContent();
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('produces the full expected manifest pinning the folder-position fallback chain', () => {
    // The headline characterization snapshot: exact key set and exact value for
    // each folder's lone Theorem, across all four fallback rungs at once.
    assert.deepStrictEqual(manifest, EXPECTED_MANIFEST);
  });

  it('tolerates a malformed _category_.json and falls back to the folder filename prefix', () => {
    // 02-gamma's _category_.json is invalid JSON, so JSON.parse throws, the catch
    // swallows it, and getFolderPosition uses the prefix 2 -> gamma sorts FIRST
    // (chapter 1). The bogus "position": 42 baked into the broken JSON is never
    // read, which is exactly why gamma is 1.1 and not the 3.1 that position 42
    // (between beta's 5 and zeta's 999) would have demoted it to.
    assert.deepStrictEqual(manifest.gammaThm, { type: 'Theorem', number: '1.1', page: '/math/gamma' });
  });

  it('falls back to the filename prefix when _category_.json is absent', () => {
    // 03-alpha has no _category_.json at all (existsSync false), so the position
    // is the prefix 3 -> alpha is chapter 2, numbered 2.1 at /math/alpha.
    assert.deepStrictEqual(manifest.alphaThm, { type: 'Theorem', number: '2.1', page: '/math/alpha' });
  });

  it('falls back to the filename prefix when _category_.json has no position field', () => {
    // 05-beta's _category_.json parses fine but carries only label and collapsed;
    // the cat.position != null guard fails, so the position is the prefix 5 ->
    // beta is chapter 3, numbered 3.1 at /math/beta.
    assert.deepStrictEqual(manifest.betaThm, { type: 'Theorem', number: '3.1', page: '/math/beta' });
  });

  it('falls back to 999 when there is neither a _category_.json nor a numeric prefix', () => {
    // zeta has no _category_.json and no leading digits, so getFolderPosition
    // returns the sentinel 999. 999 is larger than every sibling's fallback
    // (2, 3, 5), so zeta sorts dead last -> chapter 4, numbered 4.1 at /math/zeta.
    assert.deepStrictEqual(manifest.zetaThm, { type: 'Theorem', number: '4.1', page: '/math/zeta' });
  });

  it('orders the four folders strictly by their fallback positions', () => {
    // The whole point of the chain: with no usable _category_.json position
    // anywhere, the fallbacks (2, 3, 5, 999) alone decide chapter order. Reading
    // the leading chapter digit of each Theorem back out reproduces that order.
    const chapterOf = id => Number(manifest[id].number.split('.')[0]);
    assert.deepStrictEqual(
      [chapterOf('gammaThm'), chapterOf('alphaThm'), chapterOf('betaThm'), chapterOf('zetaThm')],
      [1, 2, 3, 4],
    );
    // And the sentinel-999 folder really is last, after every prefixed sibling.
    const maxChapter = Math.max(...Object.values(manifest).map(e => Number(e.number.split('.')[0])));
    assert.equal(chapterOf('zetaThm'), maxChapter);
  });

  it('shapes every manifest entry as exactly { type, number, page }', () => {
    // Guards against a decoy leaking in or a shape drift: exactly the four folder
    // Theorems, each a { type, number, page } string triple.
    assert.deepStrictEqual(Object.keys(manifest).sort(), ['alphaThm', 'betaThm', 'gammaThm', 'zetaThm']);
    for (const [id, entry] of Object.entries(manifest)) {
      assert.deepStrictEqual(Object.keys(entry).sort(), ['number', 'page', 'type'], `entry ${id} has the expected keys`);
      assert.equal(typeof entry.type, 'string');
      assert.equal(typeof entry.number, 'string');
      assert.equal(typeof entry.page, 'string');
    }
  });
});
