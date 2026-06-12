import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// research-tools.js is CommonJS; load it the way the other server tests do.
const require = createRequire(import.meta.url);
const researchTools = require('../server/routes/research-tools.js');
const { REC_ARXIV_ID_RE, REC_DOI_RE } = researchTools;

// Pure regex unit tests for the stricter paper-id matchers that extractRecPaperId
// in GET /api/recommendations uses to pull a canonical id out of a reference URL.
// No network: the patterns run directly on fixed strings. They are deliberately
// stricter than ARXIV_ABS_RE (the track* handlers' matcher); in particular
// REC_ARXIV_ID_RE keeps the version suffix that ARXIV_ABS_RE drops.
describe('REC_ARXIV_ID_RE', () => {
  it('is exported as a non-global RegExp', () => {
    assert.ok(REC_ARXIV_ID_RE instanceof RegExp);
    assert.equal(REC_ARXIV_ID_RE.global, false);
  });

  it('extracts the arXiv id from an abstract URL (capture group 1)', () => {
    const m = 'https://arxiv.org/abs/2301.12345'.match(REC_ARXIV_ID_RE);
    assert.ok(m);
    assert.equal(m[1], '2301.12345');
  });

  it('keeps the version suffix, unlike the suffix-dropping ARXIV_ABS_RE', () => {
    const m = 'https://arxiv.org/abs/2301.12345v2'.match(REC_ARXIV_ID_RE);
    assert.ok(m);
    assert.equal(m[1], '2301.12345v2');
  });

  it('returns null for a non-arXiv URL', () => {
    assert.equal('https://example.com/abs/2301.12345'.match(REC_ARXIV_ID_RE), null);
  });
});

describe('REC_DOI_RE', () => {
  it('is exported as a non-global RegExp', () => {
    assert.ok(REC_DOI_RE instanceof RegExp);
    assert.equal(REC_DOI_RE.global, false);
  });

  it('extracts the DOI from a doi.org URL (capture group 1)', () => {
    const m = 'https://doi.org/10.1234/abcd'.match(REC_DOI_RE);
    assert.ok(m);
    assert.equal(m[1], '10.1234/abcd');
  });

  it('returns null for a non-DOI URL', () => {
    assert.equal('https://arxiv.org/abs/2301.12345'.match(REC_DOI_RE), null);
  });
});
