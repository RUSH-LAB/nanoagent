import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// docusaurus-plugin-math-registry.js is CommonJS; load the REAL module the way
// the sibling plugin suite does, then drive its loadContent() over populated temp
// fixtures so the actual getFilePosition path is exercised end to end:
//
//   getFilePosition (plugin lines 75 to 84) reads each file's frontmatter, and
//     1. returns data.sidebar_position when it is `!= null` (so 0 counts),
//     2. else parses a leading numeric prefix from the basename,
//     3. else falls back to 999.
//   readSortedItems then sorts files by that position, buildHierarchy assigns the
//   1-based chapter/prefix in sorted order, and the loadContent counter loop turns
//   the first (and only) <Theorem> in each file into "<chapter>.1".
//
// These are CHARACTERIZATION tests: every golden below is a hand trace of the
// CURRENT engine, confirmed by running it. If the engine ever diverges, the
// divergence is the surprise to record, not a reason to weaken an assertion.
//
// The sibling suite tests/next-math-registry-loadcontent-numbering.test.mjs pins
// folder _category_.json position and the filename numeric-prefix fallback, but
// never a file's frontmatter sidebar_position. That 0-hit rule is what this file
// covers: frontmatter position winning over the filename prefix, the literal 0,
// and the 999 fallback, each read off the resulting chapter numbers.
const require = createRequire(import.meta.url);
const mathRegistryPlugin = require('../../../../plugins/docusaurus-plugin-math-registry.js');

// Write a file, creating its parent directory first (mirrors the sibling suite).
function writeFile(root, rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
}

// Build a .md body: YAML frontmatter (with sidebar_position only when one is
// given, so `undefined` models a file that omits the field entirely) followed by
// exactly one <Theorem id="..."> tag. One tag per file means each file's number
// is "<chapter>.1", so the chapter digit alone reports the file's sort position.
// Passing 0 keeps the field (0 == null is false), which is the point of rule 2.
function mdFile(title, id, sidebarPosition) {
  const frontmatter = sidebarPosition == null
    ? `---\ntitle: ${title}\n---\n`
    : `---\ntitle: ${title}\nsidebar_position: ${sidebarPosition}\n---\n`;
  return `${frontmatter}\n# ${title}\n\n<Theorem id="${id}">A theorem.</Theorem>\n`;
}

// Run the real plugin over one fixture directory and return its manifest.
async function loadManifest(dir) {
  const plugin = mathRegistryPlugin({}, { contentDirs: [{ dir, routeBase: 'math' }] });
  return plugin.loadContent();
}

// Fixture 1: frontmatter sidebar_position overrides the filename prefix.
// The GOAL's headline example. The filename digits (09 vs 01) would sort `early`
// first, but sidebar_position (1 vs 5) sorts `late` first instead.
//   09-late.md   sidebar_position 1 -> position 1 -> chapter 1 -> late  = 1.1
//   01-early.md  sidebar_position 5 -> position 5 -> chapter 2 -> early = 2.1
const OVERRIDE_FILES = {
  '09-late.md': mdFile('Late', 'late', 1),
  '01-early.md': mdFile('Early', 'early', 5),
};
const OVERRIDE_MANIFEST = {
  late: { type: 'Theorem', number: '1.1', page: '/math/late' },
  early: { type: 'Theorem', number: '2.1', page: '/math/early' },
};

// Fixture 2: sidebar_position 0 is honored, not treated as missing.
// The guard is `data.sidebar_position != null`, so 0 is a real position. Neither
// file has a numeric prefix, so if 0 were mistaken for "missing", `zero` would
// fall to 999 and sort LAST; honoring 0 sorts it first.
//   zero.md  sidebar_position 0 -> position 0 -> chapter 1 -> zero = 1.1
//   one.md   sidebar_position 1 -> position 1 -> chapter 2 -> one  = 2.1
const ZERO_FILES = {
  'zero.md': mdFile('Zero', 'zero', 0),
  'one.md': mdFile('One', 'one', 1),
};
const ZERO_MANIFEST = {
  zero: { type: 'Theorem', number: '1.1', page: '/math/zero' },
  one: { type: 'Theorem', number: '2.1', page: '/math/one' },
};

// Fixture 3: fallback to 999 with neither a position nor a numeric prefix.
// `notes.md` has frontmatter but no sidebar_position and no leading digits, so
// getFilePosition returns 999; it must sort after the prefixed sibling.
//   05-chapter.md  prefix 5, no position -> position 5   -> chapter 1 -> chapter = 1.1
//   notes.md       no prefix, no position -> position 999 -> chapter 2 -> notes  = 2.1
const FALLBACK_FILES = {
  '05-chapter.md': mdFile('Chapter', 'chapter'),
  'notes.md': mdFile('Notes', 'notes'),
};
const FALLBACK_MANIFEST = {
  chapter: { type: 'Theorem', number: '1.1', page: '/math/chapter' },
  notes: { type: 'Theorem', number: '2.1', page: '/math/notes' },
};

// Fixture 4: all three rules interacting in one merged manifest.
// Distinct positions (0, 1, 5, 999) make the sorted order unambiguous, and the
// filename prefixes are deliberately scrambled so only the positions explain it.
//   08-zero.md    sidebar_position 0 -> 0   -> chapter 1 -> zero   = 1.1  (0 honored; beats prefix 08)
//   09-first.md   sidebar_position 1 -> 1   -> chapter 2 -> first  = 2.1  (prefix 09 overridden)
//   01-second.md  sidebar_position 5 -> 5   -> chapter 3 -> second = 3.1  (prefix 01 overridden)
//   notes.md      no position/prefix -> 999 -> chapter 4 -> notes  = 4.1  (fallback, sorts last)
// Note that `first` (filename 09) precedes `second` (filename 01): proof the
// frontmatter position wins over a contradicting filename prefix.
const COMBINED_FILES = {
  '08-zero.md': mdFile('Zero', 'zero', 0),
  '09-first.md': mdFile('First', 'first', 1),
  '01-second.md': mdFile('Second', 'second', 5),
  'notes.md': mdFile('Notes', 'notes'),
};
const COMBINED_MANIFEST = {
  zero: { type: 'Theorem', number: '1.1', page: '/math/zero' },
  first: { type: 'Theorem', number: '2.1', page: '/math/first' },
  second: { type: 'Theorem', number: '3.1', page: '/math/second' },
  notes: { type: 'Theorem', number: '4.1', page: '/math/notes' },
};

describe('math-registry getFilePosition: frontmatter sidebar_position ordering', () => {
  let root;
  let overrideManifest;
  let zeroManifest;
  let fallbackManifest;
  let combinedManifest;

  before(async () => {
    // One temp root holds every fixture in its own subdirectory; it is removed
    // wholesale in after(). loadContent keeps all state local to the call, so the
    // four manifests are independent even where ids (zero, notes) repeat.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mathreg-filepos-'));

    const overrideRoot = path.join(root, 'override');
    const zeroRoot = path.join(root, 'zero');
    const fallbackRoot = path.join(root, 'fallback');
    const combinedRoot = path.join(root, 'combined');

    for (const [rel, body] of Object.entries(OVERRIDE_FILES)) writeFile(overrideRoot, rel, body);
    for (const [rel, body] of Object.entries(ZERO_FILES)) writeFile(zeroRoot, rel, body);
    for (const [rel, body] of Object.entries(FALLBACK_FILES)) writeFile(fallbackRoot, rel, body);
    for (const [rel, body] of Object.entries(COMBINED_FILES)) writeFile(combinedRoot, rel, body);

    overrideManifest = await loadManifest(overrideRoot);
    zeroManifest = await loadManifest(zeroRoot);
    fallbackManifest = await loadManifest(fallbackRoot);
    combinedManifest = await loadManifest(combinedRoot);
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('lets frontmatter sidebar_position override the filename numeric prefix', () => {
    // Full-manifest golden: despite the filename digits 09 > 01, sidebar_position
    // 1 < 5 sorts `late` ahead of `early`.
    assert.deepStrictEqual(overrideManifest, OVERRIDE_MANIFEST);

    // Targeted: the contradicting filename prefix loses to the frontmatter.
    assert.equal(overrideManifest.late.number, '1.1');
    assert.equal(overrideManifest.early.number, '2.1');
    const lateChapter = Number(overrideManifest.late.number.split('.')[0]);
    const earlyChapter = Number(overrideManifest.early.number.split('.')[0]);
    assert.ok(lateChapter < earlyChapter, 'sidebar_position 1 sorts ahead of sidebar_position 5');
  });

  it('honors sidebar_position 0 as a real position, not a missing value', () => {
    // If 0 were treated as falsy/missing, `zero` (no numeric prefix) would fall to
    // 999 and sort last; honoring `!= null` keeps it first.
    assert.deepStrictEqual(zeroManifest, ZERO_MANIFEST);
    assert.equal(zeroManifest.zero.number, '1.1');
    assert.equal(zeroManifest.one.number, '2.1');
  });

  it('falls back to position 999 with neither frontmatter position nor numeric prefix', () => {
    // `notes.md` has frontmatter but no sidebar_position and no leading digits, so
    // it gets 999 and sorts after the prefixed sibling.
    assert.deepStrictEqual(fallbackManifest, FALLBACK_MANIFEST);
    assert.equal(fallbackManifest.chapter.number, '1.1');
    assert.equal(fallbackManifest.notes.number, '2.1');
  });

  it('reflects all three rules together in the fully sorted merged manifest', () => {
    // The single deepStrictEqual pins the whole sorted order at once: 0 first,
    // then the two overrides in position (not filename) order, then the 999 fallback.
    assert.deepStrictEqual(combinedManifest, COMBINED_MANIFEST);

    // Targeted reads of the merged order, top to bottom.
    assert.equal(combinedManifest.zero.number, '1.1'); // sidebar_position 0 first
    assert.equal(combinedManifest.first.number, '2.1');
    assert.equal(combinedManifest.second.number, '3.1');
    assert.equal(combinedManifest.notes.number, '4.1'); // 999 fallback last

    // Contradicting prefixes: `first` is 09-, `second` is 01-, yet positions 1 < 5
    // keep `first` ahead. Frontmatter position wins over the filename prefix.
    const firstChapter = Number(combinedManifest.first.number.split('.')[0]);
    const secondChapter = Number(combinedManifest.second.number.split('.')[0]);
    assert.ok(firstChapter < secondChapter, 'position 1 (file 09-) precedes position 5 (file 01-)');
  });

  it('shapes every entry as exactly { type, number, page } across all fixtures', () => {
    const manifests = [overrideManifest, zeroManifest, fallbackManifest, combinedManifest];
    for (const manifest of manifests) {
      for (const [id, entry] of Object.entries(manifest)) {
        assert.deepStrictEqual(Object.keys(entry).sort(), ['number', 'page', 'type'], `entry ${id} keys`);
        assert.equal(typeof entry.type, 'string');
        assert.equal(typeof entry.number, 'string');
        assert.equal(typeof entry.page, 'string');
      }
    }
  });
});
