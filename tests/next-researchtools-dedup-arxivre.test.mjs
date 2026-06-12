import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// research-tools.js is CommonJS; load it the way the other server tests do.
const require = createRequire(import.meta.url);
const researchTools = require('../server/routes/research-tools.js');
const { ARXIV_ABS_RE } = researchTools;

// Pure regex unit tests for the shared arXiv abstract-URL id matcher that the
// three /api/references/track* handlers use to pull an arXiv id out of a
// reference URL. No network: the regex runs directly on fixed strings.
describe('ARXIV_ABS_RE', () => {
  it('is exported as a RegExp on module.exports', () => {
    assert.ok(ARXIV_ABS_RE instanceof RegExp);
  });

  it('is non-global so the shared instance holds no lastIndex state', () => {
    // The handlers share one module-scope instance and only ever call
    // String.prototype.match, so the pattern must not carry the global flag.
    assert.equal(ARXIV_ABS_RE.global, false);
  });

  it('extracts the id from an arXiv abstract URL (capture group 1)', () => {
    const m = 'https://arxiv.org/abs/2301.12345'.match(ARXIV_ABS_RE);
    assert.ok(m);
    assert.equal(m[1], '2301.12345');
  });

  it('captures up to the version suffix, stopping at the first non-id char', () => {
    // `[\d.]+` consumes digits and dots, so a trailing `v2` is left out of the id.
    const m = 'https://arxiv.org/abs/2301.12345v2'.match(ARXIV_ABS_RE);
    assert.ok(m);
    assert.equal(m[1], '2301.12345');
  });

  it('returns null for a non-arXiv URL', () => {
    assert.equal('https://example.com/paper/2301.12345'.match(ARXIV_ABS_RE), null);
    assert.equal('https://doi.org/10.1234/abcd'.match(ARXIV_ABS_RE), null);
  });
});
