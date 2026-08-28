import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-c.js');
const { TEMPLATE_VAR_NAME_RE } = routes;

// Drive POST /api/template-variables with a mocked ctx and capture the json()
// response. The handler only touches rateLimit, readBody, the proto-key guard,
// TEMPLATE_VAR_NAME_RE, then path/PROJECT_ROOT/loadJSON/saveJSON/sanitizeText on
// the accept path, so the stub supplies just those. `saved` records what would be
// persisted so the accept path can be asserted without real disk writes.
const PROJECT_ROOT = '/fake/root';
async function postVar({ name, value = '' }) {
  let captured = null;
  let saved = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    rateLimit: () => true,
    readBody: async () => ({ name, value }),
    loadJSON: () => ({}),
    saveJSON: (_fp, data) => { saved = data; },
    sanitizeText: (s) => s,
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const url = new URL('http://localhost/api/template-variables');
  await routes(req, res, url, '/api/template-variables', ctx);
  return { captured, saved };
}

describe('TEMPLATE_VAR_NAME_RE (hoisted to module scope in content-analysis-c.js)', () => {
  it('is a stateless, non-global, non-sticky RegExp whose source/flags match the original', () => {
    assert.ok(TEMPLATE_VAR_NAME_RE instanceof RegExp, 'TEMPLATE_VAR_NAME_RE should be a RegExp');
    // No /g and no /y, so it carries no lastIndex between requests.
    assert.equal(TEMPLATE_VAR_NAME_RE.global, false);
    assert.equal(TEMPLATE_VAR_NAME_RE.sticky, false);
    // Pattern and flags must match the original inline literal verbatim. Compare
    // against a fresh literal of the canonical pattern so a widened/narrowed hoist
    // is caught.
    const CANONICAL = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
    assert.equal(TEMPLATE_VAR_NAME_RE.source, CANONICAL.source);
    assert.equal(TEMPLATE_VAR_NAME_RE.flags, CANONICAL.flags);
    assert.equal(TEMPLATE_VAR_NAME_RE.flags, '');
  });

  it('is referentially stable across two requires (single shared instance)', () => {
    const a = require('../../../../../src/server/routes/content-analysis-c.js').TEMPLATE_VAR_NAME_RE;
    const b = require('../../../../../src/server/routes/content-analysis-c.js').TEMPLATE_VAR_NAME_RE;
    assert.strictEqual(a, b);
  });

  it('accepts valid names (leading letter or underscore, then letters/digits/underscore/hyphen)', () => {
    for (const name of ['foo', '_bar', 'f', '_', 'myVar1', 'a-b-c', 'A_1-2', 'CONST_NAME']) {
      assert.equal(TEMPLATE_VAR_NAME_RE.test(name), true, `expected ${JSON.stringify(name)} to be accepted`);
    }
  });

  it('rejects invalid names (leading digit, leading hyphen, spaces, dots, other punctuation)', () => {
    for (const name of ['1abc', '-x', 'foo bar', 'foo.bar', 'foo$', 'a/b', 'café', '']) {
      assert.equal(TEMPLATE_VAR_NAME_RE.test(name), false, `expected ${JSON.stringify(name)} to be rejected`);
    }
  });

  it('rejects an invalid name at the call site with the unchanged 400 message (no disk write)', async () => {
    const { captured, saved } = await postVar({ name: '1bad', value: 'v' });
    assert.equal(captured.status, 400);
    assert.equal(captured.body.error, 'Variable name must be alphanumeric (with underscores/hyphens)');
    assert.equal(saved, null, 'a rejected name must not reach saveJSON');
  });

  it('accepts a valid name at the call site and persists it (200 success)', async () => {
    const { captured, saved } = await postVar({ name: 'good_name-1', value: 'hello' });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true, name: 'good_name-1', value: 'hello' });
    assert.deepEqual(saved, { variables: { 'good_name-1': 'hello' } });
  });
});
