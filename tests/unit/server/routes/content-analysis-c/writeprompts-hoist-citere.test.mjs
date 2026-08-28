import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-c.js');

// Fixture for GET /api/writing-prompts. WRITING_PROMPTS_CITE_RE was hoisted to module
// scope, so one shared instance now scans every file across every request to build the
// set of cited keys. The handler resets WRITING_PROMPTS_CITE_RE.lastIndex = 0 before
// each file's exec loop, so the cited-key set (and the uncited-reference prompts derived
// from it) stays identical no matter the walk order or how many requests preceded.
//
// Each content file carries one `[@key]` citation, and one of them sits right after the
// front matter so a stale lastIndex would skip it. smith2020 and jones2021 are cited;
// ghost2019 and phantom2018 are not, so they are the only two uncited references.
const REFERENCES_YAML = `smith2020:
  title: A Cited Paper
  year: 2020
jones2021:
  title: Another Cited Paper
  year: 2021
ghost2019:
  title: An Uncited Paper
  year: 2019
phantom2018:
  title: Also Never Cited
  year: 2018
`;

const CONTENT = {
  'a.md': `---
title: Note A
---

[@smith2020] is cited at the very start of this note.
`,
  'b.md': `---
title: Note B
---

Here we cite [@jones2021] in a separate file entirely.
`,
};

// The two references that appear in no content file. The handler caps uncited prompts
// at five and emits them in references.yaml order, so [ghost2019, phantom2018] is the
// full, ordered set — but the tests sort keys to stay independent of mapping order.
const EXPECTED_UNCITED_KEYS = ['ghost2019', 'phantom2018'];

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'writeprompts-hoist-citere-'));
  fs.mkdirSync(path.join(root, 'content', 'bibliography'), { recursive: true });
  fs.writeFileSync(path.join(root, 'content', 'bibliography', 'references.yaml'), REFERENCES_YAML, 'utf-8');
  for (const [rel, body] of Object.entries(CONTENT)) {
    const full = path.join(root, 'content', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Drive the real GET /api/writing-prompts handler over the fixture content dir and
// return the captured json() response. loadJSON is stubbed empty so no research-question
// prompts appear; cached runs its producer so the low-quality scan executes for real.
async function runWritingPrompts() {
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    ALLOWED_EXTS: ['.md', '.mdx'],
    loadJSON: () => ({}),
    cached: (_key, _ttlMs, producer) => producer(),
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL('http://localhost/api/writing-prompts');
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, '/api/writing-prompts', ctx);
  return captured;
}

// The cited-key scan only drives the `uncited-reference` prompts; pull those keys out,
// sorted, so assertions do not hinge on incidental expand-content prompts or order.
function uncitedKeys(payload) {
  return payload.prompts
    .filter(p => p.type === 'uncited-reference')
    .map(p => p.key)
    .sort();
}

describe('GET /api/writing-prompts (hoisted module-scope WRITING_PROMPTS_CITE_RE)', () => {
  it('flags exactly the uncited references over the fixture', async () => {
    const { status, payload } = await runWritingPrompts();
    assert.equal(status, 200);
    assert.deepEqual(uncitedKeys(payload), EXPECTED_UNCITED_KEYS);
  });

  it('returns identical prompts on two back-to-back calls (no stale lastIndex bleed)', async () => {
    const first = await runWritingPrompts();
    const second = await runWritingPrompts();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // The shared module-scope regex is reset before each file's exec loop, so a second
    // request over the same content produces a byte-identical payload. If a future change
    // leaked lastIndex across requests, the second pass would miss leading citations and a
    // cited key would wrongly surface as an uncited-reference prompt.
    assert.deepEqual(second.payload, first.payload);
    assert.deepEqual(uncitedKeys(second.payload), EXPECTED_UNCITED_KEYS);
  });

  it('stays correct when WRITING_PROMPTS_CITE_RE carries a stale lastIndex (per-file reset is load-bearing)', async () => {
    // The handler resets WRITING_PROMPTS_CITE_RE.lastIndex to 0 before each file's exec
    // loop. Pre-seed a large lastIndex to simulate state leaking in from a prior request,
    // then confirm the cited-key set is unaffected. Without the reset, the first file
    // walked would start its scan past its own content, exec would return null at once,
    // and that file's citation would silently vanish — its key would then appear as a
    // third uncited reference instead of the two truly-uncited ones.
    assert.ok(routes.WRITING_PROMPTS_CITE_RE instanceof RegExp, 'handler regex is exported for this guard');
    routes.WRITING_PROMPTS_CITE_RE.lastIndex = 100000;
    const { status, payload } = await runWritingPrompts();
    assert.equal(status, 200);
    assert.deepEqual(uncitedKeys(payload), EXPECTED_UNCITED_KEYS);
  });
});
