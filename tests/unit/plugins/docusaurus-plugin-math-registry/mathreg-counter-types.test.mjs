import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// docusaurus-plugin-math-registry.js is CommonJS; load the REAL module the way
// the sibling plugin suites do, then drive its loadContent() over a single-dir
// temp fixture so the actual per-chapter counter grouping is exercised end to end.
//
// These are CHARACTERIZATION tests: they pin the CURRENT output of the numbering
// engine. The existing math-registry suites only ever register Theorem,
// Definition, Figure, Table, and Equation through loadContent (Lemma appears once
// via a cross-dir duplicate). Proposition, Corollary, Remark, Example, Code, and
// Algorithm are otherwise at zero coverage through the engine; this suite pins how
// the engine groups those uncovered types into per-chapter counters.
//
// Every golden below was traced from the real return value of loadContent over the
// fixture (it was run, not hand guessed). If the real engine ever diverges, that
// divergence is the surprise to record, not a reason to weaken an assertion.
const require = createRequire(import.meta.url);
const mathRegistryPlugin = require('../../../../plugins/docusaurus-plugin-math-registry.js');

// Write a file, creating its parent directory first. The body is written verbatim
// so the document order of the <Type id="..."> tags drives the counter order.
// (Mirrors the helper in the sibling plugin suites.)
function writeFile(root, rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
}

// A single chapter file (prefix "1", chapter 1, route /math/ch) holding, in
// document order, one tag from each uncovered type plus a Theorem anchor:
//   t1     Theorem      theorem-like #1   -> 1.1
//   p1     Proposition  theorem-like #2   -> 1.2
//   c1     Corollary    theorem-like #3   -> 1.3
//   r1     Remark       theorem-like #4   -> 1.4
//   e1     Example      theorem-like #5   -> 1.5
//   code1  Code         Code #1           -> 1.1  (own per-chapter counter)
//   code2  Code         Code #2           -> 1.2
//   a1     Algorithm    Algorithm #1      -> 1.1  (own per-chapter counter)
const CHAPTER_FILE =
  '---\ntitle: Ch\n---\n\n# Ch\n\n' +
  '<Theorem id="t1">a</Theorem>\n\n' +
  '<Proposition id="p1">a</Proposition>\n\n' +
  '<Corollary id="c1">a</Corollary>\n\n' +
  '<Remark id="r1">a</Remark>\n\n' +
  '<Example id="e1">a</Example>\n\n' +
  '<Code id="code1">a</Code>\n\n' +
  '<Code id="code2">a</Code>\n\n' +
  '<Algorithm id="a1">a</Algorithm>\n';

// The careful trace: these ARE the current correct outputs of loadContent.
const EXPECTED_MANIFEST = {
  t1: { type: 'Theorem', number: '1.1', page: '/math/ch' },
  p1: { type: 'Proposition', number: '1.2', page: '/math/ch' },
  c1: { type: 'Corollary', number: '1.3', page: '/math/ch' },
  r1: { type: 'Remark', number: '1.4', page: '/math/ch' },
  e1: { type: 'Example', number: '1.5', page: '/math/ch' },
  code1: { type: 'Code', number: '1.1', page: '/math/ch' },
  code2: { type: 'Code', number: '1.2', page: '/math/ch' },
  a1: { type: 'Algorithm', number: '1.1', page: '/math/ch' },
};

describe('math-registry loadContent counter type families', () => {
  let root;
  let mathRoot;
  let manifest;

  before(async () => {
    // One temp root holds the fixture; it is removed wholesale in after().
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mathreg-types-'));
    mathRoot = path.join(root, 'math');
    writeFile(mathRoot, '01-ch.md', CHAPTER_FILE);

    // Run the real engine once. loadContent keeps all of its state local to the
    // call. On success it logs a one-line summary (console.log); silence it so the
    // test output stays clean, and restore the original in finally.
    const plugin = mathRegistryPlugin({}, { contentDirs: [{ dir: mathRoot, routeBase: 'math' }] });
    const origLog = console.log;
    console.log = () => {};
    try {
      manifest = await plugin.loadContent();
    } finally {
      console.log = origLog;
    }
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('produces the full expected manifest for the uncovered type families', () => {
    // Headline characterization snapshot: exact key set and exact value for every
    // registered tag (behavior 4).
    assert.deepStrictEqual(manifest, EXPECTED_MANIFEST);
  });

  it('shares one per-chapter counter across all theorem-like types', () => {
    // Theorem, Proposition, Corollary, Remark, and Example draw from a single
    // per-chapter counter (the engine's '_theoremLike' key), so they number
    // consecutively 1.1 through 1.5 in document order (behavior 1).
    assert.equal(manifest.t1.number, '1.1');
    assert.equal(manifest.p1.number, '1.2');
    assert.equal(manifest.c1.number, '1.3');
    assert.equal(manifest.r1.number, '1.4');
    assert.equal(manifest.e1.number, '1.5');
    assert.equal(manifest.t1.type, 'Theorem');
    assert.equal(manifest.p1.type, 'Proposition');
    assert.equal(manifest.c1.type, 'Corollary');
    assert.equal(manifest.r1.type, 'Remark');
    assert.equal(manifest.e1.type, 'Example');
  });

  it('gives Code its own per-chapter counter, independent of the theorem-like sequence', () => {
    // Code is per-chapter but NOT theorem-like, so it keeps its own counter: code1
    // is 1.1 and code2 is 1.2, restarting from 1 even though the theorem-like
    // sequence already reached 1.5 (behavior 2).
    assert.equal(manifest.code1.number, '1.1');
    assert.equal(manifest.code2.number, '1.2');
    assert.equal(manifest.code1.type, 'Code');
    assert.equal(manifest.code2.type, 'Code');
  });

  it('gives Algorithm its own per-chapter counter, independent of both theorem-like and Code', () => {
    // Algorithm is per-chapter but neither theorem-like nor Code, so it keeps a
    // third independent counter: a1 is 1.1, colliding in number with both t1 and
    // code1 yet tracked separately (behavior 3).
    assert.equal(manifest.a1.number, '1.1');
    assert.equal(manifest.a1.type, 'Algorithm');
  });

  it('shapes every manifest entry as exactly { type, number, page }', () => {
    // Mirrors the sibling suites: every entry is the same three-key record.
    for (const [id, entry] of Object.entries(manifest)) {
      assert.deepStrictEqual(Object.keys(entry).sort(), ['number', 'page', 'type'], `entry ${id} has the expected keys`);
      assert.equal(typeof entry.type, 'string');
      assert.equal(typeof entry.number, 'string');
      assert.equal(typeof entry.page, 'string');
    }
  });
});
